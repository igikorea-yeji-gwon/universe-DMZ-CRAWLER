import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import moment from 'moment';
import { CubridService } from 'src/database/cubrid.service';
import { S3Service } from 'src/aws/s3/s3.service';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff']);
const FILE_EXTS = new Set([
  'pdf', 'hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', '7z', 'txt', 'csv', 'rtf', 'odt',
]);

const RGTR_ID = 'admin';
const LANG_CODE = 'ko';
const DT_FORMAT = 'YYYY-MM-DD HH:mm:ss';
// writedate 파싱 실패 시 쓰는 고정 sentinel. now(비결정적)를 쓰면 재실행마다
// 날짜가 달라져 중복 검사(CAST(reg_dt AS DATE))가 빗나가므로, 결정적 값으로 고정한다.
// 파싱 실패분은 reg_dt < '2000-01-01'로 추려 나중에 포맷 보정 가능.
const UNPARSEABLE_DATE = '1970-01-01 00:00:00';

interface FileRow {
  filePath: string;
  fileUrl: string | null;
  fileTy: 'image' | 'file';
  sortOrder: number;
}

@Injectable()
export class NewsDbService {
  private readonly logger = new Logger(NewsDbService.name);

  constructor(
    private readonly cubridService: CubridService,
    private readonly s3Service: S3Service,
  ) {}

  /**
   * S3에 적재된 meta.json들을 읽어 CUBRID의 news / news_file 테이블에 적재한다.
   * 중복(link_url 기준)은 스킵한다.
   */
  async loadArticlesToDb(originId: number) {
    this.logger.log(`[download2] origin=${originId} 적재 시작: S3 meta.json 조회 중`);
    const metas = await this.s3Service.listArticleMetasByOrigin(originId);
    this.logger.log(`[download2] origin=${originId} meta.json ${metas.length}건 조회 완료`);

    const client = this.cubridService.createClient();
    await client.connect();
    this.logger.log(`[download2] CUBRID 연결 성공`);

    let inserted = 0;
    let skippedDuplicate = 0;
    let fileInserted = 0;
    let fileSkipped = 0;
    const errors: { link_url: string; message: string }[] = [];

    try {
      const origin = await this.findOrigin(client, originId);
      const category = await this.findCategory(client, origin.category_code);

      // 같은 기사가 URL 파라미터만 다른 채로 여러 번 수집될 수 있으므로(page=, searchKeyword= 등)
      // link_url이 아닌 제목+작성자+등록일자를 중복 키로 쓴다.
      const seenInBatch = new Set<string>();

      for (const meta of metas) {
        const linkUrl: string = meta.currentUrl ?? null;

        const now = moment().format(DT_FORMAT);
        const parsedDate = this.parseWritedate(meta.writedate);
        if (!parsedDate) {
          this.logger.warn(
            `[download2] writedate 파싱 실패 → sentinel(${UNPARSEABLE_DATE}) 적용: ` +
            `"${meta.writedate ?? ''}" (${meta.title ?? ''})`,
          );
        }
        const regDt = parsedDate ?? UNPARSEABLE_DATE;

        const batchKey = `${meta.title ?? ''}|${meta.writer ?? ''}|${regDt.slice(0, 10)}`;
        if (seenInBatch.has(batchKey)) {
          skippedDuplicate++;
          this.logger.log(`[download2] 배치 내 중복 스킵: "${meta.title ?? ''}" (${regDt.slice(0, 10)})`);
          continue;
        }
        seenInBatch.add(batchKey);

        const dup = await this.queryRows(
          client,
          `SELECT news_id FROM news
           WHERE origin_id = ? AND title = ? AND CAST(reg_dt AS DATE) = CAST(? AS DATE)
           LIMIT 1`,
          [originId, meta.title ?? null, regDt],
        );
        if (dup.length > 0) {
          skippedDuplicate++;
          this.logger.log(
            `[download2] 중복 스킵 (news_id=${dup[0].news_id ?? dup[0].NEWS_ID}): "${meta.title ?? ''}" (${regDt.slice(0, 10)})`,
          );
          continue;
        }

        const fileRows = this.buildFileRows(meta);
        fileSkipped += fileRows.skipped;

        // 번역 성공(영문 필드 존재) 여부에 따라 trsl_yn 결정
        const trslYn =
          String(meta.title_en ?? '').trim() || String(meta.content_text_en ?? '').trim()
            ? 'Y'
            : 'N';

        await client.beginTransaction();
        try {
          // news_id/file_id는 자동 생성이 아니므로 MAX+1로 직접 채번한다.
          const newsId = await this.nextId(client, 'SELECT COALESCE(MAX(news_id), 0) + 1 AS next_id FROM news');

          await client.execute(
            `INSERT INTO news (
               news_id, title, content_text, origin_id, origin_nm, link_url,
               category_nm, category_id, lang_code, trsl_yn, use_yn,
               file_path, rgtr_id, reg_dt, mdfr_id, mdfcn_dt,
               title_en, content_text_en, origin_nm_en, category_nm_en, crawl_dt
             ) VALUES (
               ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?
             )`,
            [
              newsId,
              meta.title ?? null,
              meta.content ?? null,
              originId,
              origin.origin_nm,
              linkUrl,
              category?.category_nm ?? null,
              origin.category_code,
              LANG_CODE,
              trslYn,
              'Y',
              null,
              RGTR_ID,
              regDt,
              RGTR_ID,
              now,
              meta.title_en ?? null,
              meta.content_text_en ?? null,
              origin.origin_nm_en ?? null,
              category?.category_nm_en ?? null,
              now,
            ],
          );

          let fileId = await this.nextId(client, 'SELECT COALESCE(MAX(file_id), 0) + 1 AS next_id FROM news_file');
          for (const row of fileRows.rows) {
            await client.execute(
              `INSERT INTO news_file (
                 file_id, news_id, file_path, file_url, file_ty, sort_order,
                 use_yn, rgtr_id, reg_dt, lang_code
               ) VALUES (?, ?, ?, ?, ?, ?, 'Y', ?, ?, ?)`,
              [fileId++, newsId, row.filePath, row.fileUrl, row.fileTy, row.sortOrder, RGTR_ID, now, LANG_CODE],
            );
            fileInserted++;
          }

          await client.commit();
          inserted++;
          this.logger.log(
            `[download2] 적재 완료 news_id=${newsId} (파일 ${fileRows.rows.length}건) "${meta.title ?? ''}"`,
          );
        } catch (e) {
          await client.rollback().catch(() => undefined);
          this.logger.error(`[download2] 적재 실패, 롤백됨 (${linkUrl}): ${e.message}`);
          errors.push({ link_url: linkUrl, message: e.message });
        }
      }
    } finally {
      await client.close().catch(() => undefined);
    }

    this.logger.log(
      `[download2] origin=${originId} 적재 종료: 전체 ${metas.length}건 중 ` +
      `신규 ${inserted}건, 중복스킵 ${skippedDuplicate}건, 실패 ${errors.length}건 ` +
      `(파일 적재 ${fileInserted}건, 확장자 제외 ${fileSkipped}건)`,
    );

    return {
      originId,
      totalMeta: metas.length,
      inserted,
      skippedDuplicate,
      fileInserted,
      fileSkipped,
      errors,
    };
  }

  private async queryRows(client: any, sql: string, params?: any[]): Promise<any[]> {
    const rows = await client.queryAllAsObjects(sql, params);
    return rows ?? [];
  }

  private async nextId(client: any, sql: string): Promise<number> {
    const rows = await this.queryRows(client, sql);
    return Number(rows[0]?.next_id ?? rows[0]?.NEXT_ID ?? 1);
  }

  private async findOrigin(client: any, originId: number) {
    const rows = await this.queryRows(
      client,
      'SELECT origin_id, origin_nm, origin_nm_en, category_code FROM news_origin WHERE origin_id = ?',
      [originId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`news_origin에 origin_id=${originId}가 없습니다.`);
    }
    return rows[0];
  }

  private async findCategory(client: any, categoryCode: string | null) {
    if (!categoryCode) return null;
    const rows = await this.queryRows(
      client,
      'SELECT category_code, category_nm, category_nm_en FROM news_category WHERE category_code = ?',
      [categoryCode],
    );
    return rows[0] ?? null;
  }

  /** meta.json의 img/file 배열 → news_file 행 목록. 허용 확장자가 아니면 스킵. */
  private buildFileRows(meta: Record<string, any>): { rows: FileRow[]; skipped: number } {
    const rows: FileRow[] = [];
    let skipped = 0;

    const push = (items: any[]) => {
      let sortOrder = 0;
      for (const item of items ?? []) {
        if (!item?.s3Path) continue;
        const fileTy = this.classifyByExtension(item.s3Path);
        if (fileTy === null) {
          skipped++;
          this.logger.warn(`[download2] 허용되지 않는 확장자, 파일 제외: ${item.s3Path}`);
          continue;
        }
        rows.push({
          filePath: this.toDbFilePath(item.s3Path),
          fileUrl: item.url ?? null,
          fileTy,
          sortOrder: sortOrder++,
        });
      }
    };

    push(meta.img);
    push(meta.file);
    return { rows, skipped };
  }

  /** 확장자 기준 분류. 이미지 → image, 문서류 → file, 그 외(.do 등) → null(적재 제외) */
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
   *  → 'YYYY-MM-DD 00:00:00'(일 단위 정규화), 파싱 실패 시 null */
  private parseWritedate(writedate?: string): string | null {
    if (!writedate) return null;
    const m = moment(
      String(writedate).trim(),
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
    return m.isValid() ? m.startOf('day').format(DT_FORMAT) : null;
  }
}
