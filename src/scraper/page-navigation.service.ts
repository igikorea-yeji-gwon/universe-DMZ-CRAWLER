import { Injectable, Logger } from '@nestjs/common';
import { Page } from 'playwright';

@Injectable()
export class PageNavigationService {
  private readonly logger = new Logger(PageNavigationService.name);

  /**
   * 목록 페이지에서 상세 페이지 URL을 추출한다.
   * onclick, javascript:, href 속성을 분석하여 URL을 수집하며,
   * POST 요청 추적을 통해 동적으로 생성되는 URL도 감지한다.
   * koreaexim, kida, kndu 등 특수 사이트에서 사용한다.
   */
  async extractDetailUrls(
    page: Page,
    step: any,
    url: string,
    configId?: any,
    webhook = true,
  ): Promise<string[]> {
    try {
      await page.waitForSelector(step.params.selector, {
        state: 'attached',
        timeout: 29000,
      });
    } catch (e) {
      this.logger.warn(
        `[${configId ?? '?'}] 리스트 셀렉터 타임아웃: selector=${step.params.selector} url=${page.url()} error=${(e as Error).message}`,
      );
      throw e;
    }

    const u = new URL(url);

    const rawVals: string[] = await page.$$eval(
      step.params.selector,
      (els, attr) => els.map((el) => el.getAttribute(attr) || ''),
      step.params.attribute === 'javascript' ? 'href' : step.params.attribute,
    );

    console.log('rawVals', rawVals);

    const detailUrls: string[] = [];

    for (const val of rawVals) {
      const startUrl = page.url();

      // POST 및 NAVIGATION 대기 프라미스 정의
      const postPromise = page.waitForRequest(
        (req) => req.method() === 'POST',
        // &&
        // req.url().includes('frtNormalBoardDetail.do'),
      );
      const navPromise = page.waitForNavigation({
        waitUntil: 'domcontentloaded',
      });
      const racePromise = Promise.race([
        postPromise.then((req) => ({ type: 'post', req })),
        navPromise.then(() => ({ type: 'nav' })),
      ]);

      // 클릭 트리거 정의
      let trigger: () => Promise<unknown>;
      if (step.params.attribute === 'onclick') {
        trigger = async () => {
          const cleaned = val.replace(/^javascript:\s*/, '').replace(/;$/, '');
          const [, fnName, argsString] =
            cleaned.match(/^([\w$]+)\((([\s\S]*)?)\)$/) || [];
          const args = argsString
            ? argsString
                .split(/,(?=(?:[^']*'[^']*')*[^']*$)/)
                .map((arg) => arg.trim().replace(/^'(.*)'$/, '$1'))
            : [];
          return page.evaluate(
            ({ name, params }) => (window as any)[name](...params),
            { name: fnName, params: args },
          );
        };
      } else if (step.params.attribute === 'javascript') {
        trigger = () => {
          const callString = val.replace(/^javascript:/, '').replace(/;$/, '');
          return page.evaluate(callString);
        };
      } else {
        trigger = () => {
          // jsessionid 포함된 URL 처리
          if (val.includes('/;jsessionid=')) {
            let cleaned = val.replace(/^\/;jsessionid=[^/]+\//, '/');
            if (cleaned.startsWith('/board.do?boardId=f')) {
              cleaned = '/board' + cleaned;
            }
            const parsed = new URL(page.url());
            const baseOrigin = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
            const hrefUrl = new URL(cleaned, baseOrigin).toString();
            return page.goto(hrefUrl, { waitUntil: 'domcontentloaded' });
          }
          // 일반 href 이동
          const href = val.startsWith('http')
            ? val
            : new URL(val, page.url()).toString();
          return page.goto(href, { waitUntil: 'domcontentloaded' });
        };
      }

      // 트리거 실행 및 race 감시
      const triggerPromise = trigger();
      const result = await racePromise;
      await triggerPromise;

      // URL 생성
      let detailUrl: string;
      if (result.type === 'post' && 'req' in result) {
        const rawData = result.req.postData() || '';
        const params = new URLSearchParams(rawData);
        const url = result.req.url();
        if (url.includes(u.origin)) {
          detailUrl = `${url}?${params.toString()}`;
        } else {
          detailUrl = page.url();
        }
      } else {
        detailUrl = page.url();
      }
      console.log('??detailUrl: ', detailUrl);

      detailUrls.push(detailUrl);

      // 이전 페이지 복귀
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    }

    return detailUrls;
  }

  /**
   * 목록 페이지에서 상세 페이지 URL을 추출한다 (개선 버전).
   * onclick 함수명에 점(.) 표기법(예: article.view)을 지원하며,
   * 법무부 검색 페이지의 예외 필터링을 포함한다.
   * 일반 href의 경우 직접 이동 없이 URL을 생성하여 더 빠르게 동작한다.
   */
  async extractDetailUrls_0611(
    page: Page,
    step: any,
    configId?: any,
    webhook = true,
  ): Promise<string[]> {
    const url = page.url();

    // keia.org: AJAX 기반 검색 결과 페이지 - networkidle이 AJAX 요청 전에 resolve될 수 있어 추가 대기
    if (url.includes('keia.org')) {
      await page
        .waitForLoadState('networkidle', { timeout: 30000 })
        .catch(() => {});
    }

    try {
      await page.waitForSelector(step.params.selector, {
        state: 'attached',
        timeout: 29000,
      });
    } catch (e) {
      // 페이지네이션 후 결과 없는 페이지거나 마지막 페이지일 수 있음 → 빈 배열 반환
      this.logger.warn(
        `[${configId ?? '?'}] 리스트 셀렉터 없음 (결과 없음 또는 페이지 끝): ${url}`,
      );
      return [];
    }

    let rawVals: string[];
    let elementHrefs: string[] = [];

    // 'javascript' 플래그인 경우 실제로는 href 속성에서 값을 가져와야 합니다.
    if (step.params.attribute === 'javascript') {
      rawVals = await page.$$eval(step.params.selector, (els) =>
        els.map((el) => el.getAttribute('href') || ''),
      );
    } else {
      // onclick, data-* 또는 일반 href
      rawVals = await page.$$eval(
        step.params.selector,
        (els, attr) => els.map((el) => el.getAttribute(attr) || ''),
        step.params.attribute,
      );
    }

    // onclick에서 this.href 치환을 위해 요소의 실제 resolved href 수집
    if (step.params.attribute === 'onclick') {
      elementHrefs = await page.$$eval(step.params.selector, (els) =>
        els.map(
          (el) =>
            (el as HTMLAnchorElement).href || el.getAttribute('href') || '',
        ),
      );
    }

    console.log('rawVals2', rawVals);

    if (url.includes('https://search-home.moj.go.kr/search.jsp')) {
      const ExceptionList = [
        '/moj/182/',
        '/moj/271/',
        '/moj/154/',
        '/corrections/483/',
      ];
      rawVals = rawVals.filter((raw) =>
        ExceptionList.some((include) => raw.includes(include)),
      );
      console.log('newrawVals', rawVals);
    }
    const detailUrls: string[] = [];

    for (let i = 0; i < rawVals.length; i++) {
      const val = rawVals[i];
      if (step.params.customTransform) {
        const { pattern, output } = step.params.customTransform;
        const transformed = val.replace(
          new RegExp(pattern),
          (_match, ...groups) =>
            output.replace(
              /\$\{(\d+)\}/g,
              (_: string, n: string) => groups[parseInt(n) - 1] ?? '',
            ),
        );
        const hrefUrl = transformed.startsWith('http')
          ? transformed
          : new URL(transformed, url).toString();
        detailUrls.push(hrefUrl);
      } else if (step.params.attribute === 'onclick') {
        const cleaned = val
          .replace(/^javascript:\s*/, '')
          .replace(/\s*;\s*return false;?$/, '')
          .replace(/;$/, '');

        const m = cleaned.match(/^([\w$.]+)\(([^)]*)\)$/) || [];
        const fnName = m[1];
        const argsString = m[2];

        const resolvedHref = elementHrefs[i] || '';
        const args = argsString
          ? argsString.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map((arg) => {
              const trimmed = arg.trim().replace(/^'(.*)'$/, '$1');
              // this.href → 요소의 실제 href로 치환
              return trimmed === 'this.href' ? resolvedHref : trimmed;
            })
          : [];

        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
          page.evaluate(
            ({ name, params }) => {
              // "article.view" → ["article","view"]
              const parts = name.split('.');
              // window['article']['view']
              let fn: any = window;
              for (const p of parts) {
                fn = fn?.[p];
              }
              if (typeof fn !== 'function') {
                throw new Error(`No such function: ${name}`);
              }
              return fn(...params);
            },
            { name: fnName, params: args },
          ),
        ]);
        detailUrls.push(page.url());
        await page.goBack({ waitUntil: 'domcontentloaded' });
      } else if (step.params.attribute === 'javascript') {
        // 1) "javascript:fn_detailSearch(103, 110387, 1);" → "fn_detailSearch(103, 110387, 1)"
        const callString = val
          .replace(/^javascript:/, '') // 접두사 제거
          .replace(/;$/, ''); // 마침 세미콜론 제거(optional)

        // 2) 클릭과 동시에 네비게이션 대기
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
          page.evaluate(callString), // window.fn_detailSearch(…) 호출됨
        ]);
        console.log('page.url()', page.url());

        // 3) URL 저장 후 뒤로 가기
        detailUrls.push(page.url());
        await page.goBack({ waitUntil: 'domcontentloaded' });
      } else {
        if (val.includes('/;jsessionid=')) {
          try {
            let cleaned = val.replace(/^\/;jsessionid=[^/]+\//, '/');
            if (cleaned.startsWith('/board.do?boardId=f')) {
              cleaned = '/board' + cleaned;
            }

            const parsed = new URL(page.url());
            const baseOrigin = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;

            // 4) 절대 URL 생성
            const hrefUrl = new URL(cleaned, baseOrigin).toString();

            // 5) 이동 후 순수 hrefUrl 저장
            await page.goto(hrefUrl, { waitUntil: 'domcontentloaded' });
            detailUrls.push(hrefUrl);
            await page.goBack({ waitUntil: 'domcontentloaded' });
          } catch (error) {
            console.log('fail page.goto', error);
          }
        } else {
          try {
            const hrefUrl = val.startsWith('http')
              ? val
              : new URL(val, page.url()).toString();
            // 65번 떄문에 검증 변경
            detailUrls.push(hrefUrl);
            // await page.goto(hrefUrl, { waitUntil: 'domcontentloaded' });
            // detailUrls.push(page.url());
            // await page.goBack({ waitUntil: 'domcontentloaded' });
          } catch (error) {
            console.log('fail page.goto', error);
          }
        }
      }
    }
    return detailUrls;
  }

  /**
   * ME.go.kr 보도자료/게시판 전용 페이지네이션.
   * 3가지 전략을 순서대로 시도한다:
   * 1) go_Page(n) 함수 직접 호출
   * 2) 숫자 링크 직접 클릭
   * 3) pagerOffset 쿼리 파라미터 방식
   */
  // ME.go.kr 보도자료/게시판 전용: go_Page 기반 단순 페이징
  async clickNext_ME(
    page: Page,
    currentPage: number,
    linkSelector: string,
  ): Promise<boolean> {
    const nextNum = currentPage + 1;

    // 1) go_Page(n) 직접 호출
    const hasGo = await page.evaluate(
      () => typeof (window as any).go_Page === 'function',
    );
    if (hasGo) {
      await page.evaluate((n) => (window as any).go_Page(n), nextNum);

      // 🔧 B안: Locator 기반 대기 (추천)
      await page
        .locator(`${linkSelector}.on`)
        .filter({ hasText: String(nextNum) })
        .first()
        .waitFor({ state: 'visible', timeout: 10_000 });

      return true;
    }

    // 2) 숫자 링크 직접 클릭 (.on 제외)
    const link = page
      .locator(`${linkSelector}:not(.on)`)
      .filter({ hasText: String(nextNum) })
      .first();
    if (await link.count()) {
      await link.scrollIntoViewIfNeeded();
      await link.click();

      await page
        .locator(`${linkSelector}.on`)
        .filter({ hasText: String(nextNum) })
        .first()
        .waitFor({ state: 'visible', timeout: 10_000 });

      return true;
    }

    // 3) 폴백: pagerOffset 방식
    try {
      const url = new URL(page.url());
      const sp = url.searchParams;
      const max = parseInt(sp.get('maxPageItems') ?? '10', 10) || 10;
      sp.set('pagerOffset', String((nextNum - 1) * max));

      await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      await page
        .locator(`${linkSelector}.on`)
        .filter({ hasText: String(nextNum) })
        .first()
        .waitFor({ state: 'visible', timeout: 10_000 });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * 범용 다음 페이지 이동 처리.
   * 다양한 사이트 구조에 대응하기 위해 여러 전략을 순서대로 시도한다:
   * 1) URL 파라미터(page, pageIndex, pg, _page) 증가
   * 2) 다양한 CSS/XPath 셀렉터 순회
   * 3) 최종 폴백: linkSelector의 n번째 요소 직접 클릭
   */
  async clickNext(
    page: Page,
    currentPage: number,
    linkSelector: string,
  ): Promise<boolean> {
    const nextNum = currentPage + 1;

    try {
      const currentUrl = new URL(page.url());
      const params = currentUrl.searchParams;

      // page 또는 pageIndex 중 우선순위로 하나를 선택
      const rawPage = params.get('page');
      const rawPageIndex = params.get('pageIndex');
      const rawPg = params.get('pg');
      const _page = params.get('_page');
      const rawNowPage = params.get('nowPage');

      if (
        rawPage !== null ||
        rawPageIndex !== null ||
        rawPg !== null ||
        _page !== null ||
        rawNowPage !== null
      ) {
        const base = rawPage ?? rawPageIndex ?? rawPg ?? _page ?? rawNowPage!;
        const parsed = parseInt(base, 10);

        if (!isNaN(parsed)) {
          const next = parsed + 1;

          // 원본 키에 맞춰 다시 세팅
          if (rawPage !== null) {
            params.set('page', String(next));
          }
          if (rawPageIndex !== null) {
            params.set('pageIndex', String(next));
          }
          if (rawPg !== null) {
            params.set('pg', String(next));
          }
          if (_page !== null) {
            params.set('_page', String(next));
          }
          if (rawNowPage !== null) {
            params.set('nowPage', String(next));
          }

          const nextUrl = currentUrl.toString();
          console.log('url 변경 이동 Next 버튼 클릭 전 URL:', page.url());
          await page.goto(nextUrl, {
            waitUntil: 'networkidle',
            timeout: 30_000,
          });
          console.log('url 변경 이동 Next 버튼 클릭 전 URL:', page.url());
          return true;
        }
      }
    } catch {
      // parsing 실패 시 다음 전략으로
    }

    // 1) 새로운 Pagination 구조용 XPath 전략 (div.pagination)
    const xpathActiveSibling = `xpath=//div[contains(@class,"pagination")]//ul//li[a[contains(@class,"active")]]/following-sibling::li[1]/a`;

    // 2) 기존 + 새로 추가된 모든 전략별 셀렉터 리스트
    const selectors = [
      // A-0) 전달받은 pagination 컨테이너 내부에서 먼저 찾는다.
      `${linkSelector} a[keyvalue="${nextNum}"]`,
      `${linkSelector} a.pager-link-data-next`,
      `${linkSelector} a[href*="pageIndex=${nextNum}"]`,
      `${linkSelector} li.on + li a`,
      `${linkSelector} .active + a`,
      `${linkSelector} a.active + a`,
      // 국방부(mnd.go.kr) 등 '_paging' 구조: 현재 페이지가 클래스 없는 <strong>이고
      // 다음 버튼이 a._listNext (href="javascript:page_link('N')")
      `${linkSelector} a._listNext`,

      // A) keyvalue 속성 기반 (예전 구조)
      `${linkSelector}[keyvalue="${nextNum}"]`,

      // B) 클래스 기반 "다음" 버튼 (예전 구조)
      `${linkSelector}.next`,

      // C) 클래스 기반 "다음 페이지" (새로운 구조)
      `${linkSelector}.next_page`, // ex. <a class="next_page" …>
      `div.pagination a.next_page`, // 직접 container 기반

      // D) 범용 "다음" 버튼 (예전/여러 케이스 혼합)
      'li.next a, a.next, button.btn-paging-next, button.btn-paging-pre + a',

      // E) "활성 요소(클래스 active 또는 on)의 다음 형제 a" (예전 구조)
      'li.on + li a, .active + a, a.on + a',

      // F) 새로운 구조: <li><a class="active">…</a></li> 뒤의 <li><a>…</a></li> 클릭
      xpathActiveSibling,

      // (G) 실제 "다음(>)" 버튼에 대응하는 클래스
      'tfoot tr.pp-pagenumber td a.btn-pg-arrow.btn-pg-arrow-next',

      // (H) 혹시 "버튼" 태그로 바뀐 경우
      'tfoot tr.pp-pagenumber td button.btn-pg-arrow-next',

      // (I) 마지막 페이지 버튼(>>)
      'tfoot tr.pp-pagenumber td a.btn-pg-arrow-last',
    ];

    for (const sel of selectors) {
      const handle = page.locator(sel).first();
      if (await handle.count()) {
        // url 예외처리
        if (!page.url().includes('inss.re.kr')) {
          // 클릭 전에 화면에 보이도록 스크롤
          // await handle.scrollIntoViewIfNeeded();
          // 클릭과 동시에 네트워크 idle 상태를 기다립니다.
          try {
            console.log('1번쨰 Next 버튼 클릭 전 URL:', page.url());
            const beforeUrl = page.url();
            await Promise.all([
              handle.click(),
              page.waitForLoadState('networkidle', { timeout: 30_000 }),
            ]);
            // 일부 사이트(mnd 등)는 클릭 후 form POST 내비게이션이 늦게 시작돼
            // networkidle이 먼저 풀린다. URL이 그대로면 늦은 내비게이션을 조금 더 기다린다.
            // (AJAX 페이징이라 URL이 원래 안 바뀌는 사이트는 7초 대기 후 그대로 진행)
            if (page.url() === beforeUrl) {
              await page
                .waitForNavigation({
                  waitUntil: 'domcontentloaded',
                  timeout: 7_000,
                })
                .catch(() => {});
              await page
                .waitForLoadState('networkidle', { timeout: 10_000 })
                .catch(() => {});
            }
            console.log('1번쨰 Next 버튼 클릭 후 URL:', page.url());
            return true;
          } catch (error) {
            console.warn(
              `전략 ${sel} 실패, 다음으로 넘어갑니다:`,
              (error as Error).message,
            );
          }
        }
      }
    }

    // 최종 전략: 순서대로 클릭
    const handles = await page.locator(linkSelector).elementHandles();
    const idx = nextNum - 1;

    if (handles.length > idx) {
      console.log('2번쨰 Next 버튼 클릭 전 URL:', page.url());
      await Promise.all([
        handles[idx].click(),
        page.waitForLoadState('networkidle', { timeout: 30_000 }),
      ]);
      console.log('2번쨰 Next 버튼 클릭 후 URL:', page.url());
      return true;
    }

    return false;
  }
}
