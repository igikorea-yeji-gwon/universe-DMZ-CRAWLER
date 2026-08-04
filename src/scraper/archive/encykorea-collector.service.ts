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
import { isSchedulingEnabled } from 'src/common/scheduling.util';
import { BROWSER_UA, KEYWORDS } from '../yna-feed.service';
import { ArchiveIngestService } from './archive-ingest.service';
import {
  ArchiveCollectOptions,
  ArchiveIngestSummary,
  ArchiveItem,
  decodeHtmlEntities,
  sleep,
  stripTags,
  withRetry,
} from './archive.types';

const CRON_ID = 'archive-encykorea-collect';
const CRON_TIME = '0 0 2 * * *'; // 매일 02:00 KST (KCI 01:00 / NTIS 03:00 / LOSI 04:00 / KISTI 05:00 / RISS 06:00와 시차)
const PUBLISHER = '한국학중앙연구원';
const DETAIL_ORIGIN = 'https://encykorea.aks.ac.kr';

/**
 * 한국민족문화대백과사전(EncyKorea) 수집기.
 * devin.aks.ac.kr:8080/api/articles/search 를 키워드로 페이징 조회하고, 필요 시 /articles/{eid}
 * 상세 응답을 보강해 백과 항목을 ArchiveItem으로 정규화한다.
 *
 * - 인증: 헤더 X-API-Key. 미설정/오류 시 수집 생략 또는 BadGatewayException.
 * - 자료 성격: 백과사전 항목이라 독립 발간물이 아니지만, 현 자료마당 모델에는 임시로 article로 넣는다.
 *   발행기관은 한국학중앙연구원(GOV 사전 등재)이므로 기존 규칙상 PUBLICATIONS로 분류된다.
 * - API 성공 응답 스키마가 공식 문서에 없어서 필드명은 방어적으로 읽는다. 실키 probe 후 별칭 보강 가능.
 */
@Injectable()
export class EncykoreaCollectorService implements OnModuleInit {
  private readonly logger = new Logger(EncykoreaCollectorService.name);
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly ingestService: ArchiveIngestService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (!isSchedulingEnabled(this.configService)) {
      this.logger.warn(
        '[encykorea] 전역 스케줄링 비활성화 — 정기 수집 크론 미등록.',
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
          this.logger.error(
            `[encykorea] 정기 수집 실패: ${(e as Error).message}`,
          );
        }
      },
      null,
      false,
      'Asia/Seoul',
    );
    this.schedulerRegistry.addCronJob(CRON_ID, job);
    job.start();
    this.logger.log(`[encykorea] 정기 수집 크론 등록 완료 (${CRON_TIME})`);
  }

  async collect(
    opts: ArchiveCollectOptions,
  ): Promise<ArchiveIngestSummary | { skipped: true; reason: string }> {
    if (this.running) {
      this.logger.warn('[encykorea] 이전 수집이 아직 실행 중 → 이번 회차 스킵');
      return { skipped: true, reason: 'already running' };
    }
    this.running = true;

    const apiUrl = this.configService.get<string>('ENCYKOREA_API_URL');
    const apiKey = this.configService.get<string>('ENCYKOREA_API_KEY');
    const originId = Number(this.configService.get('ENCYKOREA_ORIGIN_ID'));
    if (!apiUrl || !apiKey || !Number.isFinite(originId) || originId <= 0) {
      this.running = false;
      this.logger.warn(
        '[encykorea] ENCYKOREA_API_URL / ENCYKOREA_API_KEY / ENCYKOREA_ORIGIN_ID 미설정 → 수집 생략',
      );
      return { skipped: true, reason: 'env not configured' };
    }

    const delayMs =
      Number(this.configService.get('ENCYKOREA_API_DELAY_MS')) ||
      Number(this.configService.get('ARCHIVE_API_DELAY_MS')) ||
      1000;
    const pageSize =
      opts.pageSize ??
      Number(this.configService.get('ARCHIVE_PAGE_SIZE')) ??
      100;
    const keywords = opts.keyword ? [opts.keyword] : [...KEYWORDS];
    const fetchDetails =
      this.configService.get<string>('ENCYKOREA_FETCH_DETAILS') !== 'false';

    this.logger.log(
      `[encykorea] 수집 시작 — keyword=${opts.keyword ?? '전체(14개)'} maxPages=${opts.maxPages ?? '무제한'} ` +
        `pageSize=${pageSize} dryRun=${!!opts.dryRun} incremental=${!!opts.incremental} ` +
        `fetchDetails=${fetchDetails} originId=${originId}`,
    );

    try {
      const items: ArchiveItem[] = [];
      const failedFetches: string[] = [];
      for (const keyword of keywords) {
        try {
          const fetched = await this.fetchByKeyword(
            apiUrl,
            apiKey,
            keyword,
            pageSize,
            opts.maxPages,
            delayMs,
            fetchDetails,
          );
          items.push(...fetched);
        } catch (e) {
          failedFetches.push(`"${keyword}": ${(e as Error).message}`);
          this.logger.error(
            `[encykorea] "${keyword}" 조회 실패(재시도 소진) → 다음 키워드 계속: ${(e as Error).message}`,
          );
        }
        await sleep(delayMs);
      }

      if (failedFetches.length) {
        this.logger.warn(
          `[encykorea] 키워드 조회 실패 ${failedFetches.length}건 — 수집된 ${items.length}건은 정상 저장 진행: ${failedFetches.join(' / ')}`,
        );
      }
      const summary = await this.ingestService.ingest(
        originId,
        items,
        opts,
        'encykorea',
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
      this.logger.error(`[encykorea] 수집 실패: ${(e as Error).message}`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async fetchByKeyword(
    apiUrl: string,
    apiKey: string,
    keyword: string,
    pageSize: number,
    maxPages: number | undefined,
    delayMs: number,
    fetchDetails: boolean,
  ): Promise<ArchiveItem[]> {
    const items: ArchiveItem[] = [];
    let page = 1;
    let total: number | undefined;
    const base = apiUrl.replace(/\/+$/, '');
    const endpoint = `${base}/articles/search`;

    while (!maxPages || page <= maxPages) {
      const data = await this.getJsonWithRetry(
        endpoint,
        apiKey,
        { q: keyword, p: page, ps: pageSize },
        keyword,
        page,
      );
      const payload = this.unwrapPayload(data);
      const records = this.extractRecords(payload);
      total = this.extractTotal(payload) ?? total;

      for (const rec of records) {
        let merged = rec;
        const eid = this.extractEid(rec);
        const preliminary = this.toArchiveItem(rec, keyword);
        if (fetchDetails && eid && this.needsDetail(preliminary, rec)) {
          try {
            const detail = await this.fetchDetail(
              base,
              apiKey,
              eid,
              keyword,
              delayMs,
            );
            if (detail) merged = this.mergeRecords(rec, detail);
          } catch (e) {
            this.logger.warn(
              `[encykorea] 상세 보강 실패(목록 데이터로 계속) eid=${eid}: ${(e as Error).message}`,
            );
          }
        }
        const item = this.toArchiveItem(merged, keyword);
        if (item) items.push(item);
      }

      this.logger.log(
        `[encykorea] "${keyword}" page=${page} → ${records.length}건` +
          (total !== undefined ? ` (전체 ${total}건)` : ''),
      );

      if (records.length === 0) break;
      if (total !== undefined && page * pageSize >= total) break;
      if (total === undefined && records.length < pageSize) break;
      page++;
      await sleep(delayMs);
    }
    return items;
  }

  private async fetchDetail(
    apiBase: string,
    apiKey: string,
    eid: string,
    keyword: string,
    delayMs: number,
  ): Promise<Record<string, any> | null> {
    await sleep(Math.min(delayMs, 500));
    const data = await this.getJsonWithRetry(
      `${apiBase}/articles/${encodeURIComponent(eid)}`,
      apiKey,
      {},
      keyword,
      0,
    );
    const payload = this.unwrapPayload(data);
    return this.unwrapArticle(payload);
  }

  private async getJsonWithRetry(
    endpoint: string,
    apiKey: string,
    params: Record<string, string | number>,
    keyword: string,
    page: number,
  ): Promise<any> {
    return withRetry(
      async () => {
        try {
          const res = await axios.get(endpoint, {
            params,
            headers: {
              'X-API-Key': apiKey,
              'User-Agent': BROWSER_UA,
              Accept: 'application/json, text/plain, */*',
            },
            timeout: 30000,
            responseType: 'json',
          });
          const data =
            typeof res.data === 'string' ? safeJson(res.data) : res.data;
          if (data?.status && Number(data.status) >= 400) {
            throw new BadGatewayException(
              `EncyKorea 오류 [${data.status}]: ${data.title ?? JSON.stringify(data).slice(0, 160)}`,
            );
          }
          return data;
        } catch (e) {
          const res = (e as any)?.response;
          if (res?.data) {
            const data =
              typeof res.data === 'string' ? safeJson(res.data) : res.data;
            throw new BadGatewayException(
              `EncyKorea HTTP ${res.status}: ${data?.title ?? data?.message ?? JSON.stringify(data).slice(0, 160)}`,
            );
          }
          throw e;
        }
      },
      (attempt, error, delay) =>
        this.logger.warn(
          `[encykorea] "${keyword}" ${page ? `page=${page}` : 'detail'} 요청 실패(${attempt}회차) → ${delay}ms 후 재시도: ${error.message}`,
        ),
      3,
      5000,
    );
  }

  /** EncyKorea JSON 레코드 → 정규화 ArchiveItem */
  private toArchiveItem(rec: any, matchedKeyword: string): ArchiveItem | null {
    const sourceId = this.extractEid(rec);
    const title = this.firstText(rec, [
      'title',
      'titleKo',
      'titleKr',
      'headword',
      'entryName',
      'articleName',
      'name',
      'subject',
      'label',
      'hname',
      'term',
      '표제어',
    ]);
    if (!sourceId || !title) return null;

    const author = this.cleanAuthor(
      this.firstText(rec, [
        'writer',
        'writerName',
        'author',
        'authorName',
        'authors',
        'contributor',
        'contributors',
        '집필자',
      ]),
    );
    const summary = this.firstText(rec, [
      'summary',
      'contentSummary',
      'contentsSummary',
      'contentSummaryText',
      '요약',
      '내용요약',
      'definition',
      'abstract',
      'description',
      'desc',
      'content',
      'body',
      'text',
      'articleBody',
      'explanation',
      '정의',
    ]);
    const category = this.firstText(rec, [
      'field',
      'fieldName',
      'category',
      'categoryName',
      'mainCategory',
      'classification',
      '분야',
    ]);
    const type = this.firstText(rec, [
      'type',
      'typeName',
      'articleType',
      'kind',
      '유형',
    ]);
    const nature = this.firstText(rec, [
      'nature',
      'character',
      'property',
      '성격',
    ]);
    const subCategory = [type, nature].filter(Boolean).join(' / ') || null;
    const year = this.extractYear(
      this.firstText(rec, [
        'publishYear',
        'pubYear',
        'year',
        'writeYear',
        'createdYear',
        'lastModified',
        'modifiedDate',
        'updateDate',
        'revisionDate',
      ]),
    );
    const detailUrl =
      this.firstText(rec, ['url', 'link', 'detailUrl', 'articleUrl']) ||
      `${DETAIL_ORIGIN}/Article/${sourceId}`;

    return {
      source: 'encykorea',
      sourceId,
      title,
      publisher: PUBLISHER,
      author,
      publishYear: year,
      category: category || null,
      subCategory,
      summary: summary || null,
      detailUrl,
      isbn: null,
      materialType: 'article',
      matchedKeyword,
    };
  }

  private needsDetail(item: ArchiveItem | null, raw?: any): boolean {
    if (!item) return true;
    return (
      !this.hasContentSummary(raw) ||
      !item.author ||
      !item.category ||
      !item.publishYear
    );
  }

  private hasContentSummary(rec: any): boolean {
    return Boolean(
      this.firstText(rec, [
        'summary',
        'contentSummary',
        'contentsSummary',
        'contentSummaryText',
        '요약',
        '내용요약',
      ]),
    );
  }

  private unwrapPayload(data: any): any {
    return data?.data ?? data?.result ?? data?.response ?? data;
  }

  private unwrapArticle(data: any): Record<string, any> | null {
    if (!data) return null;
    if (Array.isArray(data)) return data[0] ?? null;
    for (const key of [
      'article',
      'item',
      'record',
      'detail',
      'content',
      'data',
      'result',
    ]) {
      const v = data?.[key];
      if (v && !Array.isArray(v) && typeof v === 'object') return v;
    }
    return typeof data === 'object' ? data : null;
  }

  private extractRecords(data: any): any[] {
    if (Array.isArray(data)) return data;
    for (const key of [
      'items',
      'articles',
      'results',
      'list',
      'rows',
      'records',
      'contents',
      'articleList',
      'searchList',
    ]) {
      const value = data?.[key];
      if (Array.isArray(value)) return value;
    }
    const firstArray = Object.values(data ?? {}).find(Array.isArray) as
      | any[]
      | undefined;
    return firstArray ?? [];
  }

  private extractTotal(data: any): number | undefined {
    const value = this.findValue(data, [
      'totalCount',
      'totalcount',
      'total',
      'count',
      'totalItems',
      'totalElements',
      'recordCount',
      '전체건수',
    ]);
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  private extractEid(rec: any): string {
    const raw = this.firstText(rec, [
      'eid',
      'EID',
      'id',
      'articleId',
      'articleID',
      'entryId',
      'sourceId',
    ]);
    const fromRaw = raw.match(/E\d{7}/i)?.[0]?.toUpperCase();
    if (fromRaw) return fromRaw;
    const url = this.firstText(rec, ['url', 'link', 'detailUrl', 'articleUrl']);
    return url.match(/\/Article\/(E\d{7})/i)?.[1]?.toUpperCase() ?? '';
  }

  private mergeRecords(
    searchRecord: any,
    detailRecord: any,
  ): Record<string, any> {
    return {
      ...(searchRecord ?? {}),
      ...(detailRecord ?? {}),
      eid: this.extractEid(detailRecord) || this.extractEid(searchRecord),
    };
  }

  private firstText(obj: any, aliases: string[]): string {
    for (const alias of aliases) {
      const value = this.findValue(obj, [alias]);
      const text = this.toText(value);
      if (text) return text;
    }
    return '';
  }

  private findValue(obj: any, aliases: string[]): any {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const alias of aliases) {
      if (obj[alias] !== undefined && obj[alias] !== null) return obj[alias];
    }
    const normalizedAliases = new Set(aliases.map(normalizeKey));
    for (const [key, value] of Object.entries(obj)) {
      if (
        normalizedAliases.has(normalizeKey(key)) &&
        value !== undefined &&
        value !== null
      )
        return value;
    }
    return undefined;
  }

  private toText(value: any): string {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value))
      return value
        .map((v) => this.toText(v))
        .filter(Boolean)
        .join(', ');
    if (typeof value === 'object') {
      for (const key of [
        'ko',
        'kor',
        'kr',
        'korean',
        'name',
        'title',
        'text',
        'content',
        'value',
        '#text',
        '_',
      ]) {
        const text = this.toText(value[key]);
        if (text) return text;
      }
      return Object.values(value)
        .map((v) => this.toText(v))
        .filter(Boolean)
        .join(' ');
    }
    return decodeHtmlEntities(stripTags(value)).replace(/\s+/g, ' ').trim();
  }

  private cleanAuthor(value: string): string {
    return value
      .split(/[,;|/]+/)
      .map((name) => name.replace(/\([^)]*\)/g, '').trim())
      .filter(Boolean)
      .join(', ');
  }

  private extractYear(value: string): string {
    return value.match(/\d{4}/)?.[0] ?? '';
  }
}

function normalizeKey(key: string): string {
  return String(key)
    .replace(/[\s_\-./]/g, '')
    .toLowerCase();
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
