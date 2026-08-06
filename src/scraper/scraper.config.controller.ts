import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { lookup } from 'mime-types';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { initScraperRequest } from './types/scraper.type';
import { ScraperConfigService } from './scraper.config.service';
import { ScraperService } from './scraper.service';
import { NewsDbService } from './news-db.service';
import { YnaFeedService } from './yna-feed.service';
import { YnaBackfillService } from './yna-backfill.service';
import { TranslationClientService } from './translation-client.service';
import { ArticleExportService } from './article-export.service';
import { S3Service } from 'src/aws/s3/s3.service';
import { HttpExceptionFilter } from 'src/common/filters/http-exception.filter';
import { ListConfigDto } from './dto/scraperDtos';

// ─── 미디어 업로드 관문 설정 (POST /scraper/media/upload) ────────────────────
// CMS의 Globals.Upload.S3Prefixes와 같은 값이어야 한다 (기본 law,archive).
// 수집기 자체 산출물 프리픽스(news-crawler/, archive-crawler/)와는 별개다.
const MEDIA_UPLOAD_PREFIXES = (process.env.MEDIA_UPLOAD_PREFIXES ?? 'law,archive')
  .split(',')
  .map((p) => p.trim().replace(/^\/+|\/+$/g, ''))
  .filter(Boolean);
const MEDIA_UPLOAD_MAX_MB = Number(process.env.MEDIA_UPLOAD_MAX_MB) || 100;

/** multer 업로드 파일 (@types/multer 미설치 — 사용 필드만 정의) */
interface UploadedMediaFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@ApiTags('Scraper')
@Controller('scraper')
@UseFilters(HttpExceptionFilter)
export class ScraperConfigController {
  private readonly logger = new Logger(ScraperConfigController.name);

  constructor(
    private readonly scraperConfigService: ScraperConfigService,
    private readonly scraperService: ScraperService,
    private readonly newsDbService: NewsDbService,
    private readonly ynaFeedService: YnaFeedService,
    private readonly ynaBackfillService: YnaBackfillService,
    private readonly translationClient: TranslationClientService,
    private readonly articleExportService: ArticleExportService,
    private readonly s3Service: S3Service,
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

  // ─── 스프링 연동: 미디어(이미지/파일) 프록시 다운로드 ──────────────────────
  // 내부망(스프링)은 화이트리스트 정책상 이 EC2로만 통신 가능하고 S3에 직접 못
  // 나간다. 이 엔드포인트가 S3 → 내부망 스트리밍 관문 역할을 한다.
  // (ES는 S3를 직접 바라보므로 S3 저장 구조는 그대로 유지)

  @Get('media')
  @ApiOperation({
    summary:
      '수집 미디어(이미지/파일) 프록시 다운로드 — 내부망 스프링용 S3 스트리밍 관문. ' +
      'articles API가 내려주는 files[].downloadUrl이 이 엔드포인트를 가리킨다',
  })
  @ApiQuery({
    name: 'path',
    required: true,
    example: '/news-crawler/file/16/2026-07-12/img/xxx.jpg',
    description: 'articles API의 files[].filePath 값 그대로 (news-crawler/ 하위만 허용)',
  })
  @ApiResponse({
    status: 200,
    description:
      '바이너리 스트림. Content-Type/Content-Length/ETag/Content-Disposition 헤더 포함',
  })
  async downloadMedia(@Query('path') path: string, @Res() res: Response) {
    const key = String(path ?? '').trim().replace(/^\/+/, '');
    // 경로 화이트리스트: 수집 산출물 프리픽스 밖(다른 S3 객체) 접근 차단
    if (!key.startsWith('news-crawler/') || key.split('/').includes('..')) {
      throw new BadRequestException(`허용되지 않는 path입니다: ${path}`);
    }

    let obj: Awaited<ReturnType<S3Service['getObjectForProxy']>>;
    try {
      obj = await this.s3Service.getObjectForProxy(key);
    } catch (e) {
      const name = (e as any)?.name ?? '';
      if (name === 'NoSuchKey' || name === 'NotFound') {
        throw new NotFoundException(`S3에 없는 파일입니다: /${key}`);
      }
      throw e;
    }

    const fileName = key.split('/').pop() ?? 'download';
    // 업로드 시 ContentType이 비었거나 octet-stream이면 확장자로 보정
    const contentType =
      obj.contentType && obj.contentType !== 'application/octet-stream'
        ? obj.contentType
        : lookup(fileName) || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    if (obj.contentLength != null) res.setHeader('Content-Length', String(obj.contentLength));
    if (obj.etag) res.setHeader('ETag', obj.etag);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );

    obj.body.on('error', (err) => {
      this.logger.error(`[media] S3 스트리밍 실패: /${key} — ${err.message}`);
      res.destroy(err);
    });
    obj.body.pipe(res);
  }

  // ─── 스프링 연동: 미디어(첨부) 업로드 관문 ─────────────────────────────────
  // 다운로드 관문의 반대 방향. 내부망 CMS(release)도 S3로 직접 못 나가므로,
  // NAS 저장을 마친 archive/·law/ 첨부를 이 서버로 넘기면 여기서 포털 버킷에
  // putObject 한다. (ES 파이프라인이 bucket+key로 읽어가는 사본)
  // 키는 CMS의 NAS 경로와 동일해야 정합이 맞으므로 재조립하지 않는다.

  @Post('media/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      // 메모리 버퍼 → 그대로 putObject. 문서 첨부라 수십 MB를 넘지 않는다.
      limits: { fileSize: MEDIA_UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
    }),
  )
  @ApiOperation({
    summary:
      '미디어(첨부) 업로드 관문 — 내부망 CMS → S3 putObject. ' +
      `key는 CMS가 준 값 그대로 사용하며 허용 prefix(${MEDIA_UPLOAD_PREFIXES.join('/')})만 받는다`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'key'],
      properties: {
        file: { type: 'string', format: 'binary', description: '업로드할 파일' },
        key: {
          type: 'string',
          example: 'archive/ab12cd34.pdf',
          description: 'S3 객체 키 (앞 / 없음). CMS의 NAS 저장 경로와 동일해야 한다',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: '업로드 성공',
    schema: { example: { success: true, key: 'archive/ab12cd34.pdf', etag: '"9f8e..."' } },
  })
  async uploadMedia(
    @UploadedFile() file: UploadedMediaFile,
    @Body('key') rawKey: string,
    @Res() res: Response,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('업로드할 file 파트가 없습니다 (빈 파일 포함)');
    }
    const key = this.assertUploadKey(rawKey);

    let result: Awaited<ReturnType<S3Service['putMediaObject']>>;
    try {
      result = await this.s3Service.putMediaObject(key, file.buffer, file.mimetype);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      this.logger.error(`[media/upload] S3 업로드 실패: ${key} — ${msg}`);
      throw new InternalServerErrorException(`S3 업로드에 실패했습니다: ${msg}`);
    }

    this.logger.log(`[media/upload] ${key} (${result.size}B) → s3://${result.bucket}/${key}`);
    // CMS가 기대하는 응답은 { success, key, etag } — 전역 인터셉터 래핑을 피해 직접 내려준다
    res.status(200).json({ success: true, key: result.key, etag: result.etag });
  }

  /**
   * 업로드 key 검증 — 수집 산출물/CMS 첨부 프리픽스 밖의 임의 객체 쓰기를 막는다.
   * (인증 없는 관문이라 prefix 화이트리스트가 유일한 방어선)
   */
  private assertUploadKey(rawKey: string): string {
    // file_path는 `/{key}` 형태라 CMS가 앞 /를 붙여 보내는 경우가 있어 그것만 허용 정규화한다
    const key = String(rawKey ?? '').trim().replace(/^\/+/, '');
    const segments = key.split('/');
    const invalid =
      !key ||
      key.length > 1024 || // S3 키 길이 상한
      key.includes('\\') ||
      /[\x00-\x1f]/.test(key) ||
      segments.length < 2 ||
      segments.some((s) => s === '' || s === '.' || s === '..') ||
      !MEDIA_UPLOAD_PREFIXES.includes(segments[0]);

    if (invalid) {
      throw new BadRequestException(
        `허용되지 않는 key입니다: ${rawKey} (허용 prefix: ${MEDIA_UPLOAD_PREFIXES.join(', ')})`,
      );
    }
    return key;
  }

  // ─── 스프링 연동: S3 meta.json → DB 적재용 정규화 JSON ─────────────────────

  @Get('articles/:originId')
  @ApiOperation({
    summary:
      'origin_id 기준 S3 meta.json을 DB 적재용(정규화) JSON으로 반환 — 스프링 뉴스 적재 배치 연동용. ' +
      'yna origin(YNA_ORIGIN_ID)이면 조회 전에 피드 수집을 먼저 실행하고 결과를 collect 필드로 함께 반환',
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
                fileName: 'xxx.jpg',
                mimeType: 'image/jpeg',
                downloadUrl:
                  '/scraper/media?path=%2Fnews-crawler%2Ffile%2F16%2F2026-07-12%2Fimg%2Fxxx.jpg',
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

  // ─── 수집기 자체 헬스체크 ───────────────────────────────────────────────────

  @Get('health')
  @ApiOperation({
    summary:
      '수집기 헬스체크 — 프로세스 생존 + Playwright 브라우저 연결 상태 확인 (pm2/모니터링 폴링용)',
  })
  @ApiResponse({
    status: 200,
    description: '수집기 상태 (브라우저가 끊겼으면 ok:false)',
    schema: {
      example: {
        ok: true,
        browserConnected: true,
        uptimeSec: 3600,
        timestamp: '2026-07-15 09:05:12',
      },
    },
  })
  scraperHealth() {
    const { browserConnected } = this.scraperService.getHealth();
    return {
      ok: browserConnected,
      browserConnected,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  // ─── 번역 앱 연결 테스트 ────────────────────────────────────────────────────

  @Get('translation/connection')
  @ApiOperation({
    summary:
      '번역 앱(dmz_translation) 연결체크 — 실제 번역 없이 도달 가능 여부만 확인 (5초 타임아웃)',
  })
  @ApiResponse({
    status: 200,
    description: '연결 상태 (다운이어도 200으로 reachable=false 반환)',
    schema: {
      example: {
        ok: true,
        translationApiUrl: 'http://localhost:3001',
        elapsedMs: 12,
        httpStatus: 404,
        message: '번역 앱 연결됨 (HTTP 404)',
      },
    },
  })
  async translationConnection() {
    const startedAt = Date.now();
    const result = await this.translationClient.checkConnection();
    return {
      ok: result.reachable,
      translationApiUrl: this.translationClient.baseURL,
      elapsedMs: Date.now() - startedAt,
      httpStatus: result.httpStatus,
      message: result.message,
    };
  }

  @Get('translation/test')
  @ApiOperation({
    summary: '분리된 번역 앱(dmz-translation) 연결 테스트 — 목데이터 번역 왕복 확인',
  })
  @ApiQuery({
    name: 'mock',
    required: false,
    enum: ['ko', 'en'],
    description:
      "ko(기본): 한글 목데이터로 실제 Gemini 번역까지 확인 / en: 영문 목데이터라 Gemini 호출 없이 HTTP 연결만 확인",
  })
  @ApiResponse({
    status: 200,
    description: '연결/번역 결과 (실패해도 200으로 원인 메시지 반환)',
    schema: {
      example: {
        ok: true,
        translationApiUrl: 'http://localhost:3100',
        elapsedMs: 1234,
        sent: { title: 'DMZ 평화의 길 운영 안내', writer: '홍길동 기자', content: '...' },
        received: { title_en: '...', writer_en: '...', content_en: '...' },
      },
    },
  })
  async testTranslationConnection(@Query('mock') mock?: string) {
    const sent =
      mock === 'en'
        ? {
            // 한국어가 없으면 번역 앱이 Gemini 호출 없이 그대로 반환 → 연결만 검증
            title: 'DMZ connectivity check',
            writer: 'Test Writer',
            content: 'This mock payload verifies the HTTP link only.',
          }
        : {
            title: 'DMZ 평화의 길 운영 안내',
            writer: '홍길동 기자',
            content: '비무장지대 생태 관광 프로그램이 시작됩니다.',
          };

    const startedAt = Date.now();
    try {
      const received = await this.translationClient.translateArticle(sent);
      return {
        ok: true,
        translationApiUrl: this.translationClient.baseURL,
        elapsedMs: Date.now() - startedAt,
        sent,
        received,
      };
    } catch (e) {
      return {
        ok: false,
        translationApiUrl: this.translationClient.baseURL,
        elapsedMs: Date.now() - startedAt,
        sent,
        error: (e as Error).message,
      };
    }
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
        skippedIrrelevant: 1,
        ambiguousKept: 0,
        saved: 1,
        imageUploaded: 2,
        translated: 1,
        dropped: [],
        errors: [],
      },
    },
  })
  async collectYnaFeed() {
    return this.ynaFeedService.collect();
  }

  @Get('yna/relevance-preview')
  @ApiOperation({
    summary:
      '현재 연합뉴스 피드의 DMZ 관련성 판정만 조회 (저장·번역 없음). ' +
      '무관 제외·확인 필요 건 확인용 일일 모니터링 API',
  })
  @ApiResponse({
    status: 200,
    description:
      '기사별 판정 결과 (by: anchor-keep | rule-drop | ambiguous-keep | default-keep). ' +
      'check = 규칙으로 못 거른 애매한 건(수집됨, 수동 확인 대상)',
    schema: {
      example: {
        totalItems: 30,
        keywordMatched: 4,
        keep: 3,
        drop: 1,
        check: 1,
        results: [
          {
            title: '스페인-모로코 접경서 난민 수백명 월경 시도',
            link: 'https://www.yna.co.kr/view/AKR...',
            matchedKeywords: ['접경'],
            relevant: false,
            by: 'rule-drop',
            reason: '해외 국경 이슈(스페인·모로코 국경, 난민·이민 이슈) — 한반도 앵커어 없음',
          },
        ],
      },
    },
  })
  async previewYnaRelevance() {
    return this.ynaFeedService.previewRelevance();
  }

  // ─── 연합뉴스 과거 XML 백필 ─────────────────────────────────────────────────

  @Get('yna/backfill')
  @ApiOperation({
    summary:
      'configs/yna/<월>/*.xml (연합뉴스 과거 아카이브)을 라이브 수집과 동일 스키마로 S3에 백필. ' +
      'KEYWORDS(제목+본문) 필터 적용, guid 중복만 스킵. DB 적재는 스프링 담당',
  })
  @ApiQuery({
    name: 'month',
    required: false,
    example: '202601',
    description: '특정 월(YYYYMM)만 백필. 생략 시 전체 월. 대량이므로 월 단위 호출 권장',
  })
  @ApiQuery({
    name: 'translate',
    required: false,
    example: 'true',
    description: "영문 번역 수행 여부 (기본 true). 'false'면 원문만 저장(빠름)",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    example: 50,
    description: '이번 호출에서 저장할 최대 신규 건수 (테스트/청크용)',
  })
  @ApiQuery({
    name: 'async',
    required: false,
    example: 'true',
    description:
      "'true'면 백그라운드로 실행하고 즉시 응답(진행은 서버 로그). 전체 백필처럼 오래 걸릴 때 사용",
  })
  @ApiResponse({
    status: 200,
    description: '백필 결과 요약',
    schema: {
      example: {
        originId: 25,
        month: '202601',
        translate: true,
        totalFiles: 138,
        parsed: 138,
        keywordMatched: 41,
        skippedNoKeyword: 97,
        skippedDuplicate: 0,
        saved: 41,
        imageUploaded: 63,
        translated: 41,
        parseErrors: 0,
        errors: [],
      },
    },
  })
  async backfillYna(
    @Query('month') month?: string,
    @Query('translate') translate?: string,
    @Query('limit') limit?: string,
    @Query('async') async?: string,
  ) {
    const opts = {
      month,
      translate: translate !== 'false',
      limit: limit ? Number(limit) : undefined,
    };

    // 백그라운드: 즉시 응답하고 서버에서 계속 실행 (HTTP 타임아웃 회피).
    // 서비스 자체 running 가드가 중복 실행을 막는다.
    if (async === 'true') {
      void this.ynaBackfillService
        .backfill(opts)
        .catch((e) =>
          this.logger.error(`[yna-backfill] 백그라운드 실행 실패: ${e.message}`),
        );
      return {
        started: true,
        mode: 'async',
        ...opts,
        message: '백그라운드로 백필 시작 — 진행 상황은 서버 로그를 확인하세요.',
      };
    }

    return this.ynaBackfillService.backfill(opts);
  }
}
