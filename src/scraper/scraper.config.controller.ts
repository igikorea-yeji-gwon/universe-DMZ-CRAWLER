import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { initScraperRequest } from './types/scraper.type';
import { ScraperConfigService } from './scraper.config.service';
import { NewsDbService } from './news-db.service';
import { YnaFeedService } from './yna-feed.service';
import { ArticleExportService } from './article-export.service';
import { HttpExceptionFilter } from 'src/common/filters/http-exception.filter';
import { ListConfigDto } from './dto/scraperDtos';

@ApiTags('Scraper')
@Controller('scraper')
@UseFilters(HttpExceptionFilter)
export class ScraperConfigController {
  constructor(
    private readonly scraperConfigService: ScraperConfigService,
    private readonly newsDbService: NewsDbService,
    private readonly ynaFeedService: YnaFeedService,
    private readonly articleExportService: ArticleExportService,
  ) {}

  // ─── Config CRUD ────────────────────────────────────────────────────────────

  @Get('config/list')
  @ApiOperation({ summary: 'Config 목록 조회 (페이징/검색)' })
  @ApiQuery({ name: 'pageSize', type: Number, example: 10 })
  @ApiQuery({ name: 'pageNumber', type: Number, example: 1 })
  @ApiQuery({ name: 'searchType', required: false, example: 'name' })
  @ApiQuery({ name: 'searchKeyword', required: false, example: 'DMZ' })
  @ApiQuery({ name: 'startDate', required: false, example: '2026-01-01' })
  @ApiQuery({ name: 'endDate', required: false, example: '2026-12-31' })
  async getConfig(@Query() dto: ListConfigDto) {
    return this.scraperConfigService.listConfigs(dto);
  }

  @Get('config/schedule')
  @ApiOperation({ summary: '등록된 CronJob 목록 조회' })
  async getScraperSchedule() {
    return await this.scraperConfigService.getScraperSchedule();
  }

  @Get('config/:id')
  @ApiOperation({ summary: 'Config 단건 조회' })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  async fondOneScraperConfig(@Param('id') id: string) {
    return await this.scraperConfigService.getFindOneByIdScraperConfig(Number(id));
  }

  // ─── 스크래핑 실행 ──────────────────────────────────────────────────────────

  @Get('run/:id')
  @ApiOperation({ summary: 'Config ID로 스크래퍼 실행 (결과 즉시 반환)' })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiResponse({
    status: 200,
    description: '수집된 기사 배열',
    schema: {
      example: [
        {
          title: '기사 제목',
          writedate: '20260526',
          content: '본문 내용...',
          currentUrl: 'https://example.com/article/123',
          img: [{ url: 'https://...', caption: '', s3Path: 's3://bucket/news-crawler/file/1/2026-05-26/img/xxx.jpg' }],
          file: [{ originalName: 'report.pdf', s3Path: 's3://bucket/news-crawler/file/1/2026-05-26/file/report.pdf' }],
        },
      ],
    },
  })
  async testRunScraper(@Param('id') id: string) {
    return await this.scraperConfigService.runTestScraper(Number(id));
  }

  // ─── Config AI 자동 생성 ────────────────────────────────────────────────────

  @Post('config/init')
  @ApiOperation({ summary: 'URL 입력 시 AI(OpenAI)가 스크래퍼 Config 자동 생성' })
  @ApiBody({
    schema: {
      example: {
        searchUrl: 'https://example.com/board',
        detailsUrl: 'https://example.com/board/123',
      },
    },
  })
  async initTeagetScraperConfig(@Body() requestBody: initScraperRequest) {
    return await this.scraperConfigService.initTeagetScraperConfig(requestBody);
  }


    // ─── S3에 적재된 기사데이터 반환 ────────────────────────────────────────────────

  @Get('download/:originId')
  @ApiOperation({ summary: 'origin_id 기준 S3 수집파일 목록 반환 (presigned URL 포함)' })
  @ApiParam({ name: 'originId', type: Number, example: 11 })
  async downloadByOrigin(@Param('originId', ParseIntPipe) originId: number) {
    return this.scraperConfigService.getFilesByOrigin(originId);
  }

  // ─── 스프링 연동: S3 meta.json → DB 적재용 정규화 JSON ─────────────────────

  @Get('articles/:originId')
  @ApiOperation({
    summary:
      'origin_id 기준 S3 meta.json을 DB 적재용(정규화) JSON으로 반환 — 스프링 뉴스 적재 배치 연동용',
  })
  @ApiParam({ name: 'originId', type: Number, example: 16 })
  @ApiQuery({
    name: 'since',
    required: false,
    example: '2026-07-13 00:00:00',
    description: '이 시각(KST) 이후에 수집 완료된 기사만 반환 (증분 폴링용). 생략 시 전체 반환',
  })
  @ApiResponse({
    status: 200,
    description: '적재용 기사 목록',
    schema: {
      example: {
        originId: 16,
        since: '2026-07-13 00:00:00',
        total: 2,
        articles: [
          {
            originId: 16,
            title: '기사 제목',
            contentText: '본문...<br>문단2',
            linkUrl: 'https://example.com/article/123',
            writer: '홍길동',
            regDt: '2026-07-12 00:00:00',
            regDtParsed: true,
            langCode: 'ko',
            trslYn: 'Y',
            titleEn: 'Article title',
            contentTextEn: 'Body...',
            collectedAt: '2026-07-13 09:05:12',
            files: [
              {
                filePath: '/news-crawler/file/16/2026-07-12/img/xxx.jpg',
                fileUrl: 'https://example.com/img/xxx.jpg',
                fileTy: 'image',
                sortOrder: 0,
              },
            ],
            skippedFiles: 0,
          },
        ],
      },
    },
  })
  async exportArticles(
    @Param('originId', ParseIntPipe) originId: number,
    @Query('since') since?: string,
  ) {
    return this.articleExportService.exportArticles(originId, since);
  }

  // ─── [임시] S3 meta.json → CUBRID 적재 ────────────────────────────────────

  @Get('download2/:originId')
  @ApiOperation({ summary: '[임시] origin_id 기준 S3 meta.json을 CUBRID news/news_file 테이블에 적재' })
  @ApiParam({ name: 'originId', type: Number, example: 16 })
  @ApiResponse({
    status: 200,
    description: '적재 결과 요약',
    schema: {
      example: {
        originId: 16,
        totalMeta: 10,
        inserted: 8,
        skippedDuplicate: 2,
        fileInserted: 12,
        fileSkipped: 1,
        errors: [],
      },
    },
  })
  async download2(@Param('originId', ParseIntPipe) originId: number) {
    return this.newsDbService.loadArticlesToDb(originId);
  }

  // ─── 연합뉴스 RSS 피드 수집 ─────────────────────────────────────────────────

  @Get('yna/collect')
  @ApiOperation({
    summary:
      '연합뉴스 RSS 피드 즉시 수집 → S3 meta.json 저장 (5분 주기 자동 수집과 동일 로직, 테스트용. DB 적재는 스프링 담당)',
  })
  @ApiResponse({
    status: 200,
    description: '수집 결과 요약',
    schema: {
      example: {
        totalItems: 30,
        keywordMatched: 3,
        skippedDuplicate: 2,
        saved: 1,
        imageUploaded: 2,
        translated: 1,
        errors: [],
      },
    },
  })
  async collectYnaFeed() {
    return this.ynaFeedService.collect();
  }
}
