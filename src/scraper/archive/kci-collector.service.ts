import { BadGatewayException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import axios from 'axios';
import moment from 'moment';
import { parseStringPromise } from 'xml2js';
import { GoogleChatService } from 'src/common/webhook/google-chat.service';
import { isSchedulingEnabled } from 'src/common/scheduling.util';
import { KEYWORDS } from '../yna-feed.service';
import { ArchiveIngestService } from './archive-ingest.service';
import {
  ArchiveCollectOptions,
  ArchiveIngestSummary,
  ArchiveItem,
  sleep,
  stripTags,
  toArray,
  withRetry,
} from './archive.types';

const CRON_ID = 'archive-kci-collect';
const CRON_TIME = '0 0 1 * * *'; // 매일 01:00 KST (NTIS 03:00, RISS 06:00와 시차)
// KCI displayCount는 10/20/50/100만 유효 — 그 외 값은 서버가 10으로 폴백한다
const ALLOWED_PAGE_SIZES = [10, 20, 50, 100];
// 크론 증분 수집 시 등록일 검색 범위 (일 단위 롤링 윈도우, S3 중복마커가 겹침을 걸러줌)
const INCREMENTAL_WINDOW_DAYS = 7;

/**
 * KCI(한국학술지인용색인) 논문 수집기.
 * openApiSearch.kci?apiCode=articleSearch 를 키워드(제목/키워드 필드)별로 페이징 조회해
 * ArchiveIngestService 공통 파이프라인(중복확인→기관분류→번역→S3 meta.json)으로 넘긴다.
 * KCI는 영문 제목/초록/저자명을 직접 제공하는 경우가 많아 번역앱 호출이 크게 줄어든다.
 */
@Injectable()
export class KciCollectorService implements OnModuleInit {
  private readonly logger = new Logger(KciCollectorService.name);
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly ingestService: ArchiveIngestService,
    private readonly googleChatService: GoogleChatService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  // 기존 스크래퍼와 동일하게 SchedulerRegistry로 동적 등록 (@Cron 데코레이터는 미발화)
  onModuleInit(): void {
    if (!isSchedulingEnabled(this.configService)) {
      this.logger.warn('[kci] ⏸️ 전역 스케줄링 비활성화 — 정기 수집 크론 미등록.');
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
          this.logger.error(`[kci] 정기 수집 실패: ${(e as Error).message}`);
        }
      },
      null,
      false,
      'Asia/Seoul',
    );
    this.schedulerRegistry.addCronJob(CRON_ID, job);
    job.start();
    this.logger.log(`[kci] 정기 수집 크론 등록 완료 (${CRON_TIME})`);
  }

  async collect(opts: ArchiveCollectOptions): Promise<ArchiveIngestSummary | { skipped: true; reason: string }> {
    if (this.running) {
      this.logger.warn('[kci] 이전 수집이 아직 실행 중 → 이번 회차 스킵');
      return { skipped: true, reason: 'already running' };
    }
    this.running = true;

    const apiUrl = this.configService.get<string>('KCI_API_URL');
    const apiKey = this.configService.get<string>('KCI_API_KEY');
    const originId = Number(this.configService.get('KCI_ORIGIN_ID'));
    if (!apiUrl || !apiKey || !Number.isFinite(originId) || originId <= 0) {
      this.running = false;
      this.logger.warn('[kci] KCI_API_URL / KCI_API_KEY / KCI_ORIGIN_ID 미설정 → 수집 생략');
      return { skipped: true, reason: 'env not configured' };
    }

    const delayMs = Number(this.configService.get('ARCHIVE_API_DELAY_MS')) || 1000;
    const pageSize = this.normalizePageSize(
      opts.pageSize ?? Number(this.configService.get('ARCHIVE_PAGE_SIZE')) ?? 100,
    );
    const keywords = opts.keyword ? [opts.keyword] : [...KEYWORDS];
    // 증분(크론) 모드: 최근 N일 등록분만 조회 — 겹치는 건 S3 완료 마커가 걸러준다
    const regDateFrom = opts.incremental
      ? moment().subtract(INCREMENTAL_WINDOW_DAYS, 'days').format('YYYYMMDD')
      : undefined;

    try {
      const items: ArchiveItem[] = [];
      // 키워드 단위 실패 격리 — 한 요청이 재시도까지 소진해도 run 전체를 죽이지 않고
      // 나머지 키워드를 계속 수집한다. 실패분은 다음 실행 때 S3 중복마커 덕에 이어서 수집됨.
      const failedFetches: string[] = [];
      for (const keyword of keywords) {
        // 제목 검색 + 키워드(주제어) 검색 두 방향 — 중복은 ingest에서 sourceId로 병합
        for (const field of ['title', 'keyword'] as const) {
          try {
            const fetched = await this.fetchByField(
              apiUrl, apiKey, keyword, field, pageSize, opts.maxPages, regDateFrom, delayMs,
            );
            items.push(...fetched);
          } catch (e) {
            failedFetches.push(`${field}="${keyword}": ${(e as Error).message}`);
            this.logger.error(
              `[kci] ${field}="${keyword}" 조회 실패(재시도 소진) → 다음 키워드 계속: ${(e as Error).message}`,
            );
          }
          await sleep(delayMs);
        }
      }
      if (failedFetches.length) {
        this.logger.warn(
          `[kci] 키워드 조회 실패 ${failedFetches.length}건 — 수집된 ${items.length}건은 정상 저장 진행` +
          ` (실패분은 재실행 시 이어서 수집): ${failedFetches.join(' / ')}`,
        );
        this.googleChatService.sendAlert('KCI 수집 일부 실패 (부분 저장은 진행)', {
          실패: failedFetches.slice(0, 10).join('\n'),
        });
      }
      return await this.ingestService.ingest(originId, items, opts);
    } catch (e) {
      this.logger.error(`[kci] 수집 실패: ${(e as Error).message}`);
      this.googleChatService.sendAlert('KCI 아카이브 수집 실패', {
        에러: (e as Error).message,
      });
      throw e;
    } finally {
      this.running = false;
    }
  }

  // ─── 조회/파싱 ─────────────────────────────────────────────────────────────

  private async fetchByField(
    apiUrl: string,
    apiKey: string,
    keyword: string,
    field: 'title' | 'keyword',
    pageSize: number,
    maxPages: number | undefined,
    regDateFrom: string | undefined,
    delayMs: number,
  ): Promise<ArchiveItem[]> {
    const items: ArchiveItem[] = [];
    let page = 1;
    let total = Infinity;

    while ((page - 1) * pageSize < total && (!maxPages || page <= maxPages)) {
      // 타임아웃·일시 오류는 재시도 — 스로틀링 회복 시간을 주기 위해 5s/10s 백오프
      const res = await withRetry(
        () =>
          axios.get(apiUrl, {
            params: {
              apiCode: 'articleSearch',
              key: apiKey,
              [field]: keyword,
              page,
              displayCount: pageSize,
              ...(regDateFrom ? { regDateFrom } : {}),
            },
            timeout: 30000,
            responseType: 'text',
          }),
        (attempt, error, delay) =>
          this.logger.warn(
            `[kci] ${field}="${keyword}" page=${page} 요청 실패(${attempt}회차) → ${delay}ms 후 재시도: ${error.message}`,
          ),
        3,
        5000,
      );

      const parsed = await parseStringPromise(res.data, { explicitArray: false });
      const output = parsed?.MetaData?.outputData;
      if (!output) {
        // 인증 오류 등은 outputData 없이 에러 메시지만 온다 (BadGateway → 필터가 메시지 노출)
        const errMsg = stripTags(res.data).slice(0, 200);
        throw new BadGatewayException(`KCI 응답에 outputData 없음: ${errMsg}`);
      }

      total = Number(output.result?.total ?? 0);
      const records = toArray<any>(output.record);
      for (const record of records) {
        const item = this.toArchiveItem(record, keyword);
        if (item) items.push(item);
      }

      this.logger.log(
        `[kci] ${field}="${keyword}" page=${page} → ${records.length}건 (전체 ${total}건)`,
      );
      page++;
      if ((page - 1) * pageSize < total) await sleep(delayMs);
    }
    return items;
  }

  /** KCI record(journalInfo + articleInfo) → 정규화 ArchiveItem */
  private toArchiveItem(record: any, matchedKeyword: string): ArchiveItem | null {
    const articleInfo = record?.articleInfo;
    const journalInfo = record?.journalInfo;
    if (!articleInfo) return null;

    const sourceId = String(articleInfo?.$?.['article-id'] ?? '').trim();
    const title = this.pickByLang(articleInfo['title-group']?.['article-title'], 'original');
    if (!sourceId || !title) return null;

    const titleEn = this.pickByLang(articleInfo['title-group']?.['article-title'], 'english');
    const abstractKo = this.pickByLang(articleInfo['abstract-group']?.abstract, 'original');
    const abstractEn = this.pickByLang(articleInfo['abstract-group']?.abstract, 'english');
    const { author, authorEn } = this.parseAuthors(articleInfo['author-group']?.author);

    const journalName = String(journalInfo?.['journal-name'] ?? '').trim();
    const volume = String(journalInfo?.volume ?? '').trim();
    const issue = String(journalInfo?.issue ?? '').trim();
    const subCategory = journalName
      ? `${journalName}${volume ? ` ${volume}${issue ? `(${issue})` : ''}` : ''}`
      : null;

    return {
      source: 'kci',
      sourceId,
      title,
      publisher: String(journalInfo?.['publisher-name'] ?? '').trim(),
      author,
      publishYear: String(journalInfo?.['pub-year'] ?? '').trim(),
      category: String(articleInfo?.['article-categories'] ?? '').trim() || null,
      subCategory,
      summary: abstractKo || null,
      detailUrl: String(articleInfo?.url ?? '').trim() || null,
      isbn: null,
      materialType: 'article',
      matchedKeyword,
      titleEn: titleEn || null,
      summaryEn: abstractEn || null,
      authorEn: authorEn || null,
    };
  }

  /** {_: 텍스트, $:{lang}} 배열/단일에서 특정 lang의 텍스트 추출 */
  private pickByLang(node: any, lang: 'original' | 'english'): string {
    for (const entry of toArray<any>(node)) {
      const entryLang = entry?.$?.lang;
      const text = typeof entry === 'string' ? entry : entry?._;
      if (entryLang === lang && String(text ?? '').trim()) {
        return String(text).trim();
      }
    }
    return '';
  }

  /** author 원문 '고하정(경희대학교)' → 소속 괄호 제거, english 속성으로 영문명 수집 */
  private parseAuthors(node: any): { author: string; authorEn: string } {
    const names: string[] = [];
    const englishNames: string[] = [];
    for (const entry of toArray<any>(node)) {
      const raw = String(typeof entry === 'string' ? entry : entry?._ ?? '').trim();
      if (raw) names.push(raw.replace(/\([^)]*\)\s*$/, '').trim());
      const en = String(entry?.$?.english ?? '').trim();
      if (en) englishNames.push(en);
    }
    return { author: names.join(', '), authorEn: englishNames.join(', ') };
  }

  private normalizePageSize(size: number): number {
    if (ALLOWED_PAGE_SIZES.includes(size)) return size;
    // 유효하지 않으면 가장 가까운 허용값 (기본 100)
    return ALLOWED_PAGE_SIZES.reduce(
      (best, cur) => (Math.abs(cur - size) < Math.abs(best - size) ? cur : best),
      100,
    );
  }
}
