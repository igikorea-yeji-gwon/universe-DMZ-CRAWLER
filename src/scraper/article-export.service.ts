import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import moment from 'moment';
import { S3Service } from 'src/aws/s3/s3.service';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff']);
const FILE_EXTS = new Set([
  'pdf', 'hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', '7z', 'txt', 'csv', 'rtf', 'odt',
]);

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

  constructor(private readonly s3Service: S3Service) {}

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

    const entries = await this.s3Service.listArticleMetaEntries(originId, sinceDate);
    const articles = entries.map(({ meta, lastModified }) =>
      this.toDbReady(originId, meta, lastModified),
    );

    this.logger.log(
      `[articles] origin=${originId} since=${since ?? '-'} → ${articles.length}건 반환`,
    );

    return {
      originId,
      since: since ?? null,
      total: articles.length,
      articles,
    };
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
        files.push({
          filePath: this.toDbFilePath(item.s3Path),
          fileUrl: item.url ?? null,
          fileTy,
          sortOrder: sortOrder++,
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
