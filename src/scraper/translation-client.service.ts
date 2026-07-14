import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

/**
 * 분리된 영문번역 앱(dmz-translation)을 HTTP로 호출하는 클라이언트.
 * 기존 TranslationService의 translateArticle / translateFields 시그니처를 그대로 유지해
 * 호출부(scraper.service, yna-feed.service)의 폴백 로직이 변경 없이 동작한다.
 *
 * 번역 앱이 죽어있거나 번역이 실패하면 예외를 던지며,
 * 호출부는 이를 잡아 _en 필드 null + trsl_yn='N' 으로 적재하고 수집을 계속한다.
 */
@Injectable()
export class TranslationClientService {
  private readonly logger = new Logger(TranslationClientService.name);
  private readonly http: AxiosInstance;
  readonly baseURL: string;

  constructor(private readonly configService: ConfigService) {
    const baseURL =
      this.configService.get<string>('TRANSLATION_API_URL') ??
      'http://localhost:3001';
    this.baseURL = baseURL;
    // 청크 분할 번역(긴 본문)은 오래 걸릴 수 있어 기본 타임아웃을 넉넉히 둔다
    const timeout =
      Number(this.configService.get('TRANSLATION_API_TIMEOUT_MS')) || 180_000;

    this.http = axios.create({ baseURL, timeout });
    this.logger.log(`번역 API 주소: ${baseURL} (timeout ${timeout}ms)`);
  }

  /**
   * 번역 앱 연결 헬스체크. Gemini 호출 없이 연결 여부만 빠르게 확인한다.
   * 번역 앱에 GET 라우트가 없어도 HTTP 응답(404 포함)이 오면 프로세스는
   * 실행 중인 것으로 판단하고, 연결 자체가 안 되면(ECONNREFUSED 등) 다운으로 본다.
   */
  async healthCheck(): Promise<{
    reachable: boolean;
    httpStatus: number | null;
    message: string;
  }> {
    try {
      const res = await this.http.get('/health', {
        timeout: 5_000,
        validateStatus: () => true,
      });
      return {
        reachable: true,
        httpStatus: res.status,
        message:
          res.status === 200
            ? '번역 앱 정상 응답 (/health 200)'
            : `번역 앱 실행 중 — HTTP ${res.status} 응답 (전용 /health 라우트 없음)`,
      };
    } catch (error) {
      return {
        reachable: false,
        httpStatus: null,
        message: axios.isAxiosError(error)
          ? `연결 실패 (${error.code ?? error.message}) — 번역 앱 실행 여부와 TRANSLATION_API_URL 포트를 확인하세요`
          : `연결 실패: ${(error as Error)?.message ?? error}`,
      };
    }
  }

  /** 뉴스 기사 번역 → { title_en, writer_en, content_en } */
  async translateArticle(
    article: Record<string, any>,
  ): Promise<Record<string, string>> {
    return this.post('/translation/article', {
      title: String(article.title ?? ''),
      writer: String(article.writer ?? article.author ?? ''),
      content: String(article.content ?? ''),
    });
  }

  /** 여러 필드 일괄 번역 → 같은 키의 영문 값 객체 */
  async translateFields(
    fields: Record<string, string>,
  ): Promise<Record<string, string>> {
    return this.post('/translation/fields', { fields });
  }

  private async post(path: string, body: any): Promise<any> {
    try {
      const res = await this.http.post(path, body);
      // 번역 앱의 ResponseInterceptor가 { success, data, timestamp }로 감싸므로 data만 꺼낸다
      const payload = res.data;
      if (payload?.success === false) {
        throw new Error(payload.message ?? '번역 API가 실패를 반환했습니다.');
      }
      return payload?.data ?? payload;
    } catch (error) {
      throw new Error(this.describeError(path, error));
    }
  }

  /** axios 에러를 호출부 로그에 바로 쓸 수 있는 한 줄 메시지로 정리 */
  private describeError(path: string, error: any): string {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const body = error.response.data;
        const message = body?.message ?? body?.error ?? error.message;
        return `번역 API ${path} 응답 오류 (HTTP ${error.response.status}): ${message}`;
      }
      // 응답 자체가 없음 = 번역 앱 다운/네트워크 문제
      return `번역 API ${path} 연결 실패 (${error.code ?? error.message}) — 번역 앱이 실행 중인지 확인 필요`;
    }
    return `번역 API ${path} 호출 실패: ${error?.message ?? error}`;
  }
}
