import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { ScraperModule } from './scraper/scraper.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: 'info',
        autoLogging: false,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      },
    }),
    ScraperModule,
  ],
  providers: [ResponseInterceptor],
})
export class AppModule {}
