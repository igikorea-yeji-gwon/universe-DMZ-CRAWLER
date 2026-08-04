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
import { createCipheriv } from 'crypto';
import { networkInterfaces } from 'os';
import moment from 'moment';
import { parseStringPromise } from 'xml2js';
import { isSchedulingEnabled } from 'src/common/scheduling.util';
import { BROWSER_UA, KEYWORDS } from '../yna-feed.service';
import { ArchiveIngestService } from './archive-ingest.service';
import {
  ArchiveCollectOptions,
  ArchiveIngestSummary,
  ArchiveItem,
  ArchiveMaterialType,
  sleep,
  stripTags,
  toArray,
} from './archive.types';

const CRON_ID = 'archive-kisti-collect';
const CRON_TIME = '0 0 5 * * *'; // 매일 05:00 KST (KCI 01:00 / NTIS 03:00 / LOSI 04:00 / RISS 06:00와 시차)

/** 수집 대상 컬렉션(target). ARTI=논문/학위/프로시딩, REPORT=연구·정책보고서 (PATENT 등은 제외) */
const KISTI_TARGETS: {
  target: 'ARTI' | 'REPORT';
  defaultType: ArchiveMaterialType;
}[] = [
  { target: 'ARTI', defaultType: 'article' },
  { target: 'REPORT', defaultType: 'report' },
];

// curPage × rowCount < 10000 (KISTI 응답 상한). 넘으면 서버가 자름 → 페이징 중단 기준으로 사용
const KISTI_WINDOW_CAP = 10000;

/**
 * KISTI ScienceON 수집기.
 * apigateway.kisti.re.kr/openapicall.do 를 target(ARTI/REPORT)×키워드로 페이징 조회(GET+XML).
 *
 * 인증이 기존 소스와 다르다(2단계 토큰):
 *  1) 인증키(32자)를 AES256 키로 {mac_address,datetime} JSON을 암호화(URIEncoding) → tokenrequest.do 로 access_token 발급
 *  2) 데이터 호출 시 client_id + token(access_token) 파라미터 전달, 만료(2h) 시 refresh_token(2주)로 재발급
 * ⚠️ **신청 시 등록한 MAC에서만** 토큰 발급됨(NTIS의 IP 제한과 유사) → 운영 EC2에서만 동작.
 *    로컬은 MAC 불일치로 토큰 발급 실패가 정상. 필요 시 KISTI_MAC env로 MAC 강제 지정.
 * ⚠️ AES 모드는 공식 문서에 미명시 → 관례(AES-256-ECB+Base64)로 구현. 토큰 실패 시 이 부분부터 점검.
 * REPORT의 TRKO는 NTIS와 동일 식별자로 겹치지만, 크로스소스 중복은 스프링이 (발행년+제목+저자로) 거르므로 스킵 없이 전량 수집.
 */
@Injectable()
export class KistiCollectorService implements OnModuleInit {
  private readonly logger = new Logger(KistiCollectorService.name);
  private running = false;

  // 토큰 캐시 (인스턴스 메모리)
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0; // epoch ms
  private refreshToken: string | null = null;
  private refreshTokenExpiresAt = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly ingestService: ArchiveIngestService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (!isSchedulingEnabled(this.configService)) {
      this.logger.warn(
        '[kisti] ⏸️ 전역 스케줄링 비활성화 — 정기 수집 크론 미등록.',
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
          this.logger.error(`[kisti] 정기 수집 실패: ${(e as Error).message}`);
        }
      },
      null,
      false,
      'Asia/Seoul',
    );
    this.schedulerRegistry.addCronJob(CRON_ID, job);
    job.start();
    this.logger.log(`[kisti] 정기 수집 크론 등록 완료 (${CRON_TIME})`);
  }

  async collect(
    opts: ArchiveCollectOptions,
  ): Promise<ArchiveIngestSummary | { skipped: true; reason: string }> {
    if (this.running) {
      this.logger.warn('[kisti] 이전 수집이 아직 실행 중 → 이번 회차 스킵');
      return { skipped: true, reason: 'already running' };
    }
    this.running = true;

    const apiUrl = this.configService.get<string>('KISTI_API_URL');
    const apiKey = this.configService.get<string>('KISTI_API_KEY');
    const clientId = this.configService.get<string>('KISTI_CLIENT_ID');
    const originId = Number(this.configService.get('KISTI_ORIGIN_ID'));
    if (
      !apiUrl ||
      !apiKey ||
      !clientId ||
      !Number.isFinite(originId) ||
      originId <= 0
    ) {
      this.running = false;
      this.logger.warn(
        '[kisti] KISTI_API_URL / KISTI_API_KEY / KISTI_CLIENT_ID / KISTI_ORIGIN_ID 미설정 → 수집 생략',
      );
      return { skipped: true, reason: 'env not configured' };
    }

    const delayMs =
      Number(this.configService.get('ARCHIVE_API_DELAY_MS')) || 1000;
    const pageSize = Math.min(
      opts.pageSize ??
        Number(this.configService.get('ARCHIVE_PAGE_SIZE')) ??
        100,
      100, // rowCount 최대 100
    );
    const keywords = opts.keyword ? [opts.keyword] : [...KEYWORDS];
    const pubYearFrom = opts.incremental
      ? moment().subtract(1, 'year').format('YYYY')
      : undefined;

    this.logger.log(
      `[kisti] 수집 시작 — keyword=${opts.keyword ?? '전체(14개)'} maxPages=${opts.maxPages ?? '무제한'} ` +
        `pageSize=${pageSize} dryRun=${!!opts.dryRun} incremental=${!!opts.incremental} originId=${originId}`,
    );

    try {
      // 토큰 선발급 (실패하면 전체 수집 중단 — MAC/키/네트워크 문제이므로 키워드 반복이 무의미)
      await this.ensureToken(apiUrl, apiKey, clientId);

      const items: ArchiveItem[] = [];
      const failedFetches: string[] = [];
      for (const { target, defaultType } of KISTI_TARGETS) {
        for (const keyword of keywords) {
          try {
            const fetched = await this.fetchByKeyword(
              apiUrl,
              apiKey,
              clientId,
              target,
              defaultType,
              keyword,
              pageSize,
              opts.maxPages,
              pubYearFrom,
              delayMs,
            );
            items.push(...fetched);
          } catch (e) {
            failedFetches.push(
              `target=${target} "${keyword}": ${(e as Error).message}`,
            );
            this.logger.error(
              `[kisti] target=${target} "${keyword}" 조회 실패(재시도 소진) → 다음 키워드 계속: ${(e as Error).message}`,
            );
          }
          await sleep(delayMs);
        }
      }
      if (failedFetches.length) {
        this.logger.warn(
          `[kisti] 키워드 조회 실패 ${failedFetches.length}건 — 수집된 ${items.length}건은 정상 저장 진행: ${failedFetches.join(' / ')}`,
        );
      }
      const summary = await this.ingestService.ingest(
        originId,
        items,
        opts,
        'kisti',
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
      this.logger.error(`[kisti] 수집 실패: ${(e as Error).message}`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  // ─── 토큰 발급/갱신 ────────────────────────────────────────────────────────

  /** 유효한 access_token 확보 (캐시 → refresh → 신규발급 순). 만료 2분 전이면 미리 갱신 */
  private async ensureToken(
    apiUrl: string,
    apiKey: string,
    clientId: string,
  ): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt - 120_000)
      return this.accessToken;

    // refresh_token이 살아있으면 refresh, 아니면 신규발급
    if (this.refreshToken && now < this.refreshTokenExpiresAt - 120_000) {
      try {
        return await this.requestToken(apiUrl, clientId, {
          refresh_token: this.refreshToken,
        });
      } catch (e) {
        this.logger.warn(
          `[kisti] refresh 실패 → 신규 토큰 발급 시도: ${(e as Error).message}`,
        );
      }
    }
    const mac = this.detectMac();
    const datetime = moment().format('YYYYMMDDHHmmss');
    this.logger.log(
      `[kisti] 토큰 발급 시도 — mac=${mac || '(감지실패)'} datetime=${datetime} (등록 MAC과 달라야 실패)`,
    );
    const accounts = this.encryptAccounts(apiKey, mac, datetime);
    return this.requestToken(apiUrl, clientId, { accounts });
  }

  private async requestToken(
    apiUrl: string,
    clientId: string,
    params: { accounts?: string; refresh_token?: string },
  ): Promise<string> {
    const endpoint = `${apiUrl.replace(/\/+$/, '')}/tokenrequest.do`;
    const res = await axios.get(endpoint, {
      params: { ...params, client_id: clientId },
      headers: { 'User-Agent': BROWSER_UA },
      timeout: 30000,
      responseType: 'json',
    });
    // 토큰 응답은 JSON. 오류도 JSON으로 옴
    const d = typeof res.data === 'string' ? safeJson(res.data) : res.data;
    const token = d?.access_token;
    if (!token) {
      throw new BadGatewayException(
        `KISTI 토큰 발급 실패: ${JSON.stringify(d ?? res.data).slice(0, 200)} ` +
          `(MAC 미등록/AES 방식/키 확인 필요)`,
      );
    }
    this.accessToken = token;
    this.refreshToken = d.refresh_token ?? this.refreshToken;
    // 만료 형식이 문서에 불명확 → 보수적으로 access 1h55m, refresh 13일로 캐시
    this.accessTokenExpiresAt = Date.now() + 115 * 60_000;
    this.refreshTokenExpiresAt = Date.now() + 13 * 24 * 60 * 60_000;
    this.logger.log(
      `[kisti] 토큰 발급 성공 (access ~2h, refresh ~2w) issued_at=${d.issued_at ?? '-'}`,
    );
    return token;
  }

  /** {mac_address,datetime} JSON을 인증키(32자)로 AES-256-ECB 암호화 후 Base64 */
  private encryptAccounts(
    apiKey: string,
    mac: string,
    datetime: string,
  ): string {
    const plain = JSON.stringify({ mac_address: mac, datetime });
    const key = Buffer.from(apiKey, 'utf8'); // 32바이트 = AES-256
    const cipher = createCipheriv('aes-256-ecb', key, null);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return enc.toString('base64');
  }

  /** 등록된 MAC 우선(KISTI_MAC) → 아니면 첫 비내부 인터페이스 MAC. 형식: 대문자, 하이픈 구분 */
  private detectMac(): string {
    const envMac = this.configService.get<string>('KISTI_MAC');
    if (envMac) return envMac.toUpperCase().replace(/:/g, '-');
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] ?? []) {
        if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') {
          return ni.mac.toUpperCase().replace(/:/g, '-');
        }
      }
    }
    return '';
  }

  // ─── 조회/파싱 ─────────────────────────────────────────────────────────────

  private async fetchByKeyword(
    apiUrl: string,
    apiKey: string,
    clientId: string,
    target: 'ARTI' | 'REPORT',
    defaultType: ArchiveMaterialType,
    keyword: string,
    pageSize: number,
    maxPages: number | undefined,
    pubYearFrom: string | undefined,
    delayMs: number,
  ): Promise<ArchiveItem[]> {
    const items: ArchiveItem[] = [];
    let curPage = 1;
    let total = Infinity;
    const endpoint = `${apiUrl.replace(/\/+$/, '')}/openapicall.do`;
    // 증분: 발행년 범위. ARTI/REPORT 공통 PY 필드로 좁힌다
    const query: Record<string, string> = { BI: keyword };
    if (pubYearFrom) query.PY = `${pubYearFrom}:${moment().format('YYYY')}`;
    const searchQuery = JSON.stringify(query);

    while (
      curPage * pageSize < total + pageSize &&
      curPage * pageSize <= KISTI_WINDOW_CAP &&
      (!maxPages || curPage <= maxPages)
    ) {
      const token = await this.ensureToken(apiUrl, apiKey, clientId);
      let res = await this.callSearch(
        endpoint,
        clientId,
        token,
        target,
        searchQuery,
        curPage,
        pageSize,
      );

      // 토큰 만료(E4103) 등 인증오류면 강제 재발급 후 1회 재시도
      if (this.isAuthError(res.parsed)) {
        this.logger.warn(
          `[kisti] 인증 만료 추정 → 토큰 재발급 후 재시도 (target=${target} page=${curPage})`,
        );
        this.accessToken = null;
        const fresh = await this.ensureToken(apiUrl, apiKey, clientId);
        res = await this.callSearch(
          endpoint,
          clientId,
          fresh,
          target,
          searchQuery,
          curPage,
          pageSize,
        );
      }

      const meta = res.parsed?.MetaData;
      if (!meta) {
        throw new BadGatewayException(
          `KISTI 응답에 MetaData 없음: ${String(res.raw).slice(0, 200)}`,
        );
      }
      const errCode =
        meta?.errorDetail?.errorCode ?? meta?.resultSummary?.statusCode;
      if (meta?.errorDetail?.errorCode) {
        throw new BadGatewayException(
          `KISTI 오류 [${errCode}]: ${meta?.errorDetail?.errorMessage ?? meta?.errorMessage ?? ''}`,
        );
      }

      total = Number(meta?.resultSummary?.TotalCount ?? meta?.TotalCount ?? 0);
      const records = toArray<any>(meta?.recordList?.record);
      for (const rec of records) {
        const item = this.toArchiveItem(rec, target, defaultType, keyword);
        if (item) items.push(item);
      }

      this.logger.log(
        `[kisti] target=${target} "${keyword}" page=${curPage} → ${records.length}건 ` +
          `(전체 ${total}건${total > KISTI_WINDOW_CAP ? `, 상한 ${KISTI_WINDOW_CAP}까지만 조회` : ''})`,
      );

      if (records.length === 0) break;
      curPage++;
      if (curPage * pageSize < total) await sleep(delayMs);
    }
    return items;
  }

  private async callSearch(
    endpoint: string,
    clientId: string,
    token: string,
    target: string,
    searchQuery: string,
    curPage: number,
    rowCount: number,
  ): Promise<{ parsed: any; raw: string }> {
    const res = await axios.get(endpoint, {
      params: {
        client_id: clientId,
        token,
        version: '1.0',
        action: 'search',
        target,
        searchQuery, // axios가 URI 인코딩
        curPage,
        rowCount,
      },
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/xml, text/xml, */*',
      },
      timeout: 30000,
      responseType: 'text',
    });
    const parsed = await parseStringPromise(String(res.data), {
      explicitArray: false,
    }).catch(() => null);
    return { parsed, raw: String(res.data) };
  }

  private isAuthError(parsed: any): boolean {
    const code = parsed?.MetaData?.errorDetail?.errorCode ?? '';
    return String(code).toUpperCase().startsWith('E41'); // E4103 등 토큰 계열
  }

  /** KISTI record(XML) → 정규화 ArchiveItem. CN=고유식별자, ContentURL=상세 */
  private toArchiveItem(
    rec: any,
    target: 'ARTI' | 'REPORT',
    defaultType: ArchiveMaterialType,
    matchedKeyword: string,
  ): ArchiveItem | null {
    const title = stripTags(rec?.Title);
    const sourceId = stripTags(rec?.CN);
    if (!title || !sourceId) return null;

    // materialType: REPORT는 항상 report. ARTI는 CN/DBCode 접두로 학위(DIKO)/논문 구분
    const dbCode = String(rec?.DBCode ?? '').toUpperCase();
    let materialType: ArchiveMaterialType = defaultType;
    if (target === 'ARTI') {
      materialType =
        sourceId.startsWith('DIKO') || dbCode === 'DIKO' ? 'thesis' : 'article';
    }

    const yearMatch = String(rec?.Pubyear ?? rec?.Pubdate ?? '').match(/\d{4}/);
    // 발행기관: 보고서는 Publisher, 논문은 발행기관(Publisher) 없으면 저널명
    const publisher = stripTags(rec?.Publisher) || stripTags(rec?.JournalName);

    return {
      source: 'kisti',
      sourceId,
      title,
      publisher,
      author: stripTags(rec?.Author),
      publishYear: yearMatch ? yearMatch[0] : '',
      category: null, // 주제분류는 수집 후 ThemeClassifier가 태깅
      subCategory:
        stripTags(rec?.JournalName) || stripTags(rec?.Keyword) || null,
      summary: stripTags(rec?.Abstract) || null,
      detailUrl:
        stripTags(rec?.ContentURL) || stripTags(rec?.FulltextURL) || null,
      isbn: stripTags(rec?.ISBN) || null,
      materialType,
      matchedKeyword,
    };
  }
}

/** JSON 문자열 안전 파싱 (실패 시 null) */
function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
