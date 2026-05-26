import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { UtilService } from 'src/common/util.service';
import { format } from 'date-fns';
import axios from 'axios';
import { Article } from 'src/news/news.entity';
import { ProcessService } from '../../dist/common/utils/scrapProcess/process.service';
import {
  firefox,
  chromium,
  Browser,
  Page,
  BrowserContext,
} from 'playwright';
import { S3Service } from 'src/aws/s3/s3.service';
import { MediaDownloadService } from './media-download.service';
import { HtmlParsingService } from './html-parsing.service';
import { PageNavigationService } from './page-navigation.service';
import { GoogleChatService } from 'src/common/webhook/google-chat.service';

interface ScrapeConfig {
  startUrl: string[];
  id: any;
  steps: any[];
  webhook?: boolean;
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
  ) {}

  async onModuleInit() {
    this.browser = await chromium.launch({ headless: true });
  }

  async onModuleDestroy() {
    await this.browser.close();
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

  // 상세페이지별 처리를 함수화
  async scrapeOne(url: string, targets, configId: number, listData?: Record<string, string>, webhook = true) {
    this.logger.log(`▶ [${configId}] ${url}`);
    if (url.includes('sections-offices/')) return;

    const context = await this.browser.newContext({
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
    });
    const page = await context.newPage();
    const temp: Record<string, any> = {};

    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 50000 });
      } catch (e) {
        this.googleChatService.sendAlert('상세 페이지 접근 실패', {
          'configId': `${configId}`,
          'URL': url,
          '에러': (e as Error).message,
        }, webhook);
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
        this.googleChatService.sendAlert('제목 없음, 기사 skip', {
          'configId': `${configId}`,
          '셀렉터': titleSelector || '없음',
          'URL': url,
        }, webhook);
        await page.close();
        return null;
      }
      // 리스트에서 미리 추출한 데이터 적용 (writer-list → writer 등)
      if (listData) {
        for (const [key, val] of Object.entries(listData)) {
          temp[key] = val;
        }
      }

      for (const target of targets) {
        // '-list' 타겟은 리스트에서 이미 추출했으므로 skip
        if (target.name.endsWith('-list')) continue;

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
              data = await this.htmlParsingService.extractParagraphs(page, target.selector);
            } else {
              data = await this.htmlParsingService.exportVisibleText(page, target.selector);
            }
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
                data = data.replace(/기자명\s*/g, '').trim();
              }
            }
          } else if (target.type === 'images') {
            data = await this.mediaDownloadService.handleImagesStep(page, target, configId, webhook);
          } else if (target.type === 'file') {
            data = await this.mediaDownloadService.handleFileStep(page, target, configId, temp['title'], webhook);
            if (data === null) {
              console.warn(`⚠️ 비정상 파일 감지, 기사 skip: ${url}`);
              await page.close();
              return null;
            }
          }
        } catch {
          this.logger.warn(`  ↳ [${target.name}] 셀렉터 불일치, 기본값 사용`);
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

      temp.currentUrl = url;
      return temp;
    } catch (e) {
      console.error(`❌ scrapeOne 전체 실패 (${url}):`, e.message);
      return temp;
    } finally {
      await page.close();
      await context.close();
    }
  }

  private readonly MAX_PAGE = 3; // 기본 최대 순회 페이지 수
  /**
   * 주 진입점: 다중 startUrl을 병렬로 처리하고, 각 URL에 대해 scrapeUrl 실행
   */
  async runWorkflow(
    config: ScrapeConfig,
  ): Promise<{ configId: any; data: any[] }> {
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(2);

    const webhook = config.webhook ?? true;
    const tasks = config.startUrl.map((url) =>
      limit(() => this.scrapeUrl(url, config.steps, config.id, webhook)),
    );

    const pagesData = await Promise.all(tasks);
    const scraperData = pagesData.flat();

    const dmzPattern = /dmz/i;
    const filtered = scraperData.filter((item) => {
      const title = String(item?.title ?? '');
      const content = String(item?.content ?? '');
      return dmzPattern.test(title) || dmzPattern.test(content);
    });

    this.logger.log(
      `[${config.id}] DMZ 검수: ${scraperData.length}건 수집 → ${filtered.length}건 통과`,
    );

    return { configId: config.id, data: filtered };
  }

  /**
   * 단일 URL을 최대 MAX_PAGE만큼 순회하며 스크랩
   */
  private async scrapeUrl(
    url: string,
    steps: any[],
    configId: any,
    webhook = true,
  ): Promise<any[]> {
    console.log('scrapeUrl-ID : ', configId);

    const context: BrowserContext = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const page: Page = await context.newPage();
    const results: any[] = [];

    // 페이징 스텝이 정의되어 있는지 확인
    const hasPagingStep = steps.some((s) => s.type === 'paging');

    try {
      // 2) 실제 탐색 시도 (DOMContentLoaded + networkidle 병행 대기)
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 50000 });
      } catch (e) {
        console.error('Navigation failed:', (e as Error).message);
      }

      let currentPage = 1;
      outer: while (true) {
        let detailUrls: string[] = [];

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
                detailUrls = await this.pageNavigationService.extractDetailUrls(page, step, current, configId, webhook);
              } else {
                detailUrls = await this.pageNavigationService.extractDetailUrls_0611(page, step, configId, webhook);
              }
              break;

            case 'scrapDetail':
              // 리스트 페이지에서 '-list' 타겟 데이터 미리 추출
              const listTargets = (step.params.targets || []).filter(
                (t) => t.name.endsWith('-list'),
              );
              const listDataArray: Record<string, string>[] = [];
              if (listTargets.length > 0) {
                for (const lt of listTargets) {
                  const values = await page.$$eval(lt.selector, (els) =>
                    els.map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()),
                  );
                  values.forEach((val, i) => {
                    if (!listDataArray[i]) listDataArray[i] = {};
                    // 'writer-list' → 'writer'로 저장
                    const baseName = lt.name.replace(/-list$/, '');
                    listDataArray[i][baseName] = val;
                  });
                }
              }

              const scrapResults = await this.scrapeDetails(
                detailUrls,
                step,
                configId,
                listDataArray,
                webhook,
              );
              if (Array.isArray(scrapResults)) {
                results.push(...scrapResults);
              } else if (scrapResults) {
                results.push(scrapResults);
              }
              break;

            case 'paging':
              if (currentPage >= this.MAX_PAGE) break outer;
              let hasNext = null;
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

        // 페이징 스텝이 없으면 첫 페이지만 수행 후 종료
        if (!hasPagingStep) break outer;
      }

      return results;
    } finally {
      await page.close();
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

  // IGI 적재 크롤러에 맞는 Response 형식으로 변환
  async changeNkinfoForm(
    targets: {
      data: Record<string, any>;
      id: number;
      createdAt: Date;
      configId: number;
    }[],
  ) {
    const res: Article[] = [];

    for (const { data, createdAt } of targets) {
      // if (Array.isArray(data)) {
      const obj = data as Record<string, any>;
      // 3) 이제 각 요소에서 마음껏 키 접근 가능
      // for (const obj of arr) {
      const article = new Article();

      article.title = obj.title || '';
      article.writer = obj?.author || obj?.writer || '';
      article.writer = article.writer.replace(/기자명\s*/g, '').trim();
      // const todayStr = format(new Date(), 'yyyyMMdd');
      article.writedate =
        (obj?.writedate as string) || format(`${createdAt}`, 'yyyyMMdd');
      // article.writedate = (obj?.writedate as string) || '';
      article.cururl = (obj?.currentUrl as string) || '';
      article.content = (obj?.content as string) || '';
      article.cdatetime = format(`${createdAt}`, 'yyyy-MM-dd HH:mm:ss.sss');

      // 이미지 변환
      if (obj?.img) {
        for (const img of obj?.img) {
          // img 자체가 배열인 경우에는 그냥 다음으로
          if (Array.isArray(img)) continue;
          // 그 외에 url 이 없으면 skip
          if (!img?.url) continue;

          const base64 = await this.s3Service.imgLinkToBase64WithS3Key(
            img.s3Path,
          );
          // imgLinkToBase64WithStream(
          //   img.url,
          // );
          article.images?.push(base64);
          article.imgurl.push(img.url);
          article.imgCaptions?.push(img?.caption ?? '');
        }
      }

      if (obj?.file) {
        article.pdfFiles = [];
        for (const file of obj?.file) {
          article.pdfFiles?.push(file?.s3Path);
        }
        // article.pdfFiles?.push(obj?.file?.s3Path);
      }
      article.pdfPath = '';

      res.push(article);
    }
    // } else {
    // data가 배열이 아니면 건너뛰거나 기본 처리
    // console.warn(`Unexpected data shape for id=${id}`, data);
    // }
    // }
    return res;
  }

}
