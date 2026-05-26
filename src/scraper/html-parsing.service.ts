import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { Page, Frame } from 'playwright';

@Injectable()
export class HtmlParsingService {
  private readonly logger = new Logger(HtmlParsingService.name);

  /**
   * DOM 요소에서 텍스트를 추출한다.
   * table, inline 태그, block 태그를 구분하여 구조화된 텍스트를 반환하며,
   * style 태그 등 불필요한 요소는 제외한다.
   */
  async exportDuplicatedText(
    page: Page | Frame,
    selector: string,
  ): Promise<string> {
    const paras = await page.$$eval<string>(
      selector,
      (containers: Element[]) => {
        const lines: string[] = [];

        const getTableData = (tableEl: HTMLTableElement): string => {
          const headers = Array.from(tableEl.querySelectorAll('thead th')).map(
            (th) => th.textContent?.trim() || '',
          );
          const rows = Array.from(tableEl.querySelectorAll('tbody tr')).map(
            (tr) =>
              Array.from(tr.querySelectorAll('td'))
                .map((td) => td.textContent?.trim() || '')
                .join(' '),
          );
          return [headers.join(' '), ...rows].join('\n');
        };

        function extractText(n: Node): string[] {
          if (n.nodeType === Node.TEXT_NODE) {
            const t = n.textContent
              ?.replace(/[\r\n\t]+/g, ' ')
              .replace(/ {2,}/g, ' ')
              .trim();
            return t ? [t] : [];
            // return t ? [`${t}\n`] : [];
          }
          if (n instanceof HTMLBRElement) return ['\n'];
          if (n instanceof HTMLTableElement)
            return ['\n', getTableData(n), '\n'];
          if (n instanceof Element) {
            const tag = n.tagName.toLowerCase();
            // 1) <style> 태그 무시
            if (tag === 'style') {
              return [];
            }
            // return Array.from(n.childNodes).flatMap(extractText);
            const inlineTags = [
              'span',
              'a',
              'em',
              'strong',
              'b',
              'i',
              'u',
              'small',
              'label',
              'abbr',
              'cite',
              'q',
              'sub',
              'sup',
              'code',
              'time',
            ];
            // const tag = n.tagName.toLowerCase();
            const children = Array.from(n.childNodes).flatMap(extractText);
            // 인라인이면 그대로, 아니면 앞뒤 줄바꿈
            return inlineTags.includes(tag)
              ? children
              : ['\n', ...children, '\n'];
          }
          return [];
        }

        for (const container of containers) {
          if (container.tagName.toLowerCase() === 'table') {
            lines.push(getTableData(container as HTMLTableElement));
            continue;
          }

          const parts = Array.from(container.childNodes).flatMap(extractText);
          if (parts.length) {
            lines.push(parts.join(' '));
          }
        }

        // return lines.join('\n');
        return lines.join('\n\n').trim();
      },
    );

    return paras;
  }

  /**
   * DOM 요소에서 화면에 보이는 텍스트만 추출한다.
   * display:none, visibility:hidden, opacity:0인 요소는 제외하며,
   * script/style 태그도 무시한다.
   * exportDuplicatedText와 달리 visibility 체크가 포함되어 있다.
   */
  async exportVisibleText(
    page: Page,
    selector: string,
  ): Promise<string> {
    const paras = await page.$$eval<string>(
      selector,
      (containers: Element[]) => {
        const lines: string[] = [];

        const isVisible = (el: Element): boolean => {
          const style = window.getComputedStyle(el);
          if (style.display === 'none') return false;
          if (style.visibility !== 'visible') return false;
          if (parseFloat(style.opacity) === 0) return false;
          return true;
        };

        const getTableData = (tableEl: HTMLTableElement): string => {
          const headers = Array.from(
            tableEl.querySelectorAll('thead th'),
          ).map((th) => th.textContent?.trim() || '');
          const rows = Array.from(
            tableEl.querySelectorAll('tbody tr'),
          ).map((tr) =>
            Array.from(tr.querySelectorAll('td'))
              .map((td) => td.textContent?.trim() || '')
              .join(' '),
          );
          return [headers.join(' '), ...rows].join('\n');
        };

        function extractText(n: Node): string[] {
          if (n.nodeType === Node.TEXT_NODE) {
            const t = n.textContent
              ?.replace(/[\r\n\t]+/g, ' ')
              .replace(/ {2,}/g, ' ')
              .trim();
            return t ? [t] : [];
          }
          if (!(n instanceof Element)) return [];
          if (
            n instanceof HTMLScriptElement ||
            n instanceof HTMLStyleElement
          ) {
            return [];
          }
          // 화면에 보이는 요소인지 체크
          if (
            !isVisible(n as HTMLElement) ||
            !(n as HTMLElement).offsetParent
          ) {
            return [];
          }
          if (n instanceof HTMLBRElement) return ['\n'];
          if (n instanceof HTMLTableElement)
            return ['\n', getTableData(n), '\n'];
          if (n instanceof Element) {
            const tag = n.tagName.toLowerCase();
            if (tag === 'style' || tag === 'script') {
              return [];
            }
            const inlineTags = [
              'span',
              'a',
              'em',
              'strong',
              'b',
              'i',
              'u',
              'small',
              'label',
              'abbr',
              'cite',
              'q',
              'sub',
              'sup',
              'code',
              'time',
            ];
            const children = Array.from(n.childNodes).flatMap(
              extractText,
            );
            return inlineTags.includes(tag)
              ? children
              : ['\n', ...children, '\n'];
          }
          return [];
        }

        for (const container of containers) {
          if (container.tagName.toLowerCase() === 'table') {
            lines.push(getTableData(container as HTMLTableElement));
            continue;
          }

          const parts = Array.from(container.childNodes).flatMap(
            extractText,
          );
          if (parts.length) {
            lines.push(parts.join(' '));
          }
        }

        return lines.join('\n\n').trim();
      },
    );

    return paras;
  }

  /**
   * iframe 내부 콘텐츠에서 텍스트를 추출한다.
   * congress.gov 등 iframe 기반 페이지에서 사용되며,
   * 외부 iframe(crsProductIframe)에 접근하여 셀렉터로 텍스트를 가져온다.
   */
  async extractParagraphs(page: Page, selector: string): Promise<string> {
    // 1) outer iframe
    const outer = await page.waitForSelector('iframe#crsProductIframe', {
      timeout: 10000,
    });
    const outerFrame = await outer.contentFrame();
    if (!outerFrame) throw new Error('첫 번째 iframe 읽기 실패');

    // // 2) inner iframe
    // const inner = await outerFrame.waitForSelector(
    //   'iframe#dext5_design_dext5editor',
    //   { timeout: 10000 },
    // );
    // const innerFrame = await inner.contentFrame();
    // if (!innerFrame) throw new Error('두 번째 iframe 읽기 실패');ㄴ

    // 3) 요소가 실제 붙을 때까지
    await outerFrame.waitForSelector(selector, { timeout: 5000 });

    // 4) 디버깅용 count
    const count = await outerFrame.locator(selector).count();
    console.log(`▶ selector="${selector}", found count=`, count);

    // 5) 기존 map/filter
    // const paras = await outerFrame.$$eval(selector, (els) =>
    //   els
    //     .map((el) =>
    //       (el.textContent || '')
    //         .replace(/[\r\n\t]+/g, ' ')
    //         .replace(/ {2,}/g, ' ')
    //         .trim(),
    //     )
    //     .filter(Boolean),
    // );
    const paras = await this.exportDuplicatedText(outerFrame, selector);

    if (paras.length === 0) {
      throw new Error(`텍스트 추출 실패 (empty paras): ${selector}`);
    }

    return paras;
  }

  /**
   * HTML에서 불필요한 요소를 제거하고 정리된 HTML을 반환한다.
   * script, style, cookie 배너, 광고, 빈 태그 등을 제거하며,
   * 긴 텍스트를 truncate하고 공백을 정규화한다.
   *
   * @param isHard - true이면 미디어 요소(img, video 등)를 유지, false이면 제거
   */
  async getCleanHtml(html: string, isHard): Promise<string> {
    // Cheerio로 로드 후 불필요한 요소 제거
    const $ = cheerio.load(html);
    $(
      'script, style, noscript, iframe, header, footer, nav, aside, meta',
    ).remove();

    $(
      '[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], [class*="gtm"], [id*="gtm"]',
    ).remove();

    // isHard가 true면 미디어 요소도 제거
    if (!isHard) {
      $('img, video, audio, picture, source, object, embed, canvas').remove();
    }

    // 2. 빈 태그 제거
    $('*').each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      if (!text && $el.children().length === 0) {
        $el.remove();
      }
    });

    $('*')
      .contents()
      .each((_, node) => {
        if (node.type === 'comment') {
          $(node).remove();
        }
      });

    $('*').each((_, el) => {
      // 중요한 속성이 아니라면 제거 (예: style, onclick, id, class 등)
      $(el).removeAttr('style');
    });

    // br 정리
    $('br + br').remove();

    // &nbsp; 텍스트 정리
    $('*')
      .contents()
      .each((_, node) => {
        if (node.type === 'text') {
          const clean = $(node)
            .text()
            .replace(/\u00a0/g, '')
            .trim();
          if (!clean) $(node).remove();
        }
      });

    // 빈 블록 태그 제거
    ['p', 'div', 'section', 'article'].forEach((tag) => {
      $(tag).each((_, el) => {
        const $el = $(el);
        if (
          $el.text().trim() === '' &&
          $el.find('img, iframe, video').length === 0
        ) {
          $el.remove();
        }
      });
    });

    // p 태그 등 본문 영역 내 텍스트가 너무 길면 줄이는 로직
    const MAX_P_LENGTH = 100; // 각 p 태그 내 최대 문자 수. 필요에 따라 조정
    $('p').each((_, el) => {
      const fullText = $(el).text().trim();
      if (fullText.length > MAX_P_LENGTH) {
        const shortenedText = fullText.substring(0, MAX_P_LENGTH) + ' ...';
        $(el).text(shortenedText);
      }
    });

    // html 후처리
    let cleanedHtml = $('body').html() ?? '';
    cleanedHtml = cleanedHtml
      .replace(/\s{2,}/g, ' ')
      .replace(/(\n\s*){2,}/g, '\n')
      .trim();

    cleanedHtml = cleanedHtml
      .replace(/\s{2,}/g, ' ')
      .replace(/(\r\n|\n|\r)/gm, ' ') // 모든 줄바꿈을 공백으로 변환
      .trim();

    return cleanedHtml;
  }
}
