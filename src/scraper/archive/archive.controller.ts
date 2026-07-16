import {
  Controller,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Query,
  UseFilters,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HttpExceptionFilter } from 'src/common/filters/http-exception.filter';
import { KciCollectorService } from './kci-collector.service';
import { RissCollectorService } from './riss-collector.service';
import { NtisCollectorService } from './ntis-collector.service';
import { ArchiveExportService } from './archive-export.service';
import { ArchiveReportService } from './archive-report.service';
import { InstitutionClassifierService } from './institution-classifier.service';
import { ArchiveCollectOptions } from './archive.types';

/**
 * 자료마당(archive) 수집·조회 엔드포인트.
 * - /scraper/archive/{kci|riss|ntis}/collect : 수동 수집(백필 겸용, async=true 백그라운드)
 * - /scraper/archive/classify : 기관 분류기 단독 테스트
 * - /scraper/archives/:originId : 스프링 적재용 정규화 JSON (증분 폴링)
 */
@ApiTags('Archive')
@Controller('scraper')
@UseFilters(HttpExceptionFilter)
export class ArchiveController {
  private readonly logger = new Logger(ArchiveController.name);

  constructor(
    private readonly kciCollector: KciCollectorService,
    private readonly rissCollector: RissCollectorService,
    private readonly ntisCollector: NtisCollectorService,
    private readonly archiveExportService: ArchiveExportService,
    private readonly reportService: ArchiveReportService,
    private readonly classifier: InstitutionClassifierService,
  ) {}

  // ─── 수동 수집 (백필 겸용) ─────────────────────────────────────────────────

  @Get('archive/kci/collect')
  @ApiOperation({
    summary:
      'KCI 논문 즉시 수집 → 분류(발간자료/논문) → S3 meta.json 저장. ' +
      '백필은 파라미터 없이 async=true로 실행(전체 페이지). DB 적재는 스프링 담당',
  })
  @ApiQuery({ name: 'keyword', required: false, description: '특정 키워드만 (미지정 시 KEYWORDS 14개 전체)' })
  @ApiQuery({ name: 'maxPages', required: false, example: 1, description: '키워드당 최대 페이지 수 (테스트용)' })
  @ApiQuery({ name: 'pageSize', required: false, example: 100, description: 'KCI는 10/20/50/100만 유효' })
  @ApiQuery({ name: 'translate', required: false, example: 'true', description: "영문 번역 여부 (기본 true)" })
  @ApiQuery({ name: 'dryRun', required: false, example: 'false', description: "'true'면 저장 없이 파싱/분류 미리보기만" })
  @ApiQuery({ name: 'async', required: false, example: 'false', description: "'true'면 백그라운드 실행 + 즉시 응답 (백필용)" })
  async collectKci(
    @Query('keyword') keyword?: string,
    @Query('maxPages') maxPages?: string,
    @Query('pageSize') pageSize?: string,
    @Query('translate') translate?: string,
    @Query('dryRun') dryRun?: string,
    @Query('async') async?: string,
  ) {
    return this.runCollect('kci', (opts) => this.kciCollector.collect(opts), {
      keyword, maxPages, pageSize, translate, dryRun, async,
    });
  }

  @Get('archive/riss/collect')
  @ApiOperation({
    summary:
      'RISS(국내학술논문·학위논문·단행본) 즉시 수집 → 분류(단행본은 BOOKS 고정) → S3 저장. ' +
      '백필은 async=true로 실행. DB 적재는 스프링 담당',
  })
  @ApiQuery({ name: 'keyword', required: false })
  @ApiQuery({ name: 'maxPages', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 100 })
  @ApiQuery({ name: 'translate', required: false, example: 'true' })
  @ApiQuery({ name: 'dryRun', required: false, example: 'false' })
  @ApiQuery({ name: 'async', required: false, example: 'false' })
  async collectRiss(
    @Query('keyword') keyword?: string,
    @Query('maxPages') maxPages?: string,
    @Query('pageSize') pageSize?: string,
    @Query('translate') translate?: string,
    @Query('dryRun') dryRun?: string,
    @Query('async') async?: string,
  ) {
    return this.runCollect('riss', (opts) => this.rissCollector.collect(opts), {
      keyword, maxPages, pageSize, translate, dryRun, async,
    });
  }

  @Get('archive/ntis/collect')
  @ApiOperation({
    summary:
      'NTIS 국가R&D 연구보고서 즉시 수집 → 분류 → S3 저장. ' +
      '⚠️ NTIS는 활용신청 시 등록한 IP에서만 호출 가능 (로컬은 "접근 허용 IP가 아닙니다" 정상). ' +
      '백필은 async=true로 실행. DB 적재는 스프링 담당',
  })
  @ApiQuery({ name: 'keyword', required: false })
  @ApiQuery({ name: 'maxPages', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 100 })
  @ApiQuery({ name: 'translate', required: false, example: 'true' })
  @ApiQuery({ name: 'dryRun', required: false, example: 'false' })
  @ApiQuery({ name: 'async', required: false, example: 'false' })
  async collectNtis(
    @Query('keyword') keyword?: string,
    @Query('maxPages') maxPages?: string,
    @Query('pageSize') pageSize?: string,
    @Query('translate') translate?: string,
    @Query('dryRun') dryRun?: string,
    @Query('async') async?: string,
  ) {
    return this.runCollect('ntis', (opts) => this.ntisCollector.collect(opts), {
      keyword, maxPages, pageSize, translate, dryRun, async,
    });
  }

  // ─── 저장 현황 리포트 (프로젝트 루트 텍스트 파일) ──────────────────────────

  @Get('archive/report')
  @ApiOperation({
    summary:
      'S3에 저장된 아카이브 전체 현황(제목+메타+분류근거)을 프로젝트 루트에 archive-report-{source}.txt로 출력. ' +
      '수집 완료 시 자동 생성되지만, 이미 저장된 데이터만 다시 뽑고 싶을 때 수동 호출',
  })
  @ApiQuery({ name: 'source', required: true, example: 'kci', description: 'kci | riss | ntis' })
  @ApiResponse({
    status: 200,
    schema: { example: { filePath: '/home/ubuntu/dmz_scraper/archive-report-kci.txt', total: 1522 } },
  })
  async writeReport(@Query('source') source: string) {
    return this.reportService.writeReportBySource(source);
  }

  // ─── 기관 분류기 단독 테스트 ───────────────────────────────────────────────

  @Get('archive/classify')
  @ApiOperation({
    summary:
      '발행기관 분류기 테스트 — 사전/패턴/Gemini 폴백 중 어느 경로로 GOV/PRIVATE 판정되는지 확인',
  })
  @ApiQuery({ name: 'publisher', required: true, example: '통일연구원' })
  @ApiResponse({
    status: 200,
    schema: { example: { publisher: '통일연구원', verdict: 'GOV', by: 'dict', menuIdIfNotBook: 'PUBLICATIONS' } },
  })
  async classify(@Query('publisher') publisher: string) {
    const result = await this.classifier.classify(publisher ?? '');
    await this.classifier.flushCache();
    return {
      publisher,
      ...result,
      menuIdIfNotBook: result.verdict === 'GOV' ? 'PUBLICATIONS' : 'PAPERS',
    };
  }

  // ─── 스프링 연동: S3 meta.json → archive 테이블 적재용 정규화 JSON ─────────

  @Get('archives/:originId')
  @ApiOperation({
    summary:
      'origin_id 기준 아카이브 meta.json을 DB 적재용(정규화) JSON으로 반환 — 스프링 archive 적재 배치 연동용',
  })
  @ApiParam({ name: 'originId', type: Number, example: 27, description: 'RISS=26, KCI=27, NTIS=28 (env)' })
  @ApiQuery({
    name: 'since',
    required: false,
    example: '2026-07-15 00:00:00',
    description: '이 시각(KST) 이후에 수집 완료된 자료만 반환 (증분 폴링용). 생략 시 전체 반환',
  })
  @ApiResponse({
    status: 200,
    description: '적재용 아카이브 목록',
    schema: {
      example: {
        originId: 27,
        source: 'kci',
        since: null,
        total: 1,
        items: [
          {
            originId: 27,
            source: 'kci',
            dedupKey: 'KCI:ART003027350',
            menuId: 'PAPERS',
            title: 'DMZ(Demilitarized Zone) 접경지역의 문화서비스 평가',
            titleEn: 'Cultural Services Assessment in DMZ Border Areas',
            publisher: '한국조경학회',
            publisherEn: 'Korean Society of Landscape Architecture',
            publishYear: '2023',
            author: '고하정, 권혁수, 김정인',
            authorEn: 'Ko, Ha-jung, Kwon, Hyuk-Soo, Kim, Jung-In',
            category: '조경학',
            categoryEn: 'Landscape Architecture',
            subCategory: '한국조경학회지 51(6)',
            subCategoryEn: null,
            viewLocation: null,
            hasFile: 'X',
            summary: '본 연구는 접경지역 문화서비스 평가를 통해…',
            summaryEn: 'This study examines…',
            linkUrl: 'https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=ART003027350',
            registerNo: 'KCI:ART003027350',
            callNo: null,
            filePath: null,
            remark: 'KCI OpenAPI 수집',
            isbn: null,
            coverUrl: null,
            useYn: 'Y',
            rgtrId: 'admin',
            trslYn: 'Y',
            collectedAt: '2026-07-16 03:05:12',
          },
        ],
      },
    },
  })
  async exportArchives(
    @Param('originId', ParseIntPipe) originId: number,
    @Query('since') since?: string,
  ) {
    return this.archiveExportService.exportArchives(originId, since);
  }

  // ─── 공통 실행 헬퍼 ────────────────────────────────────────────────────────

  private runCollect(
    source: string,
    run: (opts: ArchiveCollectOptions) => Promise<any>,
    query: {
      keyword?: string; maxPages?: string; pageSize?: string;
      translate?: string; dryRun?: string; async?: string;
    },
  ) {
    const opts: ArchiveCollectOptions = {
      keyword: query.keyword || undefined,
      maxPages: query.maxPages ? Number(query.maxPages) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
      translate: query.translate !== 'false',
      dryRun: query.dryRun === 'true',
    };

    // 백그라운드: 즉시 응답하고 서버에서 계속 실행 (HTTP 타임아웃 회피, yna/backfill 패턴).
    // 서비스 자체 running 가드가 중복 실행을 막는다.
    if (query.async === 'true') {
      void run(opts).catch((e) =>
        this.logger.error(`[archive:${source}] 백그라운드 수집 실패: ${e.message}`),
      );
      return {
        started: true,
        mode: 'async',
        source,
        ...opts,
        message: '백그라운드로 수집 시작 — 진행 상황은 서버 로그를 확인하세요.',
      };
    }

    return run(opts);
  }
}
