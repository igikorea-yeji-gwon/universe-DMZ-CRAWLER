import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { CubridService } from 'src/database/cubrid.service';

@Injectable()
export class NewsSyncService {
  private readonly logger = new Logger(NewsSyncService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  // origin_id별 캐시
  private originCache   = new Map<number, { originNm: string; categoryNm: string; categoryId: string }>();

  constructor(
    private readonly cubridService: CubridService,
    private readonly configService: ConfigService,
  ) {
    this.s3 = new S3Client({
      region: configService.get('AWS_REGION'),
      credentials: {
        accessKeyId:     configService.get('AWS_ACCESS_KEY_ID')!,
        secretAccessKey: configService.get('AWS_SECRET_ACCESS_KEY')!,
      },
    });
    this.bucket = configService.get('AWS_BUCKET_NAME')!;
  }

  /** S3 meta.json → DB 일괄 동기화 */
  async syncOriginToDb(originId: number): Promise<{ inserted: number; skipped: number; failed: number }> {
    const metaKeys = await this.listMetaKeys(originId);
    this.logger.log(`[origin ${originId}] meta.json ${metaKeys.length}개 발견`);

    let inserted = 0, skipped = 0, failed = 0;

    for (const key of metaKeys) {
      try {
        const meta = await this.downloadMeta(key);
        if (!meta?.title?.trim()) { skipped++; continue; }

        const newsId = await this.insertNews(meta, originId);
        if (newsId) {
          await this.insertNewsFiles(newsId, meta.img || []);
          inserted++;
        } else {
          skipped++;
        }
      } catch (err) {
        this.logger.error(`삽입 실패 (${key}): ${err.message}`);
        failed++;
      }
    }

    this.logger.log(`[origin ${originId}] 완료: ${inserted}건 삽입 / ${skipped}건 스킵 / ${failed}건 실패`);
    return { inserted, skipped, failed };
  }

  private async listMetaKeys(originId: number): Promise<string[]> {
    const prefix = `news-crawler/articles/${originId}/`;
    const keys: string[] = [];
    let token: string | undefined;

    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key?.endsWith('meta.json')) keys.push(obj.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    return keys;
  }

  private async downloadMeta(key: string): Promise<any> {
    const res  = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = await res.Body?.transformToString('utf-8');
    return JSON.parse(body ?? '{}');
  }

  private async getOriginInfo(originId: number) {
    if (this.originCache.has(originId)) return this.originCache.get(originId)!;

    const [originRows, categoryRows] = await Promise.all([
      this.cubridService.queryAll(
        `SELECT origin_nm FROM news_origin WHERE origin_id = ${originId} AND use_yn = 'Y'`,
      ),
      this.cubridService.queryAll(`
        SELECT nc.category_nm, nc.cateogory_code
        FROM news_origin o
        JOIN news_category nc ON o.category_code = nc.cateogory_code
        WHERE o.origin_id = ${originId}
      `),
    ]);

    const info = {
      originNm:   originRows?.[0]?.origin_nm    ?? '',
      categoryNm: categoryRows?.[0]?.category_nm ?? '',
      categoryId: categoryRows?.[0]?.cateogory_code ?? '',
    };

    if (info.originNm) this.originCache.set(originId, info);
    return info;
  }

  private async insertNews(meta: any, originId: number): Promise<number> {
    const title   = (meta.title ?? '').trim();
    const content = this.cleanContent(meta.content ?? '');
    const linkUrl = meta.currentUrl ?? '';
    const regDt   = this.toDatetime(meta.writedate);
    const now     = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const firstImg = Array.isArray(meta.img) ? meta.img[0] : null;
    const filePath = firstImg?.s3Path ? this.extractFilePath(firstImg.s3Path) : '';

    const { originNm, categoryNm, categoryId } = await this.getOriginInfo(originId);
    const escaped = title.replace(/'/g, "''");

    await this.cubridService.execute(`
      INSERT INTO news (
        title, content_text, origin_id, origin_nm, link_url,
        category_nm, category_id, lang_code,
        trsl_yn, use_yn, file_path,
        rgtr_id, reg_dt, mdfr_id, mdfcn_dt
      )
      SELECT ?, ?, ?, ?, ?,
             ?, ?, 'ko',
             'N', 'Y', ?,
             'admin', ?, 'admin', ?
      FROM db_root
      WHERE NOT EXISTS (
        SELECT 1 FROM news
        WHERE origin_id = ${originId} AND title = '${escaped}' AND reg_dt = '${regDt}'
      )
    `, [title, content, originId, originNm, linkUrl, categoryNm, categoryId, filePath, regDt, now]);

    const rows = await this.cubridService.queryAll(
      `SELECT news_id FROM news WHERE origin_id = ${originId} AND title = '${escaped}' AND reg_dt = '${regDt}'`,
    );
    return rows?.[0]?.news_id ?? 0;
  }

  private async insertNewsFiles(newsId: number, imgs: any[]): Promise<void> {
    if (!newsId || !imgs.length) return;

    const imageExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp']);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (!img?.s3Path) continue;

      const filePath = this.extractFilePath(img.s3Path);
      if (!filePath) continue;

      const ext    = filePath.split('.').pop()?.toLowerCase() ?? '';
      const fileTy = imageExts.has(ext) ? 'image' : 'file';

      await this.cubridService.execute(`
        INSERT INTO news_file (news_id, file_path, file_url, file_ty, sort_order, use_yn, rgtr_id, reg_dt)
        SELECT ?, ?, ?, ?, ?, 'Y', 'admin', ?
        FROM db_root
        WHERE NOT EXISTS (
          SELECT 1 FROM news_file WHERE news_id = ? AND file_path = ?
        )
      `, [newsId, filePath, img.url ?? '', fileTy, i, now, newsId, filePath]);
    }
  }

  private cleanContent(content: string): string {
    return content
      .replace(/\\r\\n|\\r|\r\n|\r/g, '\n')
      .replace(/\\n|\n/g, '<br>')
      .replace(/\\t|\t/g, ' ')
      .replace(/(<br>\s*){3,}/g, '<br><br>')
      .trim();
  }

  private extractFilePath(s3Path: string): string {
    const idx = s3Path.indexOf('/news-crawler/');
    return idx >= 0 ? s3Path.slice(idx) : '';
  }

  private toDatetime(writedate?: string): string {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (!writedate || writedate.length < 8) return now;
    return `${writedate.slice(0, 4)}-${writedate.slice(4, 6)}-${writedate.slice(6, 8)} 00:00:00`;
  }
}
