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
    origin: true, // 'http://localhost:5173', // 또는 true (모든 origin 허용)
    credentials: true, // 필요 시 쿠키 허용
  });
  // 이셉션 필터 적용
  app.useGlobalFilters(new HttpExceptionFilter());
  // 리스펀스 인터셉터 적용
  const responseInterceptor = app.get(ResponseInterceptor);
  app.useGlobalInterceptors(responseInterceptor);
  // 스웨거 적용
  const config = new DocumentBuilder()
    .setTitle('IGI-WEB-SCRAPER')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  // body 크기 제한 늘리기 (50mb)
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  const server = app.getHttpServer();
  server.setTimeout(120_000);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 121_000;

  await app.listen(Number(process.env.PORT) || 3000);
}
bootstrap();
