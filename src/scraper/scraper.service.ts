import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { SchedulerRegistry } from '@nestjs/schedule';
import { UtilService } from 'src/common/util.service';
import axios from 'axios';
import { ProcessService } from 'src/common/utils/scrapProcess/process.service';
import { firefox, chromium, Browser, Page, BrowserContext } from 'playwright';
import { S3Service } from 'src/aws/s3/s3.service';
import { MediaDownloadService } from './media-download.service';
import { HtmlParsingService } from './html-parsing.service';
import { PageNavigationService } from './page-navigation.service';
import { GoogleChatService } from 'src/common/webhook/google-chat.service';
import { TranslationClientService } from './translation-client.service';

interface ScrapeConfig {
  startUrl: string[];
  id: any;
  origin_id?: number;
  steps: any[];
  webhook?: boolean;
  useListSession?: boolean;
  maxPage?: number; // config별 최대 순회 페이지 수 (미지정 시 MAX_PAGE)
  keywords?: string[]; // startUrl의 {keyword} 자리에 치환할 검색 키워드 목록
}

@Injectable()
export class ScraperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScraperService.name);

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    protected utilService: UtilService,
    private processService: ProcessService,
    private s3Service: S3Service,
    private mediaDownloadService: MediaDownloadService,
    private htmlParsingService: HtmlParsingService,
    private pageNavigationService: PageNavigationService,
    private googleChatService: GoogleChatService,
    private translationClient: TranslationClientService,
  ) {}

  async onModuleInit() {
    this.browser = await chromium.launch({ headless: true });
  }

  async onModuleDestroy() {
    await this.browser.close();
  }

  /**
   * 수집기 헬스체크용 상태 보고.
   * 핵심 의존성인 Playwright 브라우저가 살아있는지(isConnected)를 확인한다.
   * onModuleInit에서 브라우저 기동이 실패했거나 도중에 끊기면 수집이 전부 실패하므로,
   * 단순 프로세스 생존이 아니라 이 상태를 헬스 신호로 쓴다.
   */
  getHealth(): { browserConnected: boolean } {
    return { browserConnected: this.browser?.isConnected() ?? false };
  }

  private readonly regex = /[\r\n]+/g;
  private readonly base = 'https://example.com';

  private readonly headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: 'https://www.cato.org',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  };
  private browser: Browser;

  // ── 요청 스로틀 ────────────────────────────────────────────────
  // 같은 호스트에 연속 요청을 보내면 일부 사이트(예: gnews.gg.go.kr)의
  // 레이트 기반 WAF가 연결을 끊거나(ERR_EMPTY_RESPONSE) 무응답으로 막는다.
  // 호스트별로 마지막 요청 시각을 기록해 최소 간격을 강제한다.
  private readonly lastRequestAt = new Map<string, number>();
  private readonly DEFAULT_THROTTLE_MS = 1500;
  private readonly THROTTLE_BY_HOST: Record<string, number> = {
    'gnews.gg.go.kr': 5000, // 실측상 ~8회/짧은시간 넘으면 차단 → 넉넉히 (URL 해시 변경 후 첫 전량 재수집 대비 3000→5000)
  };

  // 대상 호스트에 대해 최소 간격이 지나도록 대기한다. (호스트가 다르면 서로 무관)
  private async throttle(targetUrl: string): Promise<void> {
    let host: string;
    try {
      host = new URL(targetUrl).host;
    } catch {
      return; // 잘못된 URL이면 스로틀 생략
    }
    const minInterval =
      this.THROTTLE_BY_HOST[host] ?? this.DEFAULT_THROTTLE_MS;
    const now = Date.now();
    const last = this.lastRequestAt.get(host) ?? 0;
    const jitter = last ? Math.floor(Math.random() * 500) : 0;
    // 다음 허용 시각을 예약해두면 동시/연속 호출에도 간격이 보장된다.
    const scheduled = Math.max(now, last + minInterval) + jitter;
    this.lastRequestAt.set(host, scheduled);
    const waitMs = scheduled - now;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // 목록 페이지 세션/쿠키를 상세 페이지에서도 유지할지 config 값으로 판단한다.
  private shouldUseListSession(config: ScrapeConfig): boolean {
    return config.useListSession === true;
  }

  private async gotoListPage(page: Page, url: string): Promise<Page> {
    // WAF 차단(연결 끊김/무응답)에 걸리면 goto가 timeout까지 대기하므로,
    // 재시도 단계와 단계별 timeout을 줄여 최악의 경우 대기시간을 축소한다.
    // (기존 3단계 × 50s = 최대 150s → 2단계 × 20s = 최대 40s)
    const attempts: Array<'domcontentloaded' | 'commit'> = [
      'domcontentloaded',
      'commit',
    ];
    const GOTO_TIMEOUT = 20000;
    let lastError: Error | null = null;
    let activePage = page;
    const context = page.context();

    for (const waitUntil of attempts) {
      try {
        await this.throttle(url);
        await activePage.goto(url, { waitUntil, timeout: GOTO_TIMEOUT });
        await activePage
          .waitForLoadState('networkidle', { timeout: 5000 })
          .catch(() => {});
        return activePage;
      } catch (e) {
        lastError = e as Error;
        this.logger.warn(
          `목록 페이지 이동 실패 (${waitUntil}) → 재시도: ${lastError.message}`,
        );
        await activePage.close().catch(() => {});
        activePage = await context.newPage();
      }
    }

    await activePage.close().catch(() => {});
    throw lastError ?? new Error(`목록 페이지 이동 실패: ${url}`);
  }

  // 상세페이지별 처리를 함수화
  /**
   * 기사 URL 정규화: 매 요청마다 값이 바뀌는 세션·CSRF성 쿼리 파라미터를 제거한다.
   * 해시(articleHash)·중복 판별용으로만 사용하고, 실제 페이지 이동은 원본 URL을 쓴다.
   */
  private normalizeArticleUrl(url: string): string {
    try {
      const u = new URL(url);
      ['_csrf', 'csrf', 'csrfToken', 'JSESSIONID', 'PHPSESSID'].forEach((p) =>
        u.searchParams.delete(p),
      );
      return u.toString();
    } catch {
      return url;
    }
  }

  /** JSON 객체에서 'a.b.c' 점 경로로 값을 꺼낸다. */
  private getByPath(obj: any, path?: string): any {
    if (!path) return undefined;
    return path
      .split('.')
      .reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  /**
   * 추출한 상세 URL 목록에 중복 제거를 적용한다.
   * - seenOnThisUrl: 이 URL 크롤링(키워드) 내 페이징 중복 감지용
   * - seenDetailUrls: 실행 전체(키워드 간) 중복 수집 방지용
   * 반환 stop=true면 페이징을 중단해야 함(빈 목록 또는 중복 페이지).
   */
  private applyDetailUrlDedup(
    extractedDetailUrls: string[],
    seenOnThisUrl: Set<string>,
    seenDetailUrls: Set<string>,
    configId: any,
    pageLabel: string,
  ): { detailUrls: string[]; detailUrlIndexes: number[]; stop: boolean } {
    if (extractedDetailUrls.length === 0) {
      this.logger.warn(
        `[${configId}] 빈 목록 페이지 감지 → 페이징 중단: ${pageLabel}`,
      );
      return { detailUrls: [], detailUrlIndexes: [], stop: true };
    }
    // 1) 이 URL 크롤링 기준 새 상세 URL인지 판단 → 페이징 중복 감지
    // 중복 키는 정규화 URL(_csrf 등 제거) 기준, 이동은 원본 URL 사용
    const newOnThisUrl: Array<{ url: string; key: string; index: number }> = [];
    extractedDetailUrls.forEach((detailUrl, index) => {
      const key = this.normalizeArticleUrl(detailUrl);
      if (seenOnThisUrl.has(key)) return;
      seenOnThisUrl.add(key);
      newOnThisUrl.push({ url: detailUrl, key, index });
    });

    let stop = false;
    if (newOnThisUrl.length === 0) {
      this.logger.warn(
        `[${configId}] 중복 페이지 감지: 새 상세 URL 없음 (${pageLabel})`,
      );
      stop = true;
    }

    // 2) 다른 키워드(startUrl)에서 이미 수집한 상세는 제외 — 페이징 판단에는 영향 없음
    const newDetailUrlPairs = newOnThisUrl.filter(
      (pair) => !seenDetailUrls.has(pair.key),
    );
    newDetailUrlPairs.forEach((pair) => seenDetailUrls.add(pair.key));
    const skipped = newOnThisUrl.length - newDetailUrlPairs.length;
    if (skipped > 0) {
      this.logger.log(
        `[${configId}] 다른 키워드에서 이미 수집한 상세 ${skipped}건 skip`,
      );
    }

    return {
      detailUrls: newDetailUrlPairs.map((pair) => pair.url),
      detailUrlIndexes: newDetailUrlPairs.map((pair) => pair.index),
      stop,
    };
  }

  async scrapeOne(
    url: string,
    targets,
    configId: number,
    listData?: Record<string, string>,
    webhook = true,
    sharedContext?: BrowserContext,
    originId = 0,
    keywordPattern?: RegExp | null,
  ) {
    this.logger.log(`▶ [${configId}] ${url}`);
    if (url.includes('sections-offices/')) return;

    // 해시는 정규화 URL 기준 — _csrf 등 매번 바뀌는 토큰이 붙어도 같은 기사로 판별
    const articleHash = createHash('md5')
      .update(this.normalizeArticleUrl(url))
      .digest('hex')
      .slice(0, 8);

    const alreadySaved = originId > 0 && await this.s3Service.articleExists(originId, articleHash);
    if (alreadySaved) {
      this.logger.log(`[${configId}] 이미 저장된 기사 skip (S3): ${url}`);
      return null;
    }

    const ownsContext = !sharedContext;
    const context =
      sharedContext ??
      (await this.browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/114.0.0.0 Safari/537.36',
        locale: 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
        },
        acceptDownloads: true, // 파일 다운로드 이벤트 활성화
        ignoreHTTPSErrors: true, // https 인증 검증 무시
      }));
    const page = await context.newPage();
    const temp: Record<string, any> = {};

    try {
      try {
        await this.throttle(url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 50000 });
      } catch (e) {
        this.googleChatService.sendAlert(
          '상세 페이지 접근 실패',
          {
            configId: `${configId}`,
            URL: url,
            에러: (e as Error).message,
          },
          webhook,
        );
        throw e;
      }

      // 1) 먼저 제목을 뽑아서 중복 체크
      const titleSelector = targets.find((t) => t.name === 'title')?.selector;
      let titleText = '';
      if (titleSelector) {
        const textsViaEval = await page.$$eval(titleSelector, (els) =>
          els.map((el) => (el.textContent || '').trim()),
        );
        titleText = textsViaEval.join(' ');
      }
      // 제목이 비어있으면 알림 후 skip
      if (!titleText.trim()) {
        console.warn(`⚠️ 제목 없음, 기사 skip: ${url}`);
        this.googleChatService.sendAlert(
          '제목 없음, 기사 skip',
          {
            configId: `${configId}`,
            셀렉터: titleSelector || '없음',
            URL: url,
          },
          webhook,
        );
        return null;
      }
      // 리스트에서 미리 추출한 데이터 적용 (writer-list → writer 등)
      if (listData) {
        for (const [key, val] of Object.entries(listData)) {
          // 목록에서 추출한 날짜도 상세 날짜와 동일하게 YYYYMMDD로 정규화
          if (key.includes('date')) {
            try {
              temp[key] = await this.processService.changeDateForm(val);
            } catch {
              temp[key] = val;
            }
          } else {
            temp[key] = val;
          }
        }
      }

      // 검수 패턴: null이면 검수 생략(키워드 검색으로 수집된 URL — 사이트가 이미 필터링),
      // RegExp면 키워드 검수, 미지정(undefined)이면 기존 DMZ 검수
      const dmzPattern = keywordPattern === null ? null : (keywordPattern ?? /dmz/i);
      let dmzChecked = false;

      for (const target of targets) {
        // '-list' 타겟은 리스트에서 이미 추출했으므로 skip
        if (target.name.endsWith('-list')) continue;

        // 미디어 타겟 직전 DMZ 검수 — 한 번만 체크 (dmzPattern이 null이면 생략)
        if (!dmzChecked && dmzPattern && (target.type === 'images' || target.type === 'file')) {
          dmzChecked = true;
          const titleStr   = String(temp.title   ?? '');
          const contentStr = String(temp.content  ?? '');
          if (!dmzPattern.test(titleStr) && !dmzPattern.test(contentStr)) {
            this.logger.log(`[${configId}] DMZ 검수 실패 → 미디어 skip: ${url}`);
            return null;
          }
        }

        // 1) 기본값 세팅
        let dataDefault: any;
        switch (target.type) {
          case 'duplicatedText':
          case 'uniqueText':
            dataDefault = '';
            break;
          case 'images':
            dataDefault = [];
            break;
          case 'file':
            dataDefault = [];
            break;
          default:
            dataDefault = null;
        }

        let data = dataDefault;
        try {
          if (
            target.type !== 'duplicatedText' &&
            target.type !== 'images' &&
            // optional file은 사전 대기 생략 — 첨부 없는 글마다 10초 타임아웃 낭비 방지.
            // file 분기에 자체 존재 체크가 있고 handleFileStep도 5초 대기를 가짐
            !(target.type === 'file' && target.optional) &&
            !page.url().includes('www.congress.gov')
          ) {
            await page.waitForSelector(target.selector, {
              timeout: 10000,
              state: 'attached',
            });
          }

          // 2) data 추출
          if (target.type === 'duplicatedText') {
            if (page.url().includes('www.congress.gov')) {
              data = await this.htmlParsingService.extractParagraphs(
                page,
                target.selector,
              );
            } else {
              data = await this.htmlParsingService.exportVisibleText(
                page,
                target.selector,
              );
            }
            // 줄바꿈을 <br>로 변환하고 잔여 탭·중복 공백 정리하여 저장
            data = (data as string)
              .replace(/\s*[\r\n]+\s*/g, ' <br> ')
              .replace(/\t+/g, ' ')
              .replace(/ {2,}/g, ' ')
              .trim();
          } else if (target.type === 'uniqueText') {
            if (target?.name.includes('date')) {
              const txt = await page.locator(target.selector).textContent();
              data = await this.processService.changeDateForm(
                (txt || '').trim(),
              );
            } else {
              await page.waitForSelector(target.selector, { timeout: 5000 });
              const textsViaEval = await page.$$eval(target.selector, (els) =>
                els.map((el) =>
                  (el.textContent || '').replace(/\s+/g, ' ').trim(),
                ),
              );
              data = textsViaEval.join(' ');
              // writer 필드에서 '기자명' 제거
              if (target.name === 'writer') {
                data = data.replace(/기자명\s*/g, '').replace(/^작성자\s*/g, '').trim();
              }
            }
          } else if (target.type === 'images') {
            data = await this.mediaDownloadService.handleImagesStep(
              page,
              target,
              originId,
              webhook,
              articleHash,
            );
          } else if (target.type === 'file') {
            const selectorExists = (await page.locator(target.selector).count()) > 0;
            if (!selectorExists) {
              data = target.optional ? [] : null;
              if (!target.optional) {
                console.warn(`⚠️ 비정상 파일 감지, 기사 skip: ${url}`);
                await page.close();
                return null;
              }
            } else {
              data = await this.mediaDownloadService.handleFileStep(
                page,
                target,
                originId,
                temp['title'],
                webhook,
                articleHash,
              );
              if (data === null) {
                console.warn(`⚠️ 비정상 파일 감지, 기사 skip: ${url}`);
                await page.close();
                return null;
              }
            }
          }
        } catch (e) {
          this.logger.warn(
            `  ↳ [${target.name}] 추출 실패, 기본값 사용: ${(e as Error).message}`,
          );
          data = dataDefault;
        }

        // 스크랩 결과 저장 직후에 적용할 누적 로직 예시
        const key = target.name;
        const prev = temp[key];

        // 1) 기존에 값이 있었다면
        if (prev !== undefined) {
          // 문자열 → 문자열 결합
          if (typeof prev === 'string' && typeof data === 'string') {
            temp[key] = prev + data;

            // 배열 → 배열에 push
          } else if (Array.isArray(prev)) {
            prev.push(data);
            temp[key] = prev;

            // 객체 → 객체 병합
          } else if (
            prev !== null &&
            typeof prev === 'object' &&
            data !== null &&
            typeof data === 'object'
          ) {
            temp[key] = { ...prev, ...data };

            // 그 외 → 배열로 묶기
          } else {
            temp[key] = [prev, data];
          }

          // 2) 처음 세팅이라면 그냥 할당
        } else {
          temp[key] = data;
        }
      }

      // 저장용 URL도 정규화 — link_url 기반 DB 중복 판별이 토큰 차이로 뚫리지 않도록
      temp.currentUrl = this.normalizeArticleUrl(url);
      temp._originId   = originId;
      temp._hash       = articleHash;

      return temp;
    } catch (e) {
      console.error(`❌ scrapeOne 전체 실패 (${url}):`, e.message);
      return temp;
    } finally {
      await page.close();
      if (ownsContext) {
        await context.close();
      }
    }
  }

  private readonly MAX_PAGE = 5; // 기본 최대 순회 페이지 수
  /**
   * 주 진입점: 다중 startUrl을 병렬로 처리하고, 각 URL에 대해 scrapeUrl 실행
   */
  async runWorkflow(
    config: ScrapeConfig,
  ): Promise<{ configId: any; data: any[] }> {
    const pLimit = (await import('p-limit')).default;
    // startUrl 여러 개(키워드별 URL)를 순차 처리 — 동시 요청으로 인한 봇 차단 방지
    const limit = pLimit(1);

    const webhook = config.webhook ?? true;
    const useListSession = this.shouldUseListSession(config);
    const originId = config.origin_id ?? 0;

    // startUrl의 {keyword} 플레이스홀더를 keywords 배열로 전개 (한글은 URL 인코딩)
    // keywords가 없거나 {keyword}가 없는 URL은 그대로 사용
    const urlEntries = [
      ...new Map(
        config.startUrl
          .flatMap((u) =>
            u.includes('{keyword}') && config.keywords?.length
              ? config.keywords.map((k) => ({
                  url: u.replace(/\{keyword\}/g, encodeURIComponent(k)),
                  fromKeyword: true, // 키워드 검색으로 수집 → 사이트가 이미 필터링
                  keyword: k,
                }))
              : [{ url: u, fromKeyword: false, keyword: undefined }],
          )
          .map((e) => [e.url, e] as const),
      ).values(),
    ];
    if (urlEntries.length > config.startUrl.length) {
      this.logger.log(
        `[${config.id}] 키워드 전개: startUrl ${config.startUrl.length}개 × 키워드 ${config.keywords!.length}개 → ${urlEntries.length}개 URL`,
      );
    }

    // 검수 패턴: keywords가 있으면 키워드 검수, 없으면 기존 /dmz/i 검수
    // (키워드 검색으로 전개된 URL은 검수 생략 — 아래에서 null 전달)
    const keywordPattern = config.keywords?.length
      ? new RegExp(
          config.keywords
            .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|'),
          'i',
        )
      : undefined;

    // 키워드 간 검색 결과가 겹치므로, 같은 실행 내에서 이미 긁은 상세 URL은 재수집하지 않도록 공유
    const seenDetailUrls = new Set<string>();
    const total = urlEntries.length;
    const tasks = urlEntries.map((entry, i) =>
      limit(async () => {
        // 첫 URL 제외, 다음 URL 시작 전 3초 텀 — 봇 차단 방지
        if (i > 0) await new Promise((r) => setTimeout(r, 3000));
        // 진행 상황 로그: 키워드가 있으면 "3/15 [비무장지대]", 없으면 "1/1"
        const progress = entry.keyword
          ? `${i + 1}/${total} [${entry.keyword}]`
          : `${i + 1}/${total}`;
        this.logger.log(`[${config.id}] 수집 진행 ${progress}`);
        // 키워드 검색 URL은 사후 검수 생략(null), 그 외엔 키워드/DMZ 검수
        const inspectPattern = entry.fromKeyword ? null : keywordPattern;
        return this.scrapeUrl(entry.url, config.steps, config.id, webhook, useListSession, originId, config.maxPage, seenDetailUrls, inspectPattern);
      }),
    );

    const pagesData = await Promise.all(tasks);
    // scrapeOne에서 DMZ 검수 실패 시 null 반환 → 제거
    const scraperData = pagesData.flat().filter(Boolean);

    this.logger.log(`[${config.id}] DMZ 검수 완료: ${scraperData.length}건 통과`);

    // 검수 통과한 기사 번역 후 meta.json 저장
    await Promise.all(
      scraperData.map(async (item) => {
        const { _originId, _hash, ...meta } = item;
        if (!_originId || !_hash) return;

        this.logger.log(`[${config.id}] 번역 시작: "${meta.title ?? ''}"`);
        try {
          const translated = await this.translationClient.translateArticle(meta);
          meta.title_en = translated.title_en ?? '';
          meta.content_text_en = translated.content_en ?? '';
          this.logger.log(
            `[${config.id}] 번역 완료: title_en="${meta.title_en.slice(0, 50)}..."`,
          );
        } catch (e) {
          // 번역 앱 다운/실패 시 영문 필드는 null로 저장 → download2 적재 시 trsl_yn='N'
          meta.title_en = null;
          meta.content_text_en = null;
          this.logger.warn(
            `[${config.id}] 영문 번역 실패, 원문만 저장: ${e.message}`,
          );
        }

        return this.s3Service
          .saveArticleMeta(_originId, _hash, meta)
          .catch((e) =>
            this.logger.warn(`meta.json 저장 실패: ${e.message}`),
          );
      }),
    );

    return { configId: config.id, data: scraperData };
  }

  /**
   * 단일 URL을 최대 maxPage(기본 MAX_PAGE)만큼 순회하며 스크랩
   */
  private async scrapeUrl(
    url: string,
    steps: any[],
    configId: any,
    webhook = true,
    useListSession = false,
    originId = 0,
    maxPage?: number,
    seenDetailUrls: Set<string> = new Set<string>(),
    keywordPattern?: RegExp | null,
  ): Promise<any[]> {
    const pageLimit = maxPage ?? this.MAX_PAGE;
    console.log('scrapeUrl-ID : ', configId);

    const context: BrowserContext = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
    });
    let page: Page = await context.newPage();
    const results: any[] = [];
    // 이 URL 크롤링 내에서 본 상세 URL (페이징 중복 감지용 — 키워드 간 공유 X)
    const seenOnThisUrl = new Set<string>();

    // 페이징 스텝이 정의되어 있는지 확인
    const hasPagingStep = steps.some((s) => s.type === 'paging');
    // JSON API 리스트 스텝 여부 — 페이징을 DOM 클릭 대신 page 파라미터 증가로 처리
    const hasAjaxListStep = steps.some((s) => s.type === 'ajaxListApi');

    try {
      // 2) 실제 탐색 시도 (DOMContentLoaded + networkidle 병행 대기)
      try {
        page = await this.gotoListPage(page, url);
      } catch (e) {
        console.error('Navigation failed:', (e as Error).message);
        return results;
      }

      let currentPage = 1;
      outer: while (true) {
        let detailUrls: string[] = [];
        let detailUrlIndexes: number[] = [];
        let stopPagingByDuplicatePage = false;
        // ajaxListApi가 JSON에서 만든 리스트 데이터(writer/date 등). null이면 DOM에서 추출.
        let pageListData: Record<string, string>[] | null = null;

        // steps 순서대로 처리
        for (const step of steps) {
          switch (step.type) {
            // case 'detailLinks':
            //   if (
            //     url.includes('www.koreaexim.go.kr') ||
            //     url.includes('www.kida.re.kr/frt/board/frtNormalBoard')
            //   ) {
            //     detailUrls = await this.extractDetailUrls(page, step, url);
            //   }
            //   detailUrls = await this.extractDetailUrls_0611(page, step);
            //   break;
            case 'detailLinks':
              const current = page.url();
              if (
                current.includes('www.kndu.ac.kr') ||
                current.includes('www.koreaexim.go.kr') ||
                current.includes('www.kida.re.kr/frt/board/frtNormalBoard')
              ) {
                detailUrls = await this.pageNavigationService.extractDetailUrls(
                  page,
                  step,
                  current,
                  configId,
                  webhook,
                );
              } else {
                detailUrls =
                  await this.pageNavigationService.extractDetailUrls_0611(
                    page,
                    step,
                    configId,
                    webhook,
                  );
              }
              {
                const dedup = this.applyDetailUrlDedup(
                  detailUrls,
                  seenOnThisUrl,
                  seenDetailUrls,
                  configId,
                  page.url(),
                );
                detailUrls = dedup.detailUrls;
                detailUrlIndexes = dedup.detailUrlIndexes;
                if (dedup.stop) stopPagingByDuplicatePage = true;
              }
              break;

            case 'ajaxListApi': {
              // 검색결과를 JSON API로 반환하는 사이트: 브라우저 렌더링 없이 API 직접 호출
              const p = step.params || {};
              const apiUrl = new URL(p.apiUrl, url).href;
              const pageParam = p.pageParam || 'page';
              const kwFrom = p.keywordFrom || 'searchKeyword';
              const kwParam = p.keywordParam || 'searchKeyword';

              // 현재 startUrl(키워드 전개 결과)의 쿼리에서 검색어를 읽어 POST 본문에 실음
              let keyword = '';
              try {
                keyword = new URL(url).searchParams.get(kwFrom) || '';
              } catch {
                keyword = '';
              }

              const form: Record<string, string> = {
                ...(p.baseParams || {}),
                [pageParam]: String(currentPage),
              };
              if (keyword) form[kwParam] = keyword;

              let json: any;
              try {
                await this.throttle(apiUrl);
                const res = await page.context().request.post(apiUrl, {
                  form,
                  headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    Referer: url,
                  },
                  timeout: 30000,
                });
                if (!res.ok()) {
                  this.logger.warn(
                    `[${configId}] ajaxListApi HTTP ${res.status()} (page=${currentPage})`,
                  );
                  stopPagingByDuplicatePage = true;
                  break;
                }
                json = await res.json();
              } catch (e) {
                this.logger.warn(
                  `[${configId}] ajaxListApi 요청 실패 (page=${currentPage}): ${(e as Error).message}`,
                );
                stopPagingByDuplicatePage = true;
                break;
              }

              const rows = this.getByPath(json, p.listPath);
              const rowArr: any[] = Array.isArray(rows) ? rows : [];
              const totalPages = Number(this.getByPath(json, p.totalPagePath)) || 0;

              // 상세 URL 조립: 템플릿의 ${FIELD}를 JSON 행 필드로 치환
              const tmpl: string = p.detailUrlTemplate;
              const extractedDetailUrls = rowArr.map((row) =>
                new URL(
                  tmpl.replace(/\$\{(\w+)\}/g, (_m, k) =>
                    encodeURIComponent(String(row[k] ?? '')),
                  ),
                  url,
                ).href,
              );

              // JSON 필드 → 리스트 데이터(writer/writedate 등) 매핑, 원본 행 순서로 보관
              if (p.listFields) {
                pageListData = rowArr.map((row) => {
                  const rec: Record<string, string> = {};
                  for (const [target, field] of Object.entries(p.listFields)) {
                    rec[target] = String(row[field as string] ?? '');
                  }
                  return rec;
                });
              }

              const dedup = this.applyDetailUrlDedup(
                extractedDetailUrls,
                seenOnThisUrl,
                seenDetailUrls,
                configId,
                `page=${currentPage}`,
              );
              detailUrls = dedup.detailUrls;
              detailUrlIndexes = dedup.detailUrlIndexes;
              if (dedup.stop) stopPagingByDuplicatePage = true;
              // 마지막 페이지면 이번 페이지 처리 후 중단
              if (totalPages && currentPage >= totalPages) {
                stopPagingByDuplicatePage = true;
              }

              this.logger.log(
                `[${configId}] ajaxListApi page ${currentPage}/${totalPages || '?'}: 결과 ${rowArr.length}건, 신규 ${detailUrls.length}건`,
              );
              break;
            }

            case 'scrapDetail':
              // 새 상세 URL이 없으면(중복 페이지 감지 등) 목록 재평가를 건너뛴다.
              // 늦게 도착한 내비게이션이 컨텍스트를 파괴해 $$eval이 죽는 것 방지.
              if (detailUrls.length === 0) break;
              // ajaxListApi가 JSON으로 만든 리스트 데이터가 있으면 그대로 사용,
              // 없으면 리스트 페이지 DOM에서 '-list' 타겟 데이터 추출
              const listDataArray: Record<string, string>[] = pageListData ?? [];
              if (!pageListData) {
                const listTargets = (step.params.targets || []).filter((t) =>
                  t.name.endsWith('-list'),
                );
                if (listTargets.length > 0) {
                  for (const lt of listTargets) {
                    const values = await page.$$eval(lt.selector, (els) =>
                      els.map((el) =>
                        (el.textContent || '').replace(/\s+/g, ' ').trim(),
                      ),
                    );
                    values.forEach((val, i) => {
                      if (!listDataArray[i]) listDataArray[i] = {};
                      // 'writer-list' → 'writer'로 저장
                      const baseName = lt.name.replace(/-list$/, '');
                      listDataArray[i][baseName] = val;
                    });
                  }
                }
              }

              const scrapResults = await this.scrapeDetails(
                detailUrls,
                step,
                configId,
                detailUrlIndexes.map((index) => listDataArray[index]),
                webhook,
                useListSession ? context : undefined,
                originId,
                keywordPattern,
              );
              if (Array.isArray(scrapResults)) {
                results.push(...scrapResults);
              } else if (scrapResults) {
                results.push(scrapResults);
              }
              break;

            case 'formSubmit':
              // 첫 페이지에서만 폼 제출 — 페이지네이션 반복 시 재실행 방지
              if (currentPage === 1) {
                const { fields = [], submitSelector } = step.params;
                for (const field of fields) {
                  try {
                    const tagName = await page.$eval(field.selector, (el) =>
                      el.tagName.toLowerCase(),
                    );
                    if (tagName === 'select') {
                      await page.selectOption(field.selector, field.value);
                    } else {
                      await page.fill(field.selector, field.value);
                    }
                  } catch {
                    this.logger.warn(
                      `  ↳ [formSubmit] 필드 없음: ${field.selector}`,
                    );
                  }
                }
                if (submitSelector) {
                  await page.click(submitSelector);
                  // 페이지 이동(POST redirect) 또는 AJAX 응답 모두 networkidle로 대기
                  await page.waitForLoadState('networkidle', {
                    timeout: 30000,
                  });
                }
              }
              break;

            case 'paging':
              if (stopPagingByDuplicatePage) break outer;
              if (currentPage >= pageLimit) break outer;
              let hasNext = null;
              // 다음 페이지 이동 전에도 같은 호스트 스로틀 적용
              await this.throttle(page.url());
              // 한국문화관광연구원용
              if (page.url().includes('www.kcti.re.kr/web/board/')) {
                hasNext = await this.pageNavigationService.clickNext_ME(
                  page,
                  currentPage,
                  step.params.selector,
                );
              } else {
                hasNext = await this.pageNavigationService.clickNext(
                  page,
                  currentPage,
                  step.params.selector,
                );
              }

              if (!hasNext) break outer;
              currentPage += 1;
              break;

            default:
              break;
          }
        }

        // ajaxListApi 모드: DOM 페이징 대신 page 파라미터를 증가시켜 다음 페이지 요청
        if (hasAjaxListStep) {
          if (stopPagingByDuplicatePage || currentPage >= pageLimit) break outer;
          currentPage += 1;
          continue;
        }
        // 페이징 스텝이 없으면 첫 페이지만 수행 후 종료
        if (!hasPagingStep) break outer;
      }

      return results;
    } finally {
      await page.close().catch(() => {});
      await context.close();
    }
  }

  /**
   * scrapDetail 스텝에서 각 URL 순회하며 scrapeOne 실행
   */
  private async scrapeDetails(
    detailUrls: string[],
    step: any,
    configId: any,
    listDataArray?: Record<string, string>[],
    webhook = true,
    sharedContext?: BrowserContext,
    originId = 0,
    keywordPattern?: RegExp | null,
  ): Promise<any[]> {
    const results: any[] = [];
    for (let i = 0; i < detailUrls.length; i++) {
      const detailUrl = detailUrls[i];
      const listData = listDataArray?.[i];
      const pageResults = await this.scrapeOne(
        detailUrl,
        step.params.targets,
        configId,
        listData,
        webhook,
        sharedContext,
        originId,
        keywordPattern,
      );
      if (Array.isArray(pageResults)) {
        results.push(...pageResults);
      } else if (pageResults !== undefined && pageResults !== null) {
        results.push(pageResults);
      }
    }
    return results;
  }

  async fetchHtml(useBrowser: boolean, url: string): Promise<string> {
    try {
      if (useBrowser) {
        const browser = await firefox.launch({ headless: true });
        const context = await browser.newContext({});
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const html = await page.content();
        await browser.close();
        return html;
      } else {
        const response = await axios.get(url, {
          headers: this.headers,
          maxRedirects: 5, // 여기 명시
        });
        return response.data;
      }
    } catch (err: any) {
      console.error(`❌ fetchHtml 실패 (${url})`, err.message);

      // 리다이렉트가 과한 경우 fallback으로 브라우저 모드 재시도
      if (!useBrowser && err.code === 'ERR_FR_TOO_MANY_REDIRECTS') {
        console.warn(`🔁 리다이렉션 과다 → 브라우저 모드로 재시도: ${url}`);
        return this.fetchHtml(true, url);
      }

      throw err;
    }
  }

  /**
   * HTML 정리를 HtmlParsingService에 위임한다.
   */
  async getCleanHtml(html: string, isHard): Promise<string> {
    return this.htmlParsingService.getCleanHtml(html, isHard);
  }

  /**
   * 비디오 스크래핑을 MediaDownloadService에 위임한다.
   */
  async videoScrap(pageUrl: string) {
    return this.mediaDownloadService.videoScrap(this.browser, pageUrl);
  }
}
