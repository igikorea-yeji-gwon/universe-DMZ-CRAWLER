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
import { isSchedulingEnabled } from 'src/common/scheduling.util';
import { BROWSER_UA, KEYWORDS } from '../yna-feed.service';
import { ArchiveIngestService } from './archive-ingest.service';
import {
  ArchiveCollectOptions,
  ArchiveIngestSummary,
  ArchiveItem,
  ArchiveMaterialType,
  decodeHtmlEntities,
  sleep,
} from './archive.types';

const CRON_ID = 'archive-losi-collect';
const CRON_TIME = '0 0 4 * * *'; // 매일 04:00 KST (KCI 01:00 / NTIS 03:00 / RISS 06:00 / KISTI 05:00와 시차)

/** 수집 대상 자료구분(searchRange) → materialType. RISS의 A/T/U 루프와 동일한 구조 */
const LOSI_RANGES: {
  range: 'ARTICLE' | 'THESIS' | 'BOOK';
  materialType: ArchiveMaterialType;
}[] = [
  { range: 'ARTICLE', materialType: 'article' },
  { range: 'THESIS', materialType: 'thesis' },
  { range: 'BOOK', materialType: 'book' },
];

/**
 * 국회도서관 LOSI(국가학술정보) 수집기.
 * losi-api.nanet.go.kr/searchTotal 을 자료구분(ARTICLE/THESIS/BOOK)×키워드로 페이징 조회한다.
 * 기존 3개(GET+XML)와 달리 **POST + form-urlencoded + JSON 응답**이라 파싱 경로가 다르다.
 * - 인증: authKey(파라미터). 페이징: pageNo/printRowCnt. 전체건수: result[0].totalCount.
 * - 초록·ISBN·영문은 목록 API에 없음(상세보기 searchView는 별도 신청 필요) → summary/isbn/_en=null,
 *   category(주제)는 RISS처럼 수집 후 ThemeClassifier가 태깅.
 * - 저자는 국문+로마자가 섞여 오므로 국문(한글 포함)만 author로 취한다.
 */
@Injectable()
export class LosiCollectorService implements OnModuleInit {
  private readonly logger = new Logger(LosiCollectorService.name);
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly ingestService: ArchiveIngestService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (!isSchedulingEnabled(this.configService)) {
      this.logger.warn(
        '[losi] ⏸️ 전역 스케줄링 비활성화 — 정기 수집 크론 미등록.',
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
          const maxPages =
            Number(this.configService.get('ARCHIVE_CRON_MAX_PAGES')) || 1;
          await this.collect({
            translate: true,
            dryRun: false,
            incremental: true,
            maxPages,
          });
        } catch (e) {
          this.logger.error(`[losi] 정기 수집 실패: ${(e as Error).message}`);
        }
      },
      null,
      false,
      'Asia/Seoul',
    );
    this.schedulerRegistry.addCronJob(CRON_ID, job);
    job.start();
    this.logger.log(`[losi] 정기 수집 크론 등록 완료 (${CRON_TIME})`);
  }

  async collect(
    opts: ArchiveCollectOptions,
  ): Promise<ArchiveIngestSummary | { skipped: true; reason: string }> {
    if (this.running) {
      this.logger.warn('[losi] 이전 수집이 아직 실행 중 → 이번 회차 스킵');
      return { skipped: true, reason: 'already running' };
    }
    this.running = true;

    const apiUrl = this.configService.get<string>('LOSI_API_URL');
    const apiKey = this.configService.get<string>('LOSI_API_KEY');
    const originId = Number(this.configService.get('LOSI_ORIGIN_ID'));
    if (!apiUrl || !apiKey || !Number.isFinite(originId) || originId <= 0) {
      this.running = false;
      this.logger.warn(
        '[losi] LOSI_API_URL / LOSI_API_KEY / LOSI_ORIGIN_ID 미설정 → 수집 생략',
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
    // 증분(크론): LOSI는 등록일 필터가 없어 발행년(올해~) startYear로 좁힌다 — 겹침은 S3 마커가 거름
    const startYear = opts.incremental ? moment().format('YYYY') : undefined;

    this.logger.log(
      `[losi] 수집 시작 — keyword=${opts.keyword ?? '전체(14개)'} maxPages=${opts.maxPages ?? '무제한'} ` +
        `pageSize=${pageSize} dryRun=${!!opts.dryRun} incremental=${!!opts.incremental} originId=${originId}`,
    );

    try {
      const items: ArchiveItem[] = [];
      const failedFetches: string[] = [];
      for (const { range, materialType } of LOSI_RANGES) {
        for (const keyword of keywords) {
          try {
            const fetched = await this.fetchByKeyword(
              apiUrl,
              apiKey,
              range,
              materialType,
              keyword,
              pageSize,
              opts.maxPages,
              startYear,
              delayMs,
            );
            items.push(...fetched);
          } catch (e) {
            failedFetches.push(
              `range=${range} "${keyword}": ${(e as Error).message}`,
            );
            this.logger.error(
              `[losi] range=${range} "${keyword}" 조회 실패(재시도 소진) → 다음 키워드 계속: ${(e as Error).message}`,
            );
          }
          await sleep(delayMs);
        }
      }
      if (failedFetches.length) {
        this.logger.warn(
          `[losi] 키워드 조회 실패 ${failedFetches.length}건 — 수집된 ${items.length}건은 정상 저장 진행` +
            ` (실패분은 재실행 시 이어서 수집): ${failedFetches.join(' / ')}`,
        );
      }
      const summary = await this.ingestService.ingest(
        originId,
        items,
        opts,
        'losi',
      );
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
      this.logger.error(`[losi] 수집 실패: ${(e as Error).message}`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  // ─── 조회/파싱 ─────────────────────────────────────────────────────────────

  private async fetchByKeyword(
    apiUrl: string,
    apiKey: string,
    range: 'ARTICLE' | 'THESIS' | 'BOOK',
    materialType: ArchiveMaterialType,
    keyword: string,
    pageSize: number,
    maxPages: number | undefined,
    startYear: string | undefined,
    delayMs: number,
  ): Promise<ArchiveItem[]> {
    const items: ArchiveItem[] = [];
    let pageNo = 1;
    let total = Infinity;
    const endpoint = `${apiUrl.replace(/\/+$/, '')}/searchTotal`;

    while (
      (pageNo - 1) * pageSize < total &&
      (!maxPages || pageNo <= maxPages)
    ) {
      const body = new URLSearchParams({
        authKey: apiKey,
        searchTerm: keyword,
        searchRange: range,
        pageNo: String(pageNo),
        printRowCnt: String(pageSize),
        ...(startYear ? { startYear } : {}),
      });

      // 일시 오류·타임아웃은 5s/10s 백오프로 최대 3회 재시도
      const res = await this.postWithRetry(
        endpoint,
        body,
        range,
        keyword,
        pageNo,
      );

      // LOSI 응답: 성공 { result:[{ totalCount, searchList:[...] }] } / 오류 { result:[{ error:[{code,message}] }] } 또는 { error:[...] }
      const wrap = Array.isArray(res.data?.result)
        ? res.data.result[0]
        : (res.data?.result ?? res.data);
      const err = wrap?.error ?? res.data?.error;
      if (err) {
        const e0 = Array.isArray(err) ? err[0] : err;
        throw new BadGatewayException(
          `LOSI 오류 응답 [${e0?.code}]: ${e0?.message ?? JSON.stringify(err).slice(0, 150)}`,
        );
      }
      total = Number(wrap?.totalCount ?? 0);
      const list: any[] = Array.isArray(wrap?.searchList)
        ? wrap.searchList
        : [];
      for (const rec of list) {
        const item = this.toArchiveItem(rec, materialType, keyword);
        if (item) items.push(item);
      }

      this.logger.log(
        `[losi] range=${range} "${keyword}" page=${pageNo} → ${list.length}건 (전체 ${total}건)`,
      );

      if (list.length === 0) break; // 방어: 빈 페이지면 종료
      pageNo++;
      if ((pageNo - 1) * pageSize < total) await sleep(delayMs);
    }
    return items;
  }

  private async postWithRetry(
    endpoint: string,
    body: URLSearchParams,
    range: string,
    keyword: string,
    pageNo: number,
    attempts = 3,
    baseDelayMs = 5000,
  ) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await axios.post(endpoint, body.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': BROWSER_UA,
          },
          timeout: 30000,
        });
      } catch (e) {
        lastError = e;
        if (attempt < attempts) {
          const delay = baseDelayMs * attempt;
          this.logger.warn(
            `[losi] range=${range} "${keyword}" page=${pageNo} 요청 실패(${attempt}회차) → ${delay}ms 후 재시도: ${(e as Error).message}`,
          );
          await sleep(delay);
        }
      }
    }
    throw lastError;
  }

  /** LOSI searchList 레코드(JSON) → 정규화 ArchiveItem */
  private toArchiveItem(
    rec: any,
    materialType: ArchiveMaterialType,
    matchedKeyword: string,
  ): ArchiveItem | null {
    const title = decodeHtmlEntities(rec?.title).trim();
    const sourceId = String(rec?.lodID ?? '').trim(); // LOD 고유 id (안정적 PK)
    if (!title || !sourceId) return null;

    // authorList: 국문+로마자 혼재 → 한글 포함 이름만 author로, 없으면 전체 사용
    const names = Array.isArray(rec?.authorList)
      ? rec.authorList
          .map((a: any) => decodeHtmlEntities(a?.name).trim())
          .filter(Boolean)
      : [];
    const korNames = names.filter((n) => /[가-힣]/.test(n));
    const author = [...new Set(korNames.length ? korNames : names)].join(', ');

    // 발행년: 'YYYY'
    const yearMatch = String(rec?.pubYear ?? '').match(/\d{4}/);

    // 보조분류: 학술지명(articles) 또는 주제어 몇 개
    const journalTitle = decodeHtmlEntities(rec?.journal?.title).trim();
    const keywords = Array.isArray(rec?.keywordList)
      ? rec.keywordList
          .map((k: any) => decodeHtmlEntities(k?.name).trim())
          .filter(Boolean)
      : [];
    const subCategory =
      journalTitle ||
      (keywords.length ? keywords.slice(0, 5).join(', ') : null);

    // 초록은 목록에 대체로 비어있음(abstractCont) — 있으면 사용, 없으면 null
    const summary = String(rec?.abstractCont ?? '').trim() || null;
    const url = String(rec?.url ?? '').trim() || null;

    return {
      source: 'losi',
      sourceId,
      title,
      publisher: decodeHtmlEntities(rec?.publisher).trim(), // ARTICLE은 비어있는 경우 많음(→ 분류 기본 PRIVATE=논문)
      author,
      publishYear: yearMatch ? yearMatch[0] : '',
      category: null, // 주제분류는 수집 후 ThemeClassifier가 태깅
      subCategory,
      summary,
      detailUrl: url,
      isbn: null, // 목록 API 미제공(searchView 별도 신청 필요)
      materialType,
      matchedKeyword,
    };
  }
}
