// // daily-check.service.ts
// import { Injectable, Logger } from '@nestjs/common';
// import { Cron, CronExpression } from '@nestjs/schedule';
// import { ScraperService } from './scraper.service';

// @Injectable()
// export class DailyCheckService {
//   private readonly logger = new Logger(DailyCheckService.name);

//   constructor(private readonly scraperService: ScraperService) {}

//   // 매일 새벽 3시에 실행 (Asia/Seoul 타임존 사용)
//   @Cron('0 0 3 * * *', { timeZone: 'Asia/Seoul' })
//   async handleDailyCheck(): Promise<void> {
//     this.logger.log('매일 새벽 3시 스크래퍼 대상 체크 시작');
//     await this.scraperService.checkScraperTargets();
//   }
// }
