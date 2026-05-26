import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import moment from 'moment';
import { parse, format, isValid } from 'date-fns';
import { enUS, ko } from 'date-fns/locale';
import { GeminiAnalyzerService } from 'src/common/utils/geminiAnalyze/gemini-analyzer.service';
import { fileInterface, imgInterface } from 'src/news/news.entity';

interface Field {
  fieldType: string;
  selector?: string;
  imgSelector?: string;
  captionSelector?: string;
  srcReplace?: Record<string, string>;
  attribute?: string;
  customTransform?: {
    type: string;
    pattern: string;
    output: string;
  };
}

type FieldProcessor = (
  field: Field,
  $: cheerio.CheerioAPI,
  baseUrl?: string,
) => any;

@Injectable()
export class ProcessService {
  constructor(private geminiAnalyzerService: GeminiAnalyzerService) {}

  private processList(field: Field, $: cheerio.CheerioAPI): string[] {
    const detailLinks = $(`${field.selector}`)
      .map((i, el) => {
        const linkEl = $(el).is('a') ? $(el) : $(el).find('a');
        return linkEl.attr('href');
      })
      .get();

    return detailLinks;
  }

  private processPaging(field: Field, $: cheerio.CheerioAPI): string {
    console.log('$', $);
    return `Processed paging: ${field.fieldType}`;
  }

  private processPageNext(field: Field, $: cheerio.CheerioAPI): string {
    console.log('$', $);
    return `Processed pageNext:${field.fieldType}`;
  }

  private processTitle(field: Field, $: cheerio.CheerioAPI): string {
    const title = $(field.selector).text().trim();
    return title;
  }

  private processAuthorv2(field: Field, $: cheerio.CheerioAPI): string {
    const author = $(field.selector)
      .clone() // 요소 복사
      .children() // 자식 요소 선택
      .remove() // 자식 요소 제거
      .end() // 복사본 복귀
      .text() // 텍스트 추출
      .trim(); // 공백 제거
    return author;
  }
  private processAuthor(field: Field, $: cheerio.CheerioAPI): string {
    let author = $(field.selector)
      .find('a')
      .map((_, el) => $(el).text().trim())
      .get()
      .join(', ');
    if (!author) {
      author = this.processAuthorv2(field, $);
    }
    return author || '작성자 미표기';
  }

  private async processWritedate(
    field: Field,
    $: cheerio.CheerioAPI,
  ): Promise<string> {
    let writedate = $(field.selector).text().trim();
    if (writedate) writedate = await this.formatDate(writedate);
    if (!writedate) {
      const html = $.html();
      const match = html.match(
        /<p[^>]*class="article-meta__publish-date"[^>]*>(.*?)<\/p>/,
      );
      if (match) writedate = match[1].trim();
    }
    return writedate || '00000000';
  }

  private processContent(field: Field, $: cheerio.CheerioAPI): string {
    const content = $(field.selector);

    let articleText = '';
    content.each((i, ele) => {
      articleText += $(ele).text().trim() as string;
      articleText += '\n';
    });

    return articleText;
  }

  private async processThumbnail(
    field: Field,
    $: cheerio.CheerioAPI,
  ): Promise<imgInterface[]> {
    const images = $(field.selector);
    let imgData: imgInterface[] = [];

    if (images.toArray().length > 0) {
      const imagePromises = images.toArray().map(async (ele) => {
        const img = $(ele);
        let src = img.attr('src') as string;
        if (src) {
          src = src.replace('_w250_', '_w1597_');
          return {
            imgString: '',
            imgurl: src,
          };
        }
      });
      const results = await Promise.all(imagePromises);
      imgData = results.filter((r) => r);
    }

    return imgData;
  }

  private async processImg(
    field: Field,
    $: cheerio.CheerioAPI,
  ): Promise<imgInterface[]> {
    const images = $(field.selector);
    let imgData: imgInterface[] = [];

    if (images.toArray().length > 0) {
      const imagePromises = images.toArray().map(async (ele) => {
        const img = $(ele);
        let src = img.attr('src') as string;
        if (src) {
          src = src.replace(field.srcReplace.old, field.srcReplace.new);
          return {
            imgString: null,
            // await this.imgLinkToBase64WithStream(src),
            imgurl: src,
          };
        }
      });
      const results = await Promise.all(imagePromises);
      imgData = results.filter((r) => r);
    }

    return imgData;
  }
  // private async processImg(
  //   field: Field,
  //   $: cheerio.CheerioAPI,
  // ): Promise<imgInterface[]> {
  //   const images = $(field.selector);
  //   const imgData: imgInterface[] = [];

  //   if (images.length > 0) {
  //     const imagePromises = images.toArray().map(async (ele, index) => {
  //       const img = $(ele);
  //       let src = img.attr('src');
  //       if (!src) return null;

  //       // src 변환
  //       src = src.replace(field.srcReplace.old, field.srcReplace.new);

  //       try {
  //         const response = await axios.get(src, {
  //           responseType: 'arraybuffer',
  //         });

  //         const buffer = Buffer.from(response.data);
  //         const contentType =
  //           response.headers['content-type'] || 'application/octet-stream';
  //         const extension = contentType.split('/')[1] || 'jpg';

  //         const s3Url = await this.s3Service.uploadFile({
  //           buffer,
  //           filename: `image_${index}.${extension}`,
  //           mimetype: contentType,
  //         });

  //         return {
  //           imgurl: src,
  //           imgString: s3Url,
  //         };
  //       } catch (err) {
  //         console.warn(`Image fetch failed: ${src}`, err.message);
  //         return null;
  //       }
  //     });

  //     const results = await Promise.all(imagePromises);
  //     return results.filter((r): r is imgInterface => !!r);
  //   }

  //   return imgData;
  // }

  private processImgCaption(field: Field, $: cheerio.CheerioAPI) {
    const imgCaptions = $(field.selector);
    const captions: string[] = imgCaptions.length
      ? imgCaptions.map((i, el) => $(el).text().trim()).get()
      : [];
    return captions;
  }

  private processFile(
    field: Field,
    $: cheerio.CheerioAPI,
    baseUrl: string,
  ): fileInterface[] {
    const fileList: fileInterface[] = $(field.selector)
      .map((_, el) => {
        const attrName = field.attribute || 'href';
        const rawVal = $(el).attr(attrName);
        if (!rawVal) return null;

        let fileUrl: string;

        if (field.customTransform) {
          const { pattern, output } = field.customTransform;
          fileUrl = rawVal.replace(
            new RegExp(pattern),
            (_match: string, ...groups: string[]) =>
              output.replace(
                /\$\{(\d+)\}/g,
                (_: string, n: string) => groups[parseInt(n) - 1] ?? '',
              ),
          );
        } else {
          fileUrl = rawVal;
        }

        const absoluteUrl = fileUrl.startsWith('http') ? fileUrl : baseUrl + fileUrl;

        return {
          filePath: '',
          fileurl: absoluteUrl,
        };
      })
      .get()
      .filter(Boolean);
    console.log('fileList##', fileList);

    return fileList;
  }

  // fieldType별 처리 함수를 맵에 등록
  private fieldProcessors: Record<string, FieldProcessor> = {
    list: this.processList.bind(this),
    paging: this.processPaging.bind(this),
    pageNext: this.processPageNext.bind(this),
    title: this.processTitle.bind(this),
    author: this.processAuthor.bind(this),
    writedate: this.processWritedate.bind(this),
    content: this.processContent.bind(this),
    thumbnail: this.processThumbnail.bind(this),
    img: this.processImg.bind(this),
    imgCaption: this.processImgCaption.bind(this),
    file: this.processFile.bind(this),
  };

  /**
   * 주어진 Field 객체와 HTMLElement(또는 cheerio와 같은 HTML 파서로부터 얻은 요소)를 받아
   * fieldType에 맞는 함수를 실행하여 결과를 반환합니다.
   *
   * @param field - 처리할 필드 정보
   * @param element - 해당 필드를 포함하는 HTML 요소
   * @returns fieldType에 따른 처리 결과
   */
  async processField(
    field: Field,
    $: cheerio.CheerioAPI,
    baseUrl?: string,
  ): Promise<any> {
    const processor = this.fieldProcessors[field.fieldType];
    if (!processor) {
      return null;
      throw new Error(
        `No processor defined for field type: ${field.fieldType}`,
      );
    }
    return processor(field, $, baseUrl);
  }

  cleanDateInput = async (dateInput: string): Promise<string> => {
    dateInput = dateInput.trim(); // 불필요한 공백 제거
    let parsedDate: Date;
    // toLowerCase()를 이용해 AM, PM 모두 동일하게 처리
    if (
      dateInput.toLowerCase().includes('am') ||
      dateInput.toLowerCase().includes('pm')
    ) {
      parsedDate = parse(dateInput, 'MMMM d, yyyy h:mm a', new Date(), {
        locale: enUS,
      });
    } else {
      parsedDate = parse(dateInput, 'MMMM d, yyyy h:mm a', new Date(), {
        locale: enUS,
      });
    }

    if (!isValid(parsedDate)) {
      const match = dateInput.match(
        /(\d{4}[-.]\d{1,2}[-.]\d{1,2}(?:\s+\d{2}:\d{2})?)/,
      );
      return match ? match[0] : dateInput;
    }
    return format(parsedDate, 'yyyy-MM-dd HH:mm', { locale: ko });
  };

  formatDate = async (dateInput: string): Promise<string> => {
    // 날짜 부분만 추출
    const cleanedInput = await this.cleanDateInput(dateInput);

    // 허용할 날짜 포맷 배열
    const formats = [
      'YYYY.M.D', // 예: 2025.3.16
      'YYYY.MM.DD', // 예: 2025.03.25
      'YYYY.MM.D HH:mm', // 예: 2025.3.26 06:56
      'YYYY.MM.DD HH:mm', // 예: 2025.03.26 06:56
      'YYYY-MM-D HH:mm', // 예: 2025.3.26 06:56
      'YYYY-MM-DD HH:mm', // 예: 2025.03.26 06:56
      'MMMM D, YYYY', // 예: March 1, 2025
      'MMMM DD, YYYY', // 예: March 25, 2025
      'MMMM D, YYYY hh:mm A', // 예: March 15, 2025 11:56 AM
      'MMMM DD, YYYY hh:mm A', // 예: March 15, 2025 11:56 AM
      'MMMM D, YYYY h:mm A', // 예: March 15, 2025 11:56 AM
      'MMMM DD, YYYY h:mm A', // 예: March 15, 2025 11:56 AM
      'YYYY-MM-DD', // 2024-04-04
      'dddd, MMMM D, YYYY', // Thursday, January 23, 2025
      'dddd, MMMM DD, YYYY', // Thursday, January  3, 2025 등
    ];

    // 엄격 모드로 파싱 (포맷이 일치하지 않으면 실패)
    const parsedDate = moment(cleanedInput, formats, true);

    if (!parsedDate.isValid()) {
      const aiDate = await this.geminiAnalyzerService.askQuestion(
        `${dateInput} 을 8자리 숫자 형식(YYYYMMDD)으로 변환해줘. 오직 8자리 숫자만 출력하고, 어떤 부가 설명도 하지 마.`,
      );

      return aiDate;
      // throw new Error(`유효하지 않은 날짜 형식입니다: ${cleanedInput}`);
    }
    // yyyyMMdd 형태로 출력
    return parsedDate.format('YYYYMMDD');
  };

  private async askAiForEightDigits(input: string): Promise<string> {
    return this.geminiAnalyzerService.askQuestion(
      `${input} 을 8자리 숫자 형식(YYYYMMDD)으로 변환해줘. 오직 8자리 숫자만 출력하고, 어떤 부가 설명도 하지 마.`,
    );
  }

  public async changeDateForm(dateInput: string): Promise<string> {
    // const trimmed = dateInput.trim();
    // 1) 범위인지 체크해서 종료일만 처리
    const trimmed = dateInput.includes('~')
      ? dateInput.split('~')[1].trim()
      : dateInput.trim();

    // 1) 요일 제거 (예: "Thursday, January 23, 2025" → "January 23, 2025")
    const withoutWeekday = trimmed.replace(/^[A-Za-z]+,\s*/, '');

    // 2) 지원할 모든 포맷 리스트
    const formats = [
      'yyyy.M.d',
      'yyyy.MM.dd',
      'yyyy.MM.dd HH:mm',
      'yyyy-M-d HH:mm',
      'yyyy-MM-dd HH:mm',
      'yyyy-MM-dd', // ISO 날짜
      'MMMM d, yyyy',
      'MMMM d, yyyy hh:mm a',
      'dddd, MMMM d, yyyy',
      // 'dd/MM/yyyy',
    ];

    // 3) 순차적으로 포맷 시도
    let parsed: Date | null = null;
    for (const fmt of formats) {
      const candidate = parse(withoutWeekday, fmt, new Date(), {
        locale: enUS,
      });
      if (isValid(candidate)) {
        parsed = candidate;
        break;
      }
    }

    // 4) 그래도 못 찾으면 AI 백업
    if (!parsed) {
      return this.askAiForEightDigits(dateInput);
    }

    const result = format(parsed, 'yyyyMMdd');
    if (!/^\d{8}$/.test(result)) {
      return this.askAiForEightDigits(dateInput);
    }

    // 5) 최종 8자리 숫자 반환
    return result;
    // return format(parsed, 'yyyyMMdd');
  }

  /**
   *'https://nationalinterest.org/search/node/%22north%20korea%22'
   * === >  "https://nationalinterest.org"
   * @param searchUrl
   * @returns 오리진 url 리턴
   */
  getSearchUrlOrigin = (searchUrl: string): string => {
    const urlObj = new URL(searchUrl);
    const baseUrl = urlObj.origin;
    return baseUrl;
  };

  // 날씨용 데이트 수정
  convertDateString = (input: string): string => {
    if (!input) return '1';
    // const nowYear = new Date().getFullYear();
    // 연도 추출 (없으면 현재 연도)
    const yearMatch = input.match(/(\d{4})년/);
    const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();

    // 월, 일, 시 추출
    const match = input.match(
      /(\d{1,2})월\s*(\d{1,2})일(?:\s*\(.*?\)\s*요일)?\s*(\d{1,2})(?:시|:\d{2})/,
    );

    if (!match) return '2';

    const [, month, day, hour] = match;
    const pad = (n: string) => n.toString().padStart(2, '0');

    return `${year}${pad(month)}${pad(day)}${pad(hour)}`;
  };
}
