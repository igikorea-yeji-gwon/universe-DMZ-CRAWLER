import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface BookInfo {
  isbn: string;
  coverUrl: string | null;
  title: string;
  author: string;
  publisher: string;
  publishYear: string;
}

// 국립중앙도서관 서지정보유통지원시스템(SEOJI) ISBN 서지정보 Open API
const SEOJI_API_URL = 'https://www.nl.go.kr/seoji/SearchApi.do';

@Injectable()
export class IsbnService {
  private readonly logger = new Logger(IsbnService.name);
  private readonly certKey?: string;
  private readonly timeoutMs: number;
  // SEOJI API 호출 간 최소 간격(ms). 동시 요청도 이 간격만큼 순차적으로 벌어진다.
  private readonly minIntervalMs: number;
  // 호출을 직렬화하기 위한 체인과 다음 호출 가능 시각
  private throttleChain: Promise<void> = Promise.resolve();
  private nextAvailableAt = 0;

  constructor(private readonly configService: ConfigService) {
    this.certKey = this.configService.get<string>('SEOJI_CERT_KEY');
    const timeout = Number(this.configService.get<string>('SEOJI_TIMEOUT_MS'));
    this.timeoutMs =
      Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 8000;

    const interval = Number(
      this.configService.get<string>('SEOJI_MIN_INTERVAL_MS'),
    );
    this.minIntervalMs =
      Number.isFinite(interval) && interval >= 0 ? Math.floor(interval) : 3000;

    if (!this.certKey) {
      this.logger.warn(
        'SEOJI_CERT_KEY가 없어 ISBN 표지 조회 기능이 비활성화되었습니다.',
      );
    }
  }

  // 앞선 호출이 끝난 뒤, 마지막 호출로부터 minIntervalMs가 지날 때까지 대기한다
  private async throttle(): Promise<void> {
    const previous = this.throttleChain;
    let release!: () => void;
    this.throttleChain = new Promise<void>((resolve) => (release = resolve));

    await previous;
    try {
      const wait = this.nextAvailableAt - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.nextAvailableAt = Date.now() + this.minIntervalMs;
    } finally {
      release();
    }
  }

  async getBookInfo(isbn: string): Promise<BookInfo> {
    if (!this.certKey) {
      throw new ServiceUnavailableException(
        'ISBN 조회 서비스가 설정되지 않았습니다. SEOJI_CERT_KEY를 확인해주세요.',
      );
    }

    const doc = await this.searchSeoji(isbn);
    if (!doc) {
      this.logger.log(`SEOJI 검색 결과 없음: ${isbn}`);
      throw new NotFoundException('ISBN not found');
    }

    const coverUrl =
      typeof doc.TITLE_URL === 'string' && doc.TITLE_URL.trim()
        ? doc.TITLE_URL.trim()
        : null;

    const bookInfo: BookInfo = {
      isbn,
      coverUrl,
      title: this.asText(doc.TITLE),
      author: this.asText(doc.AUTHOR),
      publisher: this.asText(doc.PUBLISHER),
      publishYear: this.toYear(doc.PUBLISH_PREDATE),
    };

    this.logger.log(
      `SEOJI 조회 완료: ${isbn} → "${bookInfo.title}" (표지 ${coverUrl ? '있음' : '없음'})`,
    );
    return bookInfo;
  }

  private async searchSeoji(isbn: string): Promise<Record<string, any> | null> {
    // SEOJI 서버 부하/차단 방지를 위해 호출 간 최소 간격을 둔다
    await this.throttle();

    this.logger.log(`SEOJI ISBN 조회 요청: ${isbn}`);
    let data: any;

    try {
      const response = await axios.get(SEOJI_API_URL, {
        params: {
          cert_key: this.certKey,
          result_style: 'json',
          page_no: 1,
          page_size: 1,
          isbn,
        },
        timeout: this.timeoutMs,
      });
      data = response.data;
    } catch (error) {
      // 인증키가 로그·응답에 남지 않도록 원본 에러 객체는 통째로 출력하지 않는다
      const message = (error as Error)?.message ?? 'unknown error';
      const status = (error as any)?.response?.status;
      const code = (error as any)?.code;
      this.logger.error(
        `SEOJI 호출 실패 (isbn: ${isbn}, status: ${status ?? '-'}, code: ${code ?? '-'}): ${message}`,
      );
      throw new BadGatewayException(`SEOJI API error: ${message}`);
    }

    // SEOJI는 오류 시에도 200으로 ERR_CODE/ERR_MESSAGE JSON을 반환하는 경우가 있다
    if (data?.ERR_CODE) {
      this.logger.error(
        `SEOJI 오류 응답 (isbn: ${isbn}): [${data.ERR_CODE}] ${data.ERR_MESSAGE ?? ''}`,
      );
      throw new BadGatewayException(
        `SEOJI API error: [${data.ERR_CODE}] ${data.ERR_MESSAGE ?? ''}`.trim(),
      );
    }

    const docs = data?.docs;
    if (!Array.isArray(docs)) {
      this.logger.error(
        `SEOJI 응답 형식이 예상과 다릅니다 (isbn: ${isbn}): ${JSON.stringify(data)?.slice(0, 300)}`,
      );
      throw new BadGatewayException('SEOJI API error: unexpected response');
    }

    return docs.length > 0 ? docs[0] : null;
  }

  private asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  // PUBLISH_PREDATE는 YYYYMMDD 형식 → 연도만 반환
  private toYear(value: unknown): string {
    const text = this.asText(value);
    return /^\d{4}/.test(text) ? text.slice(0, 4) : '';
  }
}
