import { BadGatewayException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import axios from 'axios';
import { createHash } from 'crypto';
import moment from 'moment';
import { parseStringPromise } from 'xml2js';
import { GoogleChatService } from 'src/common/webhook/google-chat.service';
import { isSchedulingEnabled } from 'src/common/scheduling.util';
import { BROWSER_UA, KEYWORDS } from '../yna-feed.service';
import { ArchiveIngestService } from './archive-ingest.service';
import {
  ArchiveCollectOptions,
  ArchiveIngestSummary,
  ArchiveItem,
  ArchiveMaterialType,
  sleep,
  toArray,
  withRetry,
} from './archive.types';

const CRON_ID = 'archive-riss-collect';
const CRON_TIME = '0 0 6 * * *'; // 매일 06:00 KST (KCI 01:00, NTIS 03:00와 시차)

/** 수집 대상 자료유형: A 국내학술논문 / T 학위논문 / U 단행본 (F 연구보고서는 NTIS와 중복 커서 제외) */
const RISS_TYPES: { type: string; materialType: ArchiveMaterialType }[] = [
  { type: 'A', materialType: 'article' },
  { type: 'T', materialType: 'thesis' },
  { type: 'U', materialType: 'book' },
];

/**
 * RISS(학술연구정보서비스) 수집기.
 * www.riss.kr/openApi 를 자료유형(A/T/U)×키워드로 페이징 조회(rsnum/rowcount)해
 * 공통 파이프라인으로 넘긴다. 단행본(U)은 menu_id=BOOKS 고정, ISBN이 있으면 표지 조회.
 * RISS는 초록 원문을 주지 않아(abstract는 Y/N 플래그) summary는 null로 적재된다.
 * 라이선스 CC BY-NC-ND — remark에 출처('RISS OpenAPI 수집')를 표기한다.
 */
@Injectable()
export class RissCollectorService implements OnModuleInit {
  private readonly logger = new Logger(RissCollectorService.name);
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly ingestService: ArchiveIngestService,
    private readonly googleChatService: GoogleChatService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (!isSchedulingEnabled(this.configService)) {
      this.logger.warn('[riss] ⏸️ 전역 스케줄링 비활성화 — 정기 수집 크론 미등록.');
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
          await this.collect({ translate: true, dryRun: false, incremental: true, maxPages });
        } catch (e) {
          this.logger.error(`[riss] 정기 수집 실패: ${(e as Error).message}`);
        }
      },
      null,
      false,
      'Asia/Seoul',
    );
    this.schedulerRegistry.addCronJob(CRON_ID, job);
    job.start();
    this.logger.log(`[riss] 정기 수집 크론 등록 완료 (${CRON_TIME})`);
  }

  async collect(opts: ArchiveCollectOptions): Promise<ArchiveIngestSummary | { skipped: true; reason: string }> {
    if (this.running) {
      this.logger.warn('[riss] 이전 수집이 아직 실행 중 → 이번 회차 스킵');
      return { skipped: true, reason: 'already running' };
    }
    this.running = true;

    const apiUrl = this.configService.get<string>('RISS_API_URL');
    const apiKey = this.configService.get<string>('RISS_API_KEY');
    const originId = Number(this.configService.get('RISS_ORIGIN_ID'));
    if (!apiUrl || !apiKey || !Number.isFinite(originId) || originId <= 0) {
      this.running = false;
      this.logger.warn('[riss] RISS_API_URL / RISS_API_KEY / RISS_ORIGIN_ID 미설정 → 수집 생략');
      return { skipped: true, reason: 'env not configured' };
    }

    // RISS는 대량 페이징 시 응답이 점점 느려지다 스로틀링되는 이력이 있어(백필 중 30s 무응답)
    // 요청 간격을 별도 env로 조절 가능하게 한다 (미설정 시 공통값)
    const delayMs =
      Number(this.configService.get('RISS_API_DELAY_MS')) ||
      Number(this.configService.get('ARCHIVE_API_DELAY_MS')) ||
      1000;
    const pageSize = Math.min(
      opts.pageSize ?? Number(this.configService.get('ARCHIVE_PAGE_SIZE')) ?? 100,
      100, // rowcount 최대 100
    );
    const keywords = opts.keyword ? [opts.keyword] : [...KEYWORDS];
    // 증분(크론) 모드: RISS는 등록일 필터가 없어 발행년도(올해)로 좁힌다 — 겹침은 S3 마커가 거름
    const spubdate = opts.incremental ? moment().format('YYYY') : undefined;

    try {
      const items: ArchiveItem[] = [];
      // 키워드 단위 실패 격리 — 한 요청이 재시도까지 소진해도 run 전체를 죽이지 않고
      // 나머지 키워드를 계속 수집한다. 실패분은 다음 실행 때 S3 중복마커 덕에 이어서 수집됨.
      const failedFetches: string[] = [];
      for (const { type, materialType } of RISS_TYPES) {
        for (const keyword of keywords) {
          try {
            const fetched = await this.fetchByKeyword(
              apiUrl, apiKey, type, materialType, keyword, pageSize, opts.maxPages, spubdate, delayMs,
            );
            items.push(...fetched);
          } catch (e) {
            failedFetches.push(`type=${type} "${keyword}": ${(e as Error).message}`);
            this.logger.error(
              `[riss] type=${type} "${keyword}" 조회 실패(재시도 소진) → 다음 키워드 계속: ${(e as Error).message}`,
            );
          }
          await sleep(delayMs);
        }
      }
      if (failedFetches.length) {
        this.logger.warn(
          `[riss] 키워드 조회 실패 ${failedFetches.length}건 — 수집된 ${items.length}건은 정상 저장 진행` +
          ` (실패분은 재실행 시 이어서 수집): ${failedFetches.join(' / ')}`,
        );
        this.googleChatService.sendAlert('RISS 수집 일부 실패 (부분 저장은 진행)', {
          실패: failedFetches.slice(0, 10).join('\n'),
        });
      }
      return await this.ingestService.ingest(originId, items, opts);
    } catch (e) {
      this.logger.error(`[riss] 수집 실패: ${(e as Error).message}`);
      this.googleChatService.sendAlert('RISS 아카이브 수집 실패', {
        에러: (e as Error).message,
      });
      throw e;
    } finally {
      this.running = false;
    }
  }

  // ─── 조회/파싱 ─────────────────────────────────────────────────────────────

  private async fetchByKeyword(
    apiUrl: string,
    apiKey: string,
    type: string,
    materialType: ArchiveMaterialType,
    keyword: string,
    pageSize: number,
    maxPages: number | undefined,
    spubdate: string | undefined,
    delayMs: number,
  ): Promise<ArchiveItem[]> {
    const items: ArchiveItem[] = [];
    let rsnum = 1;
    let page = 1;
    let total = Infinity;

    while (rsnum <= total && (!maxPages || page <= maxPages)) {
      // 타임아웃(stream aborted)·일시 오류는 재시도 — 스로틀링 회복 시간을 주기 위해 5s/10s 백오프
      const res = await withRetry(
        () =>
          axios.get(apiUrl, {
            params: {
              key: apiKey,
              version: '1.0',
              type,
              keyword,
              rsnum,
              rowcount: pageSize,
              ...(spubdate ? { spubdate } : {}),
            },
            headers: { 'User-Agent': BROWSER_UA },
            // 백필 중 응답이 30초를 넘겨 끊긴 이력 — 느린 응답은 기다리는 편이 재시도보다 싸다
            timeout: 60000,
            responseType: 'text',
            maxRedirects: 3,
          }),
        (attempt, error, delay) =>
          this.logger.warn(
            `[riss] type=${type} "${keyword}" rsnum=${rsnum} 요청 실패(${attempt}회차) → ${delay}ms 후 재시도: ${error.message}`,
          ),
        3,
        5000,
      );

      const parsed = await parseStringPromise(res.data, { explicitArray: false });
      const head = parsed?.record?.head;
      if (!head) {
        // BadGateway → HttpExceptionFilter가 원인 메시지를 응답에 그대로 실어준다
        throw new BadGatewayException(`RISS 응답에 head 없음: ${String(res.data).slice(0, 200)}`);
      }
      if (String(head.Error ?? '0') !== '0') {
        throw new BadGatewayException(`RISS 오류 응답 [${head.Error}]: ${head.ErrorMessage ?? ''}`);
      }

      total = Number(head.totalcount ?? 0);
      const metadataList = toArray<any>(parsed.record.metadata);
      for (const metadata of metadataList) {
        const item = this.toArchiveItem(metadata, materialType, keyword);
        if (item) items.push(item);
      }

      this.logger.log(
        `[riss] type=${type} "${keyword}" rsnum=${rsnum} → ${metadataList.length}건 (전체 ${total}건)`,
      );
      rsnum += pageSize;
      page++;
      if (rsnum <= total) await sleep(delayMs);
    }
    return items;
  }

  /** RISS metadata → 정규화 ArchiveItem */
  private toArchiveItem(
    metadata: any,
    materialType: ArchiveMaterialType,
    matchedKeyword: string,
  ): ArchiveItem | null {
    const title = String(metadata?.['riss.title'] ?? '').trim();
    const url = String(metadata?.url ?? '').trim();
    if (!title || !url) return null;

    // 상세 URL(riss.kr/link?id=A109157244)의 id가 곧 제어번호 — sourceId로 사용
    const idMatch = url.match(/[?&]id=([A-Za-z0-9]+)/);
    const sourceId = idMatch
      ? idMatch[1]
      : createHash('md5').update(url).digest('hex').slice(0, 12);

    // 수록지명 + 권(호) — 단행본은 대체로 없음
    const stitle = String(metadata?.['riss.stitle'] ?? '').trim();
    const vol = String(metadata?.['riss.vol'] ?? '').trim();
    const no = String(metadata?.['riss.no'] ?? '').trim();
    const volLabel = vol && vol !== '0' && vol !== '-' ? ` ${vol}${no && no !== '0' && no !== '-' ? `(${no})` : ''}` : '';
    const subCategory = stitle ? `${stitle}${volLabel}` : null;

    // 저자 '길희영|정재상|…' → ', ' join
    const author = String(metadata?.['riss.author'] ?? '')
      .split('|')
      .map((name) => name.trim())
      .filter(Boolean)
      .join(', ');

    // pubdate는 '2020' 또는 '2020.02' 형태 — 연도만
    const pubdate = String(metadata?.['riss.pubdate'] ?? '').trim();
    const yearMatch = pubdate.match(/^\d{4}/);

    return {
      source: 'riss',
      sourceId,
      title,
      publisher: String(metadata?.['riss.publisher'] ?? '').trim(),
      author,
      publishYear: yearMatch ? yearMatch[0] : '',
      category: null, // RISS는 주제분류 미제공 — 적재 시 기본값('접경지역')은 스프링 몫
      subCategory,
      summary: null, // 초록 원문 미제공 (riss.abstract는 Y/N 플래그)
      detailUrl: url,
      isbn: String(metadata?.['riss.isbn'] ?? '').trim() || null,
      materialType,
      matchedKeyword,
    };
  }
}
