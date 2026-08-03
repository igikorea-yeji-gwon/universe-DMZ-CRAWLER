import { BadRequestException, Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  PutObjectCommandInput,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as stream from 'stream';
import { Upload } from '@aws-sdk/lib-storage';
import { v4 as uuid } from 'uuid';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { UploadToS3Params } from './types/s3.type';
import moment from 'moment';
import { DetailScrapedData } from 'src/news/news.entity';
import * as fs from 'fs/promises';
import { Readable } from 'stream';
import * as path from 'path';
import * as mime from 'mime';
import { lookup } from 'mime-types';
import { buffer as consume } from 'node:stream/consumers';

@Injectable()
export class S3Service {
  private s3: S3Client;
  private readonly failurePrefix = 'WeatherSatellite/_failures';

  constructor(private readonly configService: ConfigService) {
    // const useIamRole = !this.configService.get('AWS_ACCESS_KEY_ID');
    this.s3 = new S3Client({
      region: this.configService.get('AWS_REGION'),
      credentials: {
        accessKeyId: this.configService.get('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.get('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  /**
   * DB file_path(/news-crawler/...) 형식의 키로 객체를 열어 스트림+응답헤더용 메타를 반환.
   * 내부망(스프링)은 S3로 직접 못 나가므로 이 서버가 다운로드 관문 역할을 한다.
   * 키가 없으면 AWS SDK의 NoSuchKey 에러가 그대로 던져진다 (호출부에서 404 매핑).
   */
  async getObjectForProxy(key: string): Promise<{
    body: Readable;
    contentType?: string;
    contentLength?: number;
    etag?: string;
  }> {
    const obj = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.configService.get<string>('AWS_BUCKET_NAME'),
        Key: key,
      }),
    );
    return {
      body: obj.Body as Readable,
      contentType: obj.ContentType,
      contentLength: obj.ContentLength,
      etag: obj.ETag,
    };
  }

  /**
   * 업로드 관문(다운로드 관문의 반대 방향): 내부망 CMS가 넘긴 첨부를 포털 버킷에 그대로 올린다.
   * key는 CMS의 NAS 저장 경로와 동일해야(file_path=/{key}, ES payload의 bucket+key 정합)
   * 하므로 재조립하지 않고 받은 값 그대로 쓴다. 같은 key 재요청은 덮어쓰기.
   */
  async putMediaObject(
    key: string,
    body: Buffer,
    mimetype?: string,
  ): Promise<{ bucket: string; key: string; etag?: string; size: number }> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const ext = path.extname(key.split('/').pop() ?? '').toLowerCase();
    // CMS/브라우저가 octet-stream만 보내는 경우가 많아 확장자로 보정한다 (hwp는 lookup 미지원)
    let contentType =
      mimetype && mimetype !== 'application/octet-stream'
        ? mimetype
        : lookup(ext) || 'application/octet-stream';
    if (ext === '.hwp' || ext === '.hwpx') contentType = 'application/x-hwp';

    const res = await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { bucket, key, etag: res.ETag, size: body.length };
  }

  async getObjectStream(s3Uri: string): Promise<Readable> {
    const parts = s3Uri.replace('s3://', '').split('/');
    if (parts.length < 2) {
      throw new BadRequestException(`잘못된 S3 URI입니다: ${s3Uri}`);
    }
    const bucket = parts.shift()!;
    const key = parts.join('/');
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const { Body } = await this.s3.send(cmd);
    return Body as Readable;
  }

  async uploadFile(file: {
    buffer: Buffer;
    filename: string;
    mimetype: string;
  }): Promise<string> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const key = `uploads/${uuid()}-${file.filename}`;
    const params: PutObjectCommandInput = {
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    };
    await this.s3.send(new PutObjectCommand(params));
    return key;
  }

  async saveS3Img(configName, src) {
    try {
      const response = await axios.get(src, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);
      const contentType =
        response.headers['content-type'] || 'application/octet-stream';
      const extension = contentType.split('/')[1] || 'jpg';
      const s3Url = await this.uploadToS3({
        configName,
        category: 'img',
        data: buffer,
        contentType,
        extension,
      });
      return s3Url;
    } catch (error) {
      console.warn(`Image fetch failed: ${src}`, (error as any).message);
      return null;
    }
  }

  async uploadJsonToS3(
    configName: string,
    data: any,
    category: 'content' | 'img' | 'file' = 'content',
  ): Promise<string> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const today = moment().format('YYYY-MM-DD');
    const uuidName = `${uuid()}.json`;
    const key = `${configName}/${today}/${category}/${uuidName}`;
    const params: PutObjectCommandInput = {
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: 'application/json',
    };
    console.log(`[JSON 저장] ${key}`);
    await this.s3.send(new PutObjectCommand(params));
    return key;
  }

  async uploadToS3({
    configName,
    category,
    data,
    contentType = 'application/octet-stream',
    extension = 'bin',
    filenameBase = '',
  }: UploadToS3Params): Promise<string> {
    const today = moment().format('YYYY-MM-DD');
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const base = filenameBase || uuid();
    const filename = `${base}.${extension}`;
    const key = `${configName}/${today}/${category}/${filename}`;
    const putParams: PutObjectCommandInput = {
      Bucket: bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
    };
    await this.s3.send(new PutObjectCommand(putParams));
    return key;
  }

  async saveS3ScraperData(
    configName,
    scraperData: DetailScrapedData,
  ): Promise<DetailScrapedData> {
    const updatedImgs = await Promise.all(
      scraperData.img.map(async (img) => {
        const imgpath = await this.saveS3Img(configName, img.imgurl);
        return { ...img, imgString: imgpath };
      }),
    );
    scraperData.img = updatedImgs;
    return scraperData;
  }

  // async saveS3ScraperData(
  //   configName,
  //   scraperData: DetailScrapedData[],
  // ): Promise<DetailScrapedData[]> {
  //   for (const data of scraperData) {
  //     const updatedImgs = await Promise.all(
  //       data.img.map(async (img) => {
  //         const imgpath = await this.saveS3Img(configName, img.imgurl);
  //         return {
  //           ...img,
  //           imgString: imgpath,
  //         };
  //       }),
  //     );
  //     data.img = updatedImgs;
  //   }

  //   // for (const data of scraperData) {
  //   //   await this.uploadToS3({
  //   //     configName,
  //   //     category: 'scrapData',
  //   //     data: JSON.stringify(data, null, 2),
  //   //     contentType: 'application/json',
  //   //     extension: 'json',
  //   //   });
  //   // }
  //   return scraperData;
  // }

  async saveFileToS3(tempPath: string, originId: number, originalName: string, articleHash = 'unknown') {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const uuidName = `${originalName}`;
    const key = `news-crawler/articles/${originId}/${articleHash}/files/${uuidName}`;

    // 3) S3 업로드
    const fileBuffer = await fs.readFile(tempPath);
    const ext = path.extname(originalName).toLowerCase();
    let contentType = lookup(ext) || 'application/octet-stream';
    if (ext === '.hwp') contentType = 'application/x-hwp';
    else if (ext === '.hwpx') contentType = 'application/x-hwp';

    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fileBuffer,
        // ContentType: 'application/pdf',
        ContentType: contentType,
        // ContentDisposition: `attachment; filename="${originalName}"`,
      }),
    );
    return `s3://${bucket}/${key}`;
  }

  async saveImgToS3(
    buffer: Buffer,
    ext: string,
    category: string,
    filenameBase = '',
    originId: number,
    articleHash = 'unknown',
  ) {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const base = filenameBase || uuid();
    const filename = `${base}${ext}`;
    const key = `news-crawler/articles/${originId}/${articleHash}/img/${filename}`;

    // 확장자에 따라 MIME 타입 결정
    let contentType = 'application/octet-stream';
    if (ext.match(/\.png$/i)) contentType = 'image/png';
    else if (ext.match(/\.jpe?g$/i)) contentType = 'image/jpeg';
    else if (ext.match(/\.gif$/i)) contentType = 'image/gif';

    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return `s3://${bucket}/${key}`;
    // await this.s3.send(
    //   new PutObjectCommand({
    //     Bucket: bucket,
    //     Key: key,
    //     Body: buffer,
    //     ContentType: 'image/png',
    //   }),
    // );

    // return `s3://${bucket}/${key}`;
  }

  async articleExists(originId: number, articleHash: string): Promise<boolean> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    // meta.json은 수집 파이프라인 맨 마지막에 저장되는 완료 마커다.
    // 파일/이미지만 올라가고 중간에 실패한 기사는 미저장으로 간주해 재수집한다.
    const key = `news-crawler/articles/${originId}/${articleHash}/meta.json`;
    const res = await this.s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }),
    );
    return (res.Contents?.length ?? 0) > 0;
  }

  async saveArticleMeta(originId: number, articleHash: string, data: Record<string, any>): Promise<string> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const key = `news-crawler/articles/${originId}/${articleHash}/meta.json`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json',
      }),
    );
    return `s3://${bucket}/${key}`;
  }

  // ─── 아카이브(자료마당) 수집 — archive-crawler/ 프리픽스 (뉴스와 분리) ────────

  /**
   * 아카이브 meta.json(완료 마커) 존재 여부 — RISS/KCI/NTIS 중복 수집 방지.
   * 폴더명은 `{hash}` 또는 `{hash}_제목` 두 형태가 공존하므로(가독성 개선 전 저장분 호환)
   * hash 접두 매칭으로 확인한다. hash가 고정 8자리라 다른 hash와 접두 충돌은 없다.
   */
  async archiveItemExists(originId: number, itemHash: string): Promise<boolean> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const prefix = `archive-crawler/items/${originId}/${itemHash}`;
    const res = await this.s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 5 }),
    );
    return (res.Contents ?? []).some((obj) => obj.Key?.endsWith('/meta.json'));
  }

  /**
   * 아카이브 meta.json 저장 — 수집 파이프라인 마지막에 호출되는 완료 마커.
   * folderSuffix(정리된 제목)를 주면 `{hash}_{제목}/meta.json`으로 저장해 콘솔에서 식별 가능.
   */
  async saveArchiveMeta(
    originId: number,
    itemHash: string,
    data: Record<string, any>,
    folderSuffix = '',
  ): Promise<string> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const folder = folderSuffix ? `${itemHash}_${folderSuffix}` : itemHash;
    const key = `archive-crawler/items/${originId}/${folder}/meta.json`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json',
      }),
    );
    return `s3://${bucket}/${key}`;
  }

  /**
   * origin 하위 아카이브 meta.json을 S3 LastModified와 함께 반환 (스프링 증분 폴링용).
   * listArticleMetaEntries와 동일한 p-limit 병렬 조회 패턴, 프리픽스만 다르다.
   */
  async listArchiveMetaEntries(
    originId: number,
    since?: Date,
  ): Promise<{ key: string; meta: Record<string, any>; lastModified: Date | null }[]> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const prefix = `archive-crawler/items/${originId}/`;

    const metaEntries: { key: string; lastModified: Date | null }[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key?.endsWith('meta.json')) continue;
        if (since && obj.LastModified && obj.LastModified < since) continue;
        metaEntries.push({ key: obj.Key, lastModified: obj.LastModified ?? null });
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(30);
    const settled = await Promise.all(
      metaEntries.map(({ key, lastModified }) =>
        limit(async () => {
          try {
            const obj = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            const body = await obj.Body?.transformToString('utf-8');
            return { key, meta: JSON.parse(body ?? '{}'), lastModified };
          } catch {
            return null; // meta.json 조회/파싱 실패 시 제외
          }
        }),
      ),
    );
    return settled.filter(
      (r): r is { key: string; meta: Record<string, any>; lastModified: Date | null } => r !== null,
    );
  }

  /** 기존 meta.json을 같은 키에 덮어쓰기 (재분류 등 유지보수용 — 폴더/해시 그대로) */
  async overwriteArchiveMeta(key: string, meta: Record<string, any>): Promise<void> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(meta, null, 2),
        ContentType: 'application/json',
      }),
    );
  }

  /** 임의 키의 JSON 조회 (없으면 null) — 분류기 캐시 등 소형 상태 파일용 */
  async getJson(key: string): Promise<any | null> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    try {
      const obj = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await obj.Body?.transformToString('utf-8');
      return body ? JSON.parse(body) : null;
    } catch (e) {
      if ((e as any)?.name === 'NoSuchKey') return null;
      throw e;
    }
  }

  /** 임의 키에 JSON 저장 — 분류기 캐시 등 소형 상태 파일용 */
  async putJson(key: string, data: any): Promise<void> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json',
      }),
    );
  }

  /** 임의 키에 텍스트 저장 — 아카이브 저장 현황 리포트 등 */
  async putText(key: string, body: string): Promise<string> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'text/plain; charset=utf-8',
      }),
    );
    return `s3://${bucket}/${key}`;
  }

  private async listMetaKeysByOrigin(
    originId: number,
    since?: Date,
  ): Promise<{ key: string; lastModified: Date | null }[]> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const prefix = `news-crawler/articles/${originId}/`;

    const entries: { key: string; lastModified: Date | null }[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key?.endsWith('meta.json')) continue;
        if (since && obj.LastModified && obj.LastModified < since) continue;
        entries.push({ key: obj.Key, lastModified: obj.LastModified ?? null });
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return entries;
  }

  /** origin 하위의 모든 meta.json을 파싱해 원본 그대로 반환 (presigned 변환 없음) */
  async listArticleMetasByOrigin(originId: number): Promise<Record<string, any>[]> {
    const entries = await this.listArticleMetaEntries(originId);
    return entries.map((e) => e.meta);
  }

  /**
   * origin 하위 meta.json을 S3 LastModified(수집 완료 시각)와 함께 반환.
   * since를 주면 그 시각 이후에 저장된 meta만 반환한다 (스프링 증분 폴링용).
   */
  async listArticleMetaEntries(
    originId: number,
    since?: Date,
  ): Promise<{ meta: Record<string, any>; lastModified: Date | null }[]> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const metaEntries = await this.listMetaKeysByOrigin(originId, since);

    // meta.json 건당 GetObject를 병렬 조회한다. 순차로 하면 수백 건에서 수십 초가 걸려
    // 호출 측(스프링) 읽기 타임아웃에 걸린다. (869건 순차 ≈ 70초 → 병렬 ≈ 2~3초)
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(30);
    const settled = await Promise.all(
      metaEntries.map(({ key, lastModified }) =>
        limit(async () => {
          try {
            const obj = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            const body = await obj.Body?.transformToString('utf-8');
            return { meta: JSON.parse(body ?? '{}'), lastModified };
          } catch {
            return null; // meta.json 조회/파싱 실패 시 제외
          }
        }),
      ),
    );
    return settled.filter(
      (r): r is { meta: Record<string, any>; lastModified: Date | null } => r !== null,
    );
  }

  async listFilesByOrigin(originId: number): Promise<any[]> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const metaKeys = await this.listMetaKeysByOrigin(originId);

    // 2) 각 meta.json 읽어서 s3Path → presigned URL 변환
    const toPresigned = (s3Path: string) => {
      const key = s3Path.replace(`s3://${bucket}/`, '');
      return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
    };

    const results: any[] = [];
    for (const { key: metaKey } of metaKeys) {
      try {
        const obj = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: metaKey }));
        const body = await obj.Body?.transformToString('utf-8');
        const { img = [], file = [], ...meta } = JSON.parse(body ?? '{}');

        const [images, files] = await Promise.all([
          Promise.all((img as any[]).filter(i => i?.s3Path).map(i => toPresigned(i.s3Path))),
          Promise.all((file as any[]).filter(f => f?.s3Path).map(f => toPresigned(f.s3Path))),
        ]);

        results.push({ ...meta, images, files });
      } catch { /* meta.json 파싱 실패 시 skip */ }
    }

    return results;
  }

  async saveLogToS3(configId: number, log: Record<string, any>): Promise<void> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const today = moment().format('YYYY-MM-DD');
    const filename = `${moment().format('HHmmss')}_${uuid()}.json`;
    const key = `news-crawler/log/${configId}/${today}/${filename}`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(log, null, 2),
        ContentType: 'application/json',
      }),
    );
  }

  async uploadStreamToS3(
    key: string,
    body: stream.Readable,
    contentType: string = 'image/jpeg',
  ): Promise<string> {
    const bucket = this.configService.get<string>('AWS_BUCKET_NAME');
    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
    });
    await upload.done();
    return `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  }

  parseS3Uri(uri: string): { bucket: string; key: string } {
    const match = uri.match(/^s3:\/\/([^\/]+)\/(.+)$/);
    if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
    return { bucket: match[1], key: match[2] };
  }

  getBucketName(): string {
    return this.configService.get<string>('AWS_BUCKET_NAME');
  }

  /** ✅ prefix로 S3 키 목록 반환 (전부 페이징 처리) */
  async listKeysByPrefix(prefix: string): Promise<string[]> {
    const bucket = this.getBucketName();
    const keys: string[] = [];
    let ContinuationToken: string | undefined = undefined;

    while (true) {
      const out = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken,
        }),
      );
      (out.Contents || []).forEach((obj) => {
        if (obj.Key) keys.push(obj.Key);
      });
      if (!out.IsTruncated) break;
      ContinuationToken = out.NextContinuationToken;
    }
    return keys;
  }

  /** ✅ s3 key로 이미지 읽어 base64 Data URL 리턴 */
  async getBase64ByKey(key: string): Promise<string> {
    const bucket = this.getBucketName();
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = res.Body as Readable;
    const buf: Buffer = await consume(body);
    let mimeType = res.ContentType || 'image/jpeg';
    if (mimeType === 'application/octet-stream') mimeType = 'image/jpeg';
    return `data:${mimeType};base64,${buf.toString('base64')}`;
  }

  // ── 실패 스탬프(평평한 구조) ─────────────────────────────────────────────

  /** 실패 스탬프 저장: WeatherSatellite/_failures/YYYYMMDDHHmm */
  async putFailureStamp(date12: string): Promise<string> {
    const bucket = this.getBucketName();
    const key = `${this.failurePrefix}/${date12}`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(
          `FAIL ${date12}\nupdatedAt=${new Date().toISOString()}`,
        ),
        ContentType: 'text/plain',
      }),
    );
    return `s3://${bucket}/${key}`;
  }

  /** 성공 시 실패 스탬프 삭제 */
  async clearFailureStamp(date12: string): Promise<void> {
    const bucket = this.getBucketName();
    const key = `${this.failurePrefix}/${date12}`;
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      /* not found ok */
    }
  }

  /** 현재 실패 스탬프 목록(date12 문자열 배열) */
  async listFailureStamps(): Promise<string[]> {
    const prefix = `${this.failurePrefix}/`;
    const keys = await this.listKeysByPrefix(prefix);
    // prefix 바로 아래의 파일명만 추출
    return keys
      .map((k) => k.substring(prefix.length))
      .filter((name) => /^\d{12}$/.test(name))
      .sort();
  }
}
