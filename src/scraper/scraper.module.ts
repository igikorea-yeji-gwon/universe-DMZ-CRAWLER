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
import { JsonConfigService } from './json-config.service';
import { TranslationClientService } from './translation-client.service';
import { NewsDbService } from './news-db.service';
import { CubridService } from 'src/database/cubrid.service';
import { YnaFeedService } from './yna-feed.service';
import { YnaBackfillService } from './yna-backfill.service';
import { NewsRelevanceFilterService } from './news-relevance-filter.service';
import { ArticleExportService } from './article-export.service';
import { IsbnModule } from 'src/isbn/isbn.module';
import { ArchiveController } from './archive/archive.controller';
import { ArchiveIngestService } from './archive/archive-ingest.service';
import { ArchiveExportService } from './archive/archive-export.service';
import { ArchiveReportService } from './archive/archive-report.service';
import { InstitutionClassifierService } from './archive/institution-classifier.service';
import { ThemeClassifierService } from './archive/theme-classifier.service';
import { LosiCollectorService } from './archive/losi-collector.service';
import { KistiCollectorService } from './archive/kisti-collector.service';
import { EncykoreaCollectorService } from './archive/encykorea-collector.service';
import { RelevanceFilterService } from './archive/relevance-filter.service';
import { AcademicFilterService } from './archive/academic-filter.service';
import { KciCollectorService } from './archive/kci-collector.service';
import { RissCollectorService } from './archive/riss-collector.service';
import { NtisCollectorService } from './archive/ntis-collector.service';

@Module({
  imports: [ScheduleModule.forRoot(), IsbnModule],
  controllers: [ScraperConfigController, ArchiveController],
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
    JsonConfigService,
    TranslationClientService,
    NewsDbService,
    CubridService,
    YnaFeedService,
    YnaBackfillService,
    NewsRelevanceFilterService,
    ArticleExportService,
    ArchiveIngestService,
    ArchiveExportService,
    ArchiveReportService,
    InstitutionClassifierService,
    ThemeClassifierService,
    RelevanceFilterService,
    AcademicFilterService,
    KciCollectorService,
    RissCollectorService,
    NtisCollectorService,
    LosiCollectorService,
    KistiCollectorService,
    EncykoreaCollectorService,
  ],
})
export class ScraperModule {}
