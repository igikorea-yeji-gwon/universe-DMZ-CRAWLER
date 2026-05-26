import {
  Body,
  Controller,
  DefaultValuePipe,
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
import {
  AddScrapConfigRequest,
  AddScraperRequest,
  initScraperRequest,
} from './types/scraper.type';
import { ScraperConfigService } from './scraper.config.service';
import { HttpExceptionFilter } from 'src/common/filters/http-exception.filter';
import {
  ListConfigDto,
  ListLogDto,
  ScrapedDataDto,
} from './dto/scraperDtos';

@ApiTags('Scraper')
@Controller('scraper')
@UseFilters(HttpExceptionFilter)
export class ScraperConfigController {
  constructor(private readonly scraperConfigService: ScraperConfigService) {}

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

  @Post('config')
  @ApiOperation({ summary: 'Config 생성 + 스케줄 등록' })
  @ApiBody({
    schema: {
      example: {
        targetScraperConfig: {
          name: '두루누비: 공지사항 DMZ 검색',
          description: '사이트 설명',
          baseUrl: 'https://www.koreadmz.kr',
          startUrl: ['https://www.koreadmz.kr/geopark/pds/notice?searchKeyword=dmz'],
          scheduleTime: ['09:00'],
          enabled: true,
          steps: [
            { id: 'step-001', type: 'detailLinks', params: { selector: 'tbody tr td.sbj a', attribute: 'href' } },
            { id: 'step-002', type: 'scrapDetail', params: { targets: [
              { name: 'title', type: 'uniqueText', selector: 'div.sbj' },
              { name: 'writedate', type: 'uniqueText', selector: 'div.date' },
              { name: 'content', type: 'duplicatedText', selector: 'div.conts' },
            ]}},
            { id: 'step-003', type: 'paging', params: { selector: 'div.pager' } },
          ],
        },
      },
    },
  })
  async setTeagetScraperConfig(@Body() requestBody: AddScraperRequest) {
    return await this.scraperConfigService.addNewScheduleScraperJobs(
      requestBody.targetScraperConfig,
    );
  }

  @Patch('config')
  @ApiOperation({ summary: 'Config 수정 (id 필수)' })
  @ApiBody({
    schema: {
      example: {
        targetScraperConfig: {
          id: 1,
          name: '수정된 이름',
          enabled: false,
          scheduleTime: ['21:00'],
        },
      },
    },
  })
  async updateOneScraperConfig(@Body() requestBody: AddScraperRequest) {
    return await this.scraperConfigService.updateOneScraperConfig(
      requestBody.targetScraperConfig,
    );
  }

  @Delete('config/:id')
  @ApiOperation({ summary: 'Config 삭제' })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  async deleteOneScraperConfig(@Param('id') id: string) {
    return await this.scraperConfigService.deleteOneScraperConfig(Number(id));
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

  @Post('test')
  @ApiOperation({ summary: 'Config 직접 입력하여 스크래퍼 테스트' })
  @ApiBody({
    schema: {
      example: {
        targetScraperConfig: {
          name: '테스트',
          baseUrl: 'https://example.com',
          startUrl: ['https://example.com/board'],
          scheduleTime: ['09:00'],
          enabled: true,
          steps: [],
        },
      },
    },
  })
  async testNoneIdRunScraper(@Body() requestBody: AddScraperRequest) {
    return await this.scraperConfigService.runTestScraper(
      null,
      requestBody.targetScraperConfig,
    );
  }

  @Get('mock/:id')
  @ApiOperation({ summary: '단건 즉시 실행 (내부 테스트용)' })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  async mockScrap(@Param('id') id: string) {
    return this.scraperConfigService.runScrep(id);
  }

  @Get('test-log')
  @ApiOperation({ summary: '기본 스케줄(14:30) 즉시 실행' })
  async testScraper() {
    return await this.scraperConfigService.runScraper(null);
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

  // ─── 로그 / 데이터 조회 (stub) ──────────────────────────────────────────────

  @Get('log')
  @ApiOperation({ summary: '실행 로그 목록 (현재 S3 저장만, 조회 미지원)' })
  @ApiQuery({ name: 'pageSize', type: Number, example: 10 })
  @ApiQuery({ name: 'pageNumber', type: Number, example: 1 })
  @ApiQuery({ name: 'searchType', required: false, example: 'name' })
  @ApiQuery({ name: 'searchKeyword', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  async listLogs(@Query() dto: ListLogDto) {
    return await this.scraperConfigService.listLogs(dto);
  }

  @Get('log/latest')
  @ApiOperation({ summary: '최신 로그 N개 (현재 stub)' })
  @ApiQuery({ name: 'limit', type: Number, required: false, example: 20 })
  async getLatest(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.scraperConfigService.getLatestLogs(limit);
  }

  @Get('log/:id')
  @ApiOperation({ summary: '로그 단건 조회 (현재 stub)' })
  @ApiParam({ name: 'id', type: Number })
  async getById(@Param('id', ParseIntPipe) id: number) {
    return this.scraperConfigService.getLogById(id);
  }

  @Get('scraped-data')
  @ApiOperation({ summary: '수집 데이터 목록 (현재 stub)' })
  async findScrapData(@Query() query: ScrapedDataDto) {
    return this.scraperConfigService.findScrapData(query);
  }

  @Get('scraped-data/:id')
  @ApiOperation({ summary: 'configId 기준 수집 데이터 (현재 stub)' })
  @ApiParam({ name: 'id', type: Number })
  async fondOneScrapedDate(@Param('id') id: string) {
    return await this.scraperConfigService.fondOneScrapedDate(Number(id));
  }

  @Post('configs')
  @ApiOperation({ summary: 'Config 생성 (스케줄 등록 없음)' })
  async addScrapeConfig(@Body() requestBody: AddScrapConfigRequest) {
    return await this.scraperConfigService.addScrapeConfigAndJobs(
      requestBody.targetScraperConfig,
    );
  }

  @Get('data')
  @ApiOperation({ summary: '수집 데이터 변환 포맷 조회 (현재 stub)' })
  async getScrapData(@Query() query: ScrapedDataDto) {
    return await this.scraperConfigService.getScrapData(query);
  }

  @Get('video')
  @ApiOperation({ summary: '비디오 스크래핑 테스트' })
  async mockvideoScrap() {
    return this.scraperConfigService.videoTest();
  }
}
