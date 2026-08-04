import {
  BadGatewayException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import axios from 'axios';
import moment from 'moment';
import { parseStringPromise } from 'xml2js';
import { isSchedulingEnabled } from 'src/common/scheduling.util';
import { BROWSER_UA, KEYWORDS } from '../yna-feed.service';
import { ArchiveIngestService } from './archive-ingest.service';
import {
  ArchiveCollectOptions,
  ArchiveIngestSummary,
  ArchiveItem,
  sleep,
  sanitizeXmlAmp,
  stripHighlightSpans,
  stripTags,
  toArray,
  withRetry,
  xmlNodeText,
} from './archive.types';

const CRON_ID = 'archive-ntis-collect';
const CRON_TIME = '0 0 3 * * *'; // 매일 03:00 KST (KCI 01:00, RISS 06:00와 시차)

/**
 * NTIS 국가R&D 연구보고서 검색 서비스(전체용) 수집기.
 * rndopen/openApi/rresearchpdf 를 키워드별 페이징(startPosition/displayCount) 조회해
 * 공통 파이프라인으로 넘긴다. 발행기관이 대부분 정부·국책기관이라 PUBLICATIONS 비중이 높다.
 *
 * 주의:
 * - NTIS는 활용신청 시 등록한 IP에서만 호출 가능 — 로컬 개발기에선
 *   '<error>접근 허용 IP가 아닙니다.</error>' 가 정상이며, 운영(EC2)에서 동작한다.
 * - 응답 텍스트에 검색어 하이라이트(<span class="search_word">)가 섞여 있어 반드시 제거한다.
 */
@Injectable()
export class NtisCollectorService implements OnModuleInit {
  private readonly logger = new Logger(NtisCollectorService.name);
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly ingestService: ArchiveIngestService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (!isSchedulingEnabled(this.configService)) {
      this.logger.warn(
        '[ntis] ⏸️ 전역 스케줄링 비활성화 — 정기 수집 크론 미등록.',
      );
      return;
    }
    if (this.schedulerRegistry.getCronJobs().has(CRON_ID)) {
      this.schedulerRegistry.getCronJob(CRON_ID).stop();
      this.schedulerRegistry.deleteCronJob(CRON_ID);
    }
    const job = new CronJob(
      CRON_TIME,
      async () => {
        try {
          // 크론은 증분(날짜필터) + 페이지 상한으로 가볍게 — 놓친 분량은 다음 회차/수동 백필이 커버
          const maxPages =
            Number(this.configService.get('ARCHIVE_CRON_MAX_PAGES')) || 1;
          await this.collect({
            translate: true,
            dryRun: false,
            incremental: true,
            maxPages,
          });
        } catch (e) {
          this.logger.error(`[ntis] 정기 수집 실패: ${(e as Error).message}`);
        }
      },
      null,
      false,
      'Asia/Seoul',
    );
    this.schedulerRegistry.addCronJob(CRON_ID, job);
    job.start();
    this.logger.log(`[ntis] 정기 수집 크론 등록 완료 (${CRON_TIME})`);
  }

  async collect(
    opts: ArchiveCollectOptions,
  ): Promise<ArchiveIngestSummary | { skipped: true; reason: string }> {
    if (this.running) {
      this.logger.warn('[ntis] 이전 수집이 아직 실행 중 → 이번 회차 스킵');
      return { skipped: true, reason: 'already running' };
    }
    this.running = true;

    const apiUrl = this.configService.get<string>('NTIS_API_URL');
    const apiKey = this.configService.get<string>('NTIS_API_KEY');
    const originId = Number(this.configService.get('NTIS_ORIGIN_ID'));
    if (!apiUrl || !apiKey || !Number.isFinite(originId) || originId <= 0) {
      this.running = false;
      this.logger.warn(
        '[ntis] NTIS_API_URL / NTIS_API_KEY / NTIS_ORIGIN_ID 미설정 → 수집 생략',
      );
      return { skipped: true, reason: 'env not configured' };
    }

    const delayMs =
      Number(this.configService.get('ARCHIVE_API_DELAY_MS')) || 1000;
    const pageSize =
      opts.pageSize ??
      Number(this.configService.get('ARCHIVE_PAGE_SIZE')) ??
      100;
    const keywords = opts.keyword ? [opts.keyword] : [...KEYWORDS];
    // 증분(크론) 모드: 발행년도 작년 이상으로 좁힌다 — 겹침은 S3 완료 마커가 거름
    const addQuery = opts.incremental
      ? `PY=${moment().subtract(1, 'year').format('YYYY')}/MORE`
      : undefined;

    this.logger.log(
      `[ntis] 수집 시작 — keyword=${opts.keyword ?? '전체(14개)'} maxPages=${opts.maxPages ?? '무제한'} ` +
        `dryRun=${!!opts.dryRun} incremental=${!!opts.incremental}`,
    );

    try {
      const items: ArchiveItem[] = [];
      // 키워드 단위 실패 격리 — 단, IP 미등록 오류는 모든 키워드가 똑같이 실패하므로 즉시 중단
      const failedFetches: string[] = [];
      for (const keyword of keywords) {
        try {
          const fetched = await this.fetchByKeyword(
            apiUrl,
            apiKey,
            keyword,
            pageSize,
            opts.maxPages,
            addQuery,
            delayMs,
          );
          items.push(...fetched);
        } catch (e) {
          const message = (e as Error).message;
          failedFetches.push(`"${keyword}": ${message}`);
          if (message.includes('IP')) {
            this.logger.error(
              `[ntis] IP 미등록 오류 — 나머지 키워드 수집 중단: ${message}`,
            );
            break;
          }
          this.logger.error(
            `[ntis] "${keyword}" 조회 실패(재시도 소진) → 다음 키워드 계속: ${message}`,
          );
        }
        await sleep(delayMs);
      }
      if (failedFetches.length) {
        this.logger.warn(
          `[ntis] 키워드 조회 실패 ${failedFetches.length}건 — 수집된 ${items.length}건은 정상 저장 진행` +
            ` (실패분은 재실행 시 이어서 수집): ${failedFetches.join(' / ')}`,
        );
      }
      const summary = await this.ingestService.ingest(
        originId,
        items,
        opts,
        'ntis',
      );
      // 키워드 조회 실패도 HTTP 응답에서 보이게 — 로그 없이 "0건 성공"으로 오해하지 않도록
      if (failedFetches.length) {
        summary.errors.unshift(
          ...failedFetches.map((message) => ({
            sourceId: '(keyword-fetch)',
            message,
          })),
        );
      }
      return summary;
    } catch (e) {
      this.logger.error(`[ntis] 수집 실패: ${(e as Error).message}`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  // ─── 조회/파싱 ─────────────────────────────────────────────────────────────

  private async fetchByKeyword(
    apiUrl: string,
    apiKey: string,
    keyword: string,
    pageSize: number,
    maxPages: number | undefined,
    addQuery: string | undefined,
    delayMs: number,
  ): Promise<ArchiveItem[]> {
    const items: ArchiveItem[] = [];
    let startPosition = 1; // 1-base index
    let page = 1;
    let total = Infinity;

    while (startPosition <= total && (!maxPages || page <= maxPages)) {
      // 타임아웃·일시 오류는 재시도 (IP 미등록 등 API 오류 응답은 파싱 단계라 재시도 안 탐)
      const res = await withRetry(
        () =>
          axios.get(apiUrl, {
            params: {
              apprvKey: apiKey,
              collection: 'rresearchpdf',
              query: keyword,
              searchField: 'BI',
              sortBy: 'DATE/DESC',
              startPosition,
              displayCount: pageSize,
              returnType: 'xml',
              ...(addQuery ? { addQuery } : {}),
            },
            // axios 기본 Accept(application/json)를 보내면 NTIS가 JSON으로 응답해버린다 — XML 고정
            headers: {
              'User-Agent': BROWSER_UA,
              Accept: 'application/xml, text/xml, */*',
            },
            timeout: 30000,
            responseType: 'text',
          }),
        (attempt, error, delay) =>
          this.logger.warn(
            `[ntis] "${keyword}" startPosition=${startPosition} 요청 실패(${attempt}회차) → ${delay}ms 후 재시도: ${error.message}`,
          ),
        3,
        5000,
      );

      // NTIS 본문에는 ①'국가R&D'처럼 이스케이프 안 된 &, ②검색어 하이라이트 <span> raw XML이 섞여 온다.
      // &는 &amp;로 치환, 하이라이트 span은 파싱 전에 제거(안 그러면 텍스트 노드가 객체가 돼 "[object Object]").
      const xml = stripHighlightSpans(sanitizeXmlAmp(res.data));

      let parsed: any;
      try {
        parsed = await parseStringPromise(xml, { explicitArray: false });
      } catch (e) {
        throw new BadGatewayException(
          `NTIS 응답 XML 파싱 실패 (${(e as Error).message.split('\n')[0]}): ${xml.slice(0, 200)}`,
        );
      }

      // IP 미등록·키 오류 등은 <error> 또는 RESULT.resMsg 로 온다
      // BadGatewayException을 쓰면 HttpExceptionFilter가 원인 메시지를 응답에 그대로 실어준다
      if (parsed?.error) {
        throw new BadGatewayException(
          `NTIS 오류 응답: ${parsed.error} (등록된 IP에서만 호출 가능 — 운영 서버에서 실행하세요)`,
        );
      }
      const result = parsed?.RESULT;
      if (!result) {
        throw new BadGatewayException(
          `NTIS 응답 형식 오류: ${String(res.data).slice(0, 200)}`,
        );
      }
      if (result.resMsg)
        throw new BadGatewayException(`NTIS 오류 응답: ${result.resMsg}`);

      total = Number(result.TOTALHITS ?? 0);
      const hits = toArray<any>(result.RESULTSET?.HIT);
      for (const hit of hits) {
        const item = this.toArchiveItem(hit, keyword);
        if (item) items.push(item);
      }

      this.logger.log(
        `[ntis] "${keyword}" startPosition=${startPosition} → ${hits.length}건 (전체 ${total}건)`,
      );
      startPosition += pageSize;
      page++;
      if (startPosition <= total) await sleep(delayMs);
    }
    return items;
  }

  /** NTIS HIT → 정규화 ArchiveItem. 하이라이트 태그(<span class="search_word">)는 모두 제거 */
  private toArchiveItem(hit: any, matchedKeyword: string): ArchiveItem | null {
    const title = stripTags(this.lang(hit?.ResultTitle, 'Korean'));
    if (!title) return null;

    // 보고서등록번호(TRKO…)가 안정 식별자 — 없으면 성과번호(TermSn) 폴백
    const sourceId = stripTags(hit?.ResearchPublicNo) || stripTags(hit?.TermSn);
    if (!sourceId) return null;

    // 발행년도: PublicationYear(YYYY) 또는 PublicationYm(YYYYMM)
    const rawYear =
      stripTags(hit?.PublicationYear) || stripTags(hit?.PublicationYm);
    const yearMatch = rawYear.match(/^\d{4}/);

    const keywordKo = stripTags(this.lang(hit?.Keyword, 'Korean'))
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');

    return {
      source: 'ntis',
      sourceId,
      title,
      publisher: stripTags(hit?.PublicationAgency),
      author: stripTags(hit?.Manager) || stripTags(hit?.ManagerName), // 과제 연구책임자
      publishYear: yearMatch ? yearMatch[0] : '',
      category: '연구보고서', // RISS와 동일 규칙 — category=자료유형 라벨
      subCategory: keywordKo || null,
      summary: stripTags(this.lang(hit?.Abstract, 'Korean')) || null,
      detailUrl: stripTags(hit?.DocUrl) || null,
      isbn: null,
      materialType: 'report',
      matchedKeyword,
      titleEn: stripTags(this.lang(hit?.ResultTitle, 'English')) || null,
      summaryEn: stripTags(this.lang(hit?.Abstract, 'English')) || null,
      authorEn: null,
    };
  }

  /** {Korean, English} 다국어 노드에서 특정 언어 텍스트 추출 (혼합콘텐츠 객체 방어) */
  private lang(node: any, key: 'Korean' | 'English'): string {
    if (node === undefined || node === null) return '';
    if (typeof node === 'string') return key === 'Korean' ? node : '';
    return xmlNodeText(node?.[key]);
  }
}
