import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'mime-types';
import moment from 'moment';
import { S3Service } from 'src/aws/s3/s3.service';
import { YnaFeedService } from './yna-feed.service';
import { JsonConfigService } from './json-config.service';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff']);
const FILE_EXTS = new Set([
  'pdf', 'hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', '7z', 'txt', 'csv', 'rtf', 'odt',
]);

// [임시] yna 라이브 피드가 403으로 막혀있어 선행 수집을 끈다.
// origin 25 조회 시 외부 yna API를 부르지 않고 S3 적재분만 반환한다.
// 피드가 정상화되면 true로 되돌릴 것.
const YNA_PRECOLLECT_ENABLED = false;

// [임시] 스프링 전체 재적재 기간 동안 since 증분 필터를 끈다.
// false면 since 파라미터가 와도 무시하고 전체를 반환한다 (응답에 sinceIgnored: true 표시).
// 스프링 중복 규칙(origin+title+일자)이 이중 적재를 막으므로 안전. 재적재 끝나면 true로 되돌릴 것.
const SINCE_FILTER_ENABLED = true;

const DT_FORMAT = 'YYYY-MM-DD HH:mm:ss';
// writedate 파싱 실패 시 쓰는 고정 sentinel. now(비결정적)를 쓰면 조회마다
// 날짜가 달라져 스프링 쪽 중복 검사(제목+일자)가 빗나가므로, 결정적 값으로 고정한다.
// 파싱 실패분은 regDtParsed=false 로 표시되며 reg_dt < '2000-01-01' 로 추려 보정 가능.
const UNPARSEABLE_DATE = '1970-01-01 00:00:00';

export interface ExportedFile {
  filePath: string; // DB news_file.file_path 형식 (/news-crawler/... — 버킷 제거)
  fileUrl: string | null; // 원 사이트의 파일 URL
  fileTy: 'image' | 'file';
  sortOrder: number;
  fileName: string; // 원본 파일명 (meta의 originalName, 없으면 S3 키의 basename)
  mimeType: string; // 확장자 기반 추정 MIME 타입
  // 내부망(스프링)은 S3에 직접 못 나가므로, 이 수집서버를 관문으로 쓰는
  // 프록시 다운로드 경로. 폴링과 같은 호스트에 이 상대경로만 붙여 GET 하면 된다.
  downloadUrl: string;
}

export interface ExportedArticle {
  originId: number;
  title: string | null;
  contentText: string | null;
  linkUrl: string | null;
  writer: string;
  regDt: string; // YYYY-MM-DD HH:mm:ss (기사 작성일, 파싱 실패 시 sentinel)
  regDtParsed: boolean;
  langCode: 'ko';
  trslYn: 'Y' | 'N';
  titleEn: string | null;
  contentTextEn: string | null;
  collectedAt: string | null; // meta.json S3 저장 시각 (KST)
  files: ExportedFile[];
  skippedFiles: number; // 허용 확장자가 아니어서 제외된 파일 수
}

/**
 * S3의 meta.json을 스프링(외부 적재기)이 바로 news/news_file에 넣을 수 있는
 * DB-ready 형태로 정규화해 반환한다. 날짜 파싱·file_path 변환·trsl_yn 판정 등
 * 적재 비즈니스 규칙은 전부 여기서 끝내서 스프링이 재구현하지 않게 한다.
 */
@Injectable()
export class ArticleExportService {
  private readonly logger = new Logger(ArticleExportService.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly configService: ConfigService,
    private readonly ynaFeedService: YnaFeedService,
    private readonly jsonConfigService: JsonConfigService,
  ) {}

  async exportArticles(originId: number, since?: string) {
    let sinceDate: Date | undefined;
    if (since) {
      const m = moment(since, ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD', moment.ISO_8601], true);
      if (!m.isValid()) {
        throw new BadRequestException(
          `since 형식이 잘못되었습니다: "${since}" (YYYY-MM-DD 또는 YYYY-MM-DD HH:mm:ss)`,
        );
      }
      sinceDate = m.toDate();
    }

    // [임시] since 필터 비활성화 — 전체 반환 (파라미터 검증은 위에서 그대로 수행)
    if (!SINCE_FILTER_ENABLED && sinceDate) {
      this.logger.warn(
        `[articles] origin=${originId} since=${since} 무시 — 전체 반환 (SINCE_FILTER_ENABLED=false)`,
      );
      sinceDate = undefined;
    }

    // 등록된 origin(config의 origin_id 또는 YNA_ORIGIN_ID)이 아니면 S3 조회 없이 빈 결과 반환.
    // 스프링이 news_origin 전체를 순회 호출해도 스크래퍼 미등록 origin은 스캔 비용 없이 걸러진다.
    if (!this.isKnownOrigin(originId)) {
      this.logger.warn(`[articles] 등록되지 않은 origin_id=${originId} → 조회 생략, 빈 결과 반환`);
      return {
        originId,
        since: since ?? null,
        total: 0,
        knownOrigin: false,
        articles: [],
      };
    }

    // yna origin이면 조회 전에 피드 수집을 한 번 실행해 이번 응답에 최신분까지 포함시킨다.
    // 수집 실패(피드 403 등)여도 조회는 계속하고, 결과/실패 사유는 collect 필드로 노출한다.
    const collect = await this.collectIfYna(originId);

    const entries = await this.s3Service.listArticleMetaEntries(originId, sinceDate);
    const articles = entries.map(({ meta, lastModified }) =>
      this.toDbReady(originId, meta, lastModified),
    );

    this.logger.log(
      `[articles] origin=${originId} since=${since ?? '-'} → ${articles.length}건 반환` +
      (collect ? ` (yna 수집 선행: ${collect.ok ? '성공' : '실패'})` : ''),
    );

    return {
      originId,
      since: since ?? null,
      ...(since && !SINCE_FILTER_ENABLED ? { sinceIgnored: true } : {}),
      total: articles.length,
      ...(collect ? { collect } : {}),
      articles,
    };
  }

  /** 스크래퍼가 아는 origin인지: config들의 origin_id 또는 YNA_ORIGIN_ID */
  private isKnownOrigin(originId: number): boolean {
    if (originId === this.ynaOriginId()) return true;
    return this.jsonConfigService
      .findAll()
      .some((config) => Number(config.origin_id) === originId);
  }

  private ynaOriginId(): number | null {
    const id = Number(this.configService.get('YNA_ORIGIN_ID'));
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  /**
   * originId가 YNA_ORIGIN_ID면 피드 수집을 동기 실행하고 요약을 반환.
   * yna가 아니면 null. 크론과 겹치면 collect() 자체가 skipped를 반환한다.
   */
  private async collectIfYna(
    originId: number,
  ): Promise<{ ok: boolean; summary?: Record<string, any>; error?: string } | null> {
    // [임시] 선행 수집 비활성화 — S3 적재분만 반환 (yna 피드 403 회피)
    if (!YNA_PRECOLLECT_ENABLED) return null;
    if (originId !== this.ynaOriginId()) return null;

    try {
      const summary = await this.ynaFeedService.collect();
      return { ok: true, summary };
    } catch (e) {
      const error = (e as Error).message;
      this.logger.warn(`[articles] yna 선행 수집 실패 (조회는 계속): ${error}`);
      return { ok: false, error };
    }
  }

  private toDbReady(
    originId: number,
    meta: Record<string, any>,
    lastModified: Date | null,
  ): ExportedArticle {
    const parsedDate = this.parseWritedate(meta.writedate);
    const { files, skipped } = this.buildFileRows(meta);

    const trslYn =
      String(meta.title_en ?? '').trim() || String(meta.content_text_en ?? '').trim()
        ? 'Y'
        : 'N';

    return {
      originId,
      title: meta.title ?? null,
      contentText: meta.content ?? null,
      linkUrl: meta.currentUrl ?? null,
      writer: meta.writer ?? '',
      regDt: parsedDate ?? UNPARSEABLE_DATE,
      regDtParsed: parsedDate !== null,
      langCode: 'ko',
      trslYn,
      titleEn: meta.title_en ?? null,
      contentTextEn: meta.content_text_en ?? null,
      collectedAt: lastModified ? moment(lastModified).format(DT_FORMAT) : null,
      files,
      skippedFiles: skipped,
    };
  }

  /** meta.json의 img/file 배열 → 적재용 파일 목록. 허용 확장자가 아니면 스킵. */
  private buildFileRows(meta: Record<string, any>): { files: ExportedFile[]; skipped: number } {
    const files: ExportedFile[] = [];
    let skipped = 0;

    const push = (items: any[]) => {
      let sortOrder = 0;
      for (const item of items ?? []) {
        if (!item?.s3Path) continue;
        const fileTy = this.classifyByExtension(item.s3Path);
        if (fileTy === null) {
          skipped++;
          continue;
        }
        const filePath = this.toDbFilePath(item.s3Path);
        const fileName =
          String(item.originalName ?? '').trim() ||
          (filePath.split('?')[0].split('/').pop() ?? 'download');
        files.push({
          filePath,
          fileUrl: item.url ?? null,
          fileTy,
          sortOrder: sortOrder++,
          fileName,
          mimeType: lookup(filePath.split('?')[0]) || 'application/octet-stream',
          downloadUrl: `/scraper/media?path=${encodeURIComponent(filePath)}`,
        });
      }
    };

    push(meta.img);
    push(meta.file);
    return { files, skipped };
  }

  /** 확장자 기준 분류. 이미지 → image, 문서류 → file, 그 외(.do 등) → null(제외) */
  private classifyByExtension(s3Path: string): 'image' | 'file' | null {
    const ext = s3Path.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (FILE_EXTS.has(ext)) return 'file';
    return null;
  }

  /** s3://bucket/key → /key (버킷 제거, 선행 슬래시 유지) */
  private toDbFilePath(s3Path: string): string {
    const key = s3Path.replace(/^s3:\/\/[^/]+/, '');
    return key.startsWith('/') ? key : `/${key}`;
  }

  /** writedate('2025-06-13', '20250613', '2025.6.13 15:30', '2025년 6월 13일' 등)
   *  → 'YYYY-MM-DD HH:mm:ss'. 시각 정보가 있으면 유지(yna 등), 없으면 00:00:00.
   *  파싱 실패 시 null */
  private parseWritedate(writedate?: string): string | null {
    if (!writedate) return null;
    const raw = String(writedate).trim();
    const m = moment(
      raw,
      [
        'YYYY-MM-DD', 'YYYYMMDD', 'YYYY.MM.DD', 'YYYY/MM/DD',
        'YYYY-M-D', 'YYYY.M.D', 'YYYY/M/D',
        'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm',
        'YYYY.MM.DD HH:mm:ss', 'YYYY.MM.DD HH:mm',
        'YYYY/MM/DD HH:mm:ss', 'YYYY/MM/DD HH:mm',
        'YYYY년 M월 D일', 'YYYY년 MM월 DD일',
      ],
      true,
    );
    if (!m.isValid()) return null;
    const hasTime = /\d{1,2}:\d{2}/.test(raw);
    return (hasTime ? m : m.startOf('day')).format(DT_FORMAT);
  }
}
