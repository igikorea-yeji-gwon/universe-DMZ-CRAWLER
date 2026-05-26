// common/interceptors/response.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
// import { PinoLogger } from 'nestjs-pino';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  // private readonly logger: PinoLogger
  constructor() {}
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<Record<string, any>> {
    return next.handle().pipe(
      map((data) => {
        // 로깅: 응답 데이터를 기록합니다.
        // this.logger.info(
        //   { response: data },
        //   'ResponseInterceptor - 응답 데이터',
        // );
        return {
          success: true,
          data,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
