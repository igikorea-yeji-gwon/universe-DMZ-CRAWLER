import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // cors설정
  app.enableCors({
    origin: true,
    credentials: true,
  });
  // 익셉션 필터 적용
  app.useGlobalFilters(new HttpExceptionFilter());
  // 리스펀스 인터셉터 적용
  const responseInterceptor = app.get(ResponseInterceptor);
  app.useGlobalInterceptors(responseInterceptor);
  // 스웨거 적용
  const config = new DocumentBuilder()
    .setTitle('DMZ-TRANSLATION')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  // 긴 본문 번역 요청 대비 body 크기 제한 늘리기 (50mb)
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  // 청크 분할 번역은 오래 걸릴 수 있어 타임아웃을 넉넉히 둔다
  const server = app.getHttpServer();
  server.setTimeout(300_000);
  server.keepAliveTimeout = 300_000;
  server.headersTimeout = 301_000;

  const port = Number(process.env.PORT) || 3100;
  await app.listen(port);
}
bootstrap();
