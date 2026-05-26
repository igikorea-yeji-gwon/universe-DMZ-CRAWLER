import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { SrcSetItem } from './util.interface';
import sharp from 'sharp';
import * as cheerio from 'cheerio';
import fs from 'fs';
import { BigKindsResponse } from 'src/news/big-kinds/big-kinds.interface';
import path from 'path';
import moment from 'moment';
import { parse, format, isValid } from 'date-fns';
import { enUS, ko } from 'date-fns/locale';
import { OpenAIService } from 'src/openai/opneai.service';

@Injectable()
export class UtilService {
  constructor(private openAIService: OpenAIService) {}

  // cleanDateInput = (dateInput: string): string => {
  //   // 정규표현식: YYYY-MM-DD 또는 YYYY.MM.DD 형식과 선택적으로 시간까지 캡처
  //   const match = dateInput.match(
  //     /(\d{4}[-.]\d{1,2}[-.]\d{1,2}(?:\s+\d{2}:\d{2})?)/,
  //   );
  //   return match ? match[0] : dateInput;
  // };

  // cleanDateInput = (dateInput: string): string => {
  //   // 우선, 영문 날짜 형식으로 파싱을 시도합니다.
  //   try {
  //     // 만약 입력값에 시간 정보도 있다면 아래 형식을 사용.
  //     // 참고: 'MMMM d, yyyy h:mm a'는 예: March 15, 2025 11:56 AM
  //     const parsedDate = parse(dateInput, 'MMMM d, yyyy h:mm a', new Date());
  //     // 원하는 출력 포맷으로 변경 (예: "2025-03-15 11:56")
  //     return format(parsedDate, 'yyyy-MM-dd HH:mm');
  //   } catch (error) {
  //     // console.log('변경 시작 ', error);

  //     // 만약 파싱 실패하면 기존 로직을 사용
  //     const match = dateInput.match(
  //       /(\d{4}[-.]\d{1,2}[-.]\d{1,2}(?:\s+\d{2}:\d{2})?)/,
  //     );
  //     return match ? match[0] : dateInput;
  //   }
  // };
  // cleanDateInput = async (dateInput: string) => {
  //   dateInput = dateInput.trim(); // 불필요한 공백 제거
  //   let parsedDate: Date;
  //   if (dateInput.includes('am' || 'AM')) {
  //     parsedDate = parse(dateInput, 'MMMM dd, yyyy hh:mm a', new Date(), {
  //       locale: enUS,
  //     });
  //   } else if (dateInput.includes('pm' || 'PM')) {
  //     parsedDate = parse(dateInput, 'MMMM dd, yyyy h:mm p', new Date(), {
  //       locale: enUS,
  //     });
  //   } else {
  //     parsedDate = parse(dateInput, 'MMMM dd, yyyy hh:mm a', new Date(), {
  //       locale: enUS,
  //     });
  //   }
  //   // const parsedDate = parse(dateInput, 'MMMM dd, yyyy hh:mm a', new Date(), {
  //   //   locale: enUS,
  //   // });
  //   if (!isValid(parsedDate)) {
  //     console.log('11');

  //     const match = dateInput.match(
  //       /(\d{4}[-.]\d{1,2}[-.]\d{1,2}(?:\s+\d{2}:\d{2})?)/,
  //     );
  //     return match ? match[0] : dateInput;
  //   }
  //   console.log('22');
  //   return format(parsedDate, 'yyyy-MM-dd HH:mm', { locale: ko });
  // };
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
    ];

    // 엄격 모드로 파싱 (포맷이 일치하지 않으면 실패)
    const parsedDate = moment(cleanedInput, formats, true);

    if (!parsedDate.isValid()) {
      const aiDate = await this.openAIService.askQuestion(
        `${dateInput} 을 8자리 숫자 형식(YYYYMMDD)으로 변환해줘. 오직 8자리 숫자만 출력하고, 어떤 부가 설명도 하지 마.`,
        // '너는 날짜를 YYYYMMDD 형식의 8자리 숫자로 변환하는 전문가야. 입력된 날짜를 오직 8자리 숫자(YYYYMMDD)로만 출력해. 다른 어떠한 설명이나 문구도 포함하지 마.',
      );

      return aiDate;
      // throw new Error(`유효하지 않은 날짜 형식입니다: ${cleanedInput}`);
    }
    // yyyyMMdd 형태로 출력
    return parsedDate.format('YYYYMMDD');
  };

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

  async decodeBase64AndSaveFile(base64Data: string, outputFilePath: string) {
    const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error('Invalid base64 string format');
    }
    const mimeType = matches[1];
    const base64Content = matches[2];
    const buffer = Buffer.from(base64Content, 'base64');
    const fileExtension = mimeType.split('/')[1];
    const outputFileWithExtension = `${outputFilePath}.${fileExtension}`;
    fs.writeFileSync(outputFileWithExtension, buffer);
    console.log(`File saved at ${outputFileWithExtension}`);
  }

  async keywordFilter(keywords?: string | string[]) {
    // keywords가 undefined일 경우 빈 배열([])로 설정
    let sanitizedKeywords: string[] = [''];
    if (keywords) {
      if (Array.isArray(keywords)) {
        sanitizedKeywords = keywords.map((k) =>
          decodeURIComponent(k)
            .replace(/[\x00-\x1F\x7F]/g, '')
            .trim(),
        );
      } else {
        sanitizedKeywords = [
          decodeURIComponent(keywords)
            .replace(/[\x00-\x1F\x7F]/g, '')
            .trim(),
        ];
      }
    }
    return sanitizedKeywords;
  }

  async reSizeImgAndIncodeBase64(buffer: Buffer, mimeType: string) {
    const MAX_DIMENSION = 800;
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    let base64Incoding: string;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const resizeOptions =
        width > height ? { width: MAX_DIMENSION } : { height: MAX_DIMENSION };
      const resizedImageBuffer = await sharp(buffer)
        .resize(resizeOptions)
        .toBuffer();
      base64Incoding = resizedImageBuffer.toString('base64');
    } else {
      base64Incoding = buffer.toString('base64');
    }
    return `data:${mimeType};base64,${base64Incoding}`;
  }

  private readonly headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: 'https://www.spnews.co.kr',
  };
  async imgLinkToBase64WithStream(link: string): Promise<string> {
    console.log('??', link);

    const res = await axios({
      method: 'get',
      url: link,
      headers: this.headers,
      responseType: 'stream',
    });

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];

      res.data.on('data', (chunk) => chunks.push(chunk));
      res.data.on('end', () => {
        const buffer = Buffer.concat(chunks).toString('base64');
        const mimeType =
          res.headers['content-type'] || 'application/octet-stream';
        resolve(`data:${mimeType};base64,${buffer}`);
      });
      res.data.on('error', (err) => reject(err));
    });
  }

  // async imgLinkToBase64WithAxios(link: string) {
  //   const res = await axios.get(link, { responseType: 'arraybuffer' });
  //   const buffer = Buffer.from(res.data, 'binary').toString('base64');
  //   const mimeType = res.headers['content-type'];
  //   return `data:${mimeType};base64,${buffer}`;
  // }

  async imgLinkToBase64WithAxios(link: string) {
    const res = await axios.get(link, { responseType: 'arraybuffer' });
    let buffer = Buffer.from(res.data, 'binary');

    // PNG 확장자라면 JPEG로 변환
    if (link.toLowerCase().endsWith('.png')) {
      buffer = await sharp(buffer).jpeg().toBuffer();
    }

    // base64 인코딩 및 MIME 타입 지정
    const base64Data = buffer.toString('base64');
    const mimeType = link.toLowerCase().endsWith('.png')
      ? 'image/jpeg'
      : res.headers['content-type'];
    return `data:${mimeType};base64,${base64Data}`;
  }

  async imgLinkToBase64WithFetch(link: string): Promise<string> {
    const res = await fetch(link);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = res.headers.get('content-type');
    return `data:${mimeType};base64,${buffer}`;
  }

  async imgBodyToBase64(imgBuffer: Buffer, mimeType: string) {
    const buffer = Buffer.from(imgBuffer).toString('base64');
    return `data:${mimeType};base64,${buffer}`;
  }

  parseSrcSet(srcset: string) {
    const sources = srcset.split(',').map((s) => s.trim());

    return sources.map((source) => {
      const [url, descriptor] = source.split(/\s+/);
      const item: SrcSetItem = { url };

      if (descriptor) {
        if (descriptor.endsWith('w')) {
          item.width = parseInt(descriptor.slice(0, -1));
        } else if (descriptor.endsWith('x')) {
          item.density = parseFloat(descriptor.slice(0, -1));
        }
      }

      return item;
    });
  }

  async SecondFilter(
    ele: BigKindsResponse,
  ): Promise<{ check: boolean; matchedFilters: string[] }> {
    const targets = [
      '북한산',
      '북한강',
      '남북',
      '거북한',
      '수북한',
      '김정은',
      '대북',
    ];
    const filters = [
      '전투',
      '북한군',
      '파병',
      '무기',
      '군인',
      '전쟁',
      '회담',
      '인민',
      '정권',
      '휴전선',
      '정치',
      '대통령',
      '안보',
      '심리전',
      '위원장',
      '부부장',
      '통일',
      '조국통일',
      '대적',
      '전단',
      '탈북',
      '군사',
      'DMZ',
      '남북 단절',
      '참모',
      '전차',
      '미사일',
      '북중',
      'ICBM',
      '평양',
      '이탈주민',
      '북한식',
      '스포츠',
      '축구',
      '월드컵',
      '송금',
      '분단',
      '대남',
      '방송',
      '음식',
      '한식',
      '납치',
      '정부',
      '민주',
      '북,',
      '푸틴',
      '면담',
      '국무',
      '분쟁',
      '평화',
      '정당',
      '남한',
      '러시아',
      '위협',
      '한반도',
      '정예군',
      '국방',
      '실향민',
      '북향민',
      '국정',
      '지도자',
      '공산',
      '공화',
      '남북문제',
      '살포',
      '수사',
      '교란',
      '도발',
      '합동',
      '전파',
      '본부',
      '합참',
      '한미',
      '동맹',
    ];

    const keywords = ele.tms_raw_stream + '\n' + ele.title;

    let check = true;
    // 키워드가 타켓 배열 안에 포함된게 있는지 확인
    const containsTarget = targets.some((target) =>
      keywords.match(new RegExp(target)),
    );

    // if (containsTarget) {
    //   // 포함된게 있다면 2차 필터링 배열의 내용이 포함된게 있는지 확인
    //   const containsFilter = filters.some((filter) =>
    //     keywords.match(new RegExp(filter)),
    //   );
    //   if (!containsFilter) {
    //     console.log('???', ele.title);
    //   }
    //   check = containsFilter;
    // }

    // 매칭된 filters를 저장할 리스트
    const matchedFilters: string[] = [];

    if (containsTarget) {
      // console.log('**확인**', ele.title);
      matchedFilters.push(
        ...filters.filter((filter) => {
          const isMatched = keywords.match(new RegExp(filter));
          return isMatched;
        }),
      );
      // filters에서 keywords와 매칭되는 항목의 개수를 확인
      // const matchedFiltersCount = filters.filter((filter) =>
      //   keywords.match(new RegExp(filter)),
      // ).length;

      // 매칭된 항목이 2개 이상일 경우에만 check를 true로 설정
      if (matchedFilters.length >= 2) {
        // console.log('@통과 : ', ele.title, ele.provider_link_page);
        check = true;
      } else {
        // console.log('제외 : ', ele.title, ele.provider_link_page);
        check = false;
      }
    }

    // return check;
    return { check, matchedFilters };
  }

  setLogJson(aLength, tList, fList) {
    const logJson = {
      all_articles_count: aLength,
      pass_articles_count: tList.length,
      exception_articles_count: fList.length,
      pass: tList,
      exception: fList,
    };
    this.saveJsonToFile(logJson);
  }

  saveJsonToFile(data: object) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0'); // 월은 0부터 시작하므로 +1 필요
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const formattedDate = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    const forderName = `${year}-${month}-${day}`;

    const folderPath = `../filterLogs/${forderName}`;
    const fileName = `${formattedDate}`;

    const jsonString = JSON.stringify(data, null, 2);

    // 폴더가 존재하지 않으면 생성
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    const filePath = path.join(folderPath, `${fileName}.json`);
    // 파일에 JSON 문자열 쓰기
    fs.writeFileSync(filePath, jsonString, 'utf8');
  }

  // 상대 경로를 절대 경로로 변환하는 함수
  resolveUrl(relativeUrl: string, base: string): string {
    try {
      return new URL(relativeUrl, base).toString();
    } catch (error) {
      console.error('URL 변환 실패:', error);
      return '';
    }
  }
}
