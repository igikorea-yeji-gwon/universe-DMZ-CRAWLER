// app.module.ts (또는 별도의 ScraperModule)
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ScraperConfigService } from './scraper.config.service';
import { ScraperConfigController } from './scraper.config.controller';
import { ScraperService } from './scraper.service';
import { MediaDownloadService } from './media-download.service';
import { HtmlParsingService } from './html-parsing.service';
import { PageNavigationService } from './page-navigation.service';
import { UtilService } from 'src/common/util.service';
import { S3Service } from 'src/aws/s3/s3.service';
import { TaskTrackerService } from 'src/common/log/schedule/taskTracker.service';
import { OpenAIService } from 'src/openai/opneai.service';
import { ProcessService } from 'src/common/utils/scrapProcess/process.service';
import { GeminiAnalyzerService } from 'src/common/utils/geminiAnalyze/gemini-analyzer.service';
import { GoogleChatService } from 'src/common/webhook/google-chat.service';
import { JsonConfigService } from './json-config.service';
import { TranslationClientService } from './translation-client.service';
import { NewsDbService } from './news-db.service';
import { CubridService } from 'src/database/cubrid.service';
import { YnaFeedService } from './yna-feed.service';
import { ArticleExportService } from './article-export.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [ScraperConfigController],
  providers: [
    ScraperConfigService,
    ScraperService,
    MediaDownloadService,
    HtmlParsingService,
    PageNavigationService,
    UtilService,
    S3Service,
    TaskTrackerService,
    OpenAIService,
    ProcessService,
    GeminiAnalyzerService,
    GoogleChatService,
    JsonConfigService,
    TranslationClientService,
    NewsDbService,
    CubridService,
    YnaFeedService,
    ArticleExportService,
  ],
})
export class ScraperModule {}
