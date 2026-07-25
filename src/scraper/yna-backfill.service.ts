import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import axios from 'axios';
import moment from 'moment';
import { parseStringPromise } from 'xml2js';
import { S3Service } from 'src/aws/s3/s3.service';
import { TranslationClientService } from './translation-client.service';
import { KEYWORDS, BROWSER_UA } from './yna-feed.service';

const DT_FORMAT = 'YYYY-MM-DD HH:mm:ss';
// 연합뉴스 과거 아카이브 XML 위치: feed_468/<YYYYMM>/*.xml (프로젝트에 포함 배포)
const YNA_XML_DIR = path.join(process.cwd(), 'feed_468');

interface BackfillItem {
  guid: string;
  title: string;
  link: string;
  regDt: string; // YYYY-MM-DD HH:mm:ss
  writer: string;
  content: string; // <br> 줄바꿈 본문
  imgUrls: string[];
  matchedKeywords: string[]; // 제목+부제+본문에 매칭된 키워드 (필터 및 meta 저장용)
}

/**
 * configs/yna/<월>/*.xml (연합뉴스 YNewsML 아카이브)을 읽어 기존 피드 수집과
 * 동일한 meta.json 스키마로 S3에 백필한다. DB 적재는 스프링이 담당(GET /scraper/articles/:originId).
 *
 * 라이브 피드(YnaFeedService)와 달리 KEYWORDS 필터를 적용하지 않는다 —
 * feed_468 아카이브는 공급처에서 이미 필터링된 기사만 담겨 온다. guid 기준 중복은 스킵.
 */
@Injectable()
export class YnaBackfillService {
  private readonly logger = new Logger(YnaBackfillService.name);
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly s3Service: S3Service,
    private readonly translationClient: TranslationClientService,
  ) {}

  /**
   * @param month    특정 월만 백필 (예: '202601'). 생략 시 전체 월.
   * @param translate 영문 번역 수행 여부 (기본 true). false면 원문만 저장.
   * @param limit    이번 호출에서 저장할 최대 신규 건수 (테스트/청크용).
   */
  async backfill(
    opts: { month?: string; translate?: boolean; limit?: number } = {},
  ) {
    if (this.running) {
      this.logger.warn('[yna-backfill] 이미 실행 중 → 이번 호출 스킵');
      return { skipped: true, reason: 'already running' };
    }
    this.running = true;

    const translate = opts.translate !== false;
    const originId = Number(this.configService.get('YNA_ORIGIN_ID'));
    if (!Number.isFinite(originId) || originId <= 0) {
      this.running = false;
      this.logger.warn('[yna-backfill] YNA_ORIGIN_ID 미설정 → 백필 생략');
      return { skipped: true, reason: 'YNA_ORIGIN_ID not configured' };
    }

    const summary = {
      originId,
      month: opts.month ?? 'all',
      translate,
      totalFiles: 0,
      parsed: 0,
      keywordMatched: 0,
      skippedNoKeyword: 0,
      skippedDuplicate: 0,
      saved: 0,
      imageUploaded: 0,
      translated: 0,
      parseErrors: 0,
      errors: [] as { file: string; message: string }[],
    };

    try {
      const files = await this.listXmlFiles(opts.month);
      summary.totalFiles = files.length;
      this.logger.log(
        `[yna-backfill] 대상 XML ${files.length}개 (month=${opts.month ?? 'all'}, translate=${translate})`,
      );

      // 파일명이 곧 ContentID인 경우가 많아 배치 내 중복도 해시로 거른다
      const seenInBatch = new Set<string>();

      // 날짜가 바뀔 때마다 진행 헤더를 찍는다 (대부분 파일은 키워드 비매칭으로
      // 조용히 스킵되므로, 날짜 헤더가 없으면 진행 중인지 알기 어렵다)
      let lastDay = '';

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (opts.limit && summary.saved >= opts.limit) break;

        const day = this.dayFromFilename(file);
        if (day && day !== lastDay) {
          lastDay = day;
          this.logger.log(
            `[yna-backfill] 📅 ${day} 처리 중 — 진행 ${i + 1}/${files.length}건 ` +
              `(지금까지 신규 ${summary.saved}, 매칭 ${summary.keywordMatched})`,
          );
        }

        let item: BackfillItem | null = null;
        try {
          const xml = await fs.readFile(file, 'utf8');
          item = await this.parseXml(xml);
        } catch (e) {
          summary.parseErrors++;
          this.logger.warn(
            `[yna-backfill] 파싱 실패 ${path.basename(file)}: ${(e as Error).message}`,
          );
          continue;
        }
        if (!item) {
          summary.parseErrors++;
          continue;
        }
        summary.parsed++;

        // feed_468 아카이브는 공급처에서 이미 키워드 필터링된 기사만 담겨 오므로
        // 백필에서는 필터하지 않고 전부 저장한다 (라이브 피드와 다른 점).
        // matchedKeywords는 참고용으로만 meta에 기록 — 매칭 0건이어도 저장.
        if (item.matchedKeywords.length > 0) summary.keywordMatched++;

        const articleHash = createHash('md5')
          .update(item.guid || item.link)
          .digest('hex')
          .slice(0, 8);

        if (seenInBatch.has(articleHash)) {
          summary.skippedDuplicate++;
          continue;
        }
        seenInBatch.add(articleHash);

        try {
          const alreadySaved = await this.s3Service.articleExists(
            originId,
            articleHash,
          );
          if (alreadySaved) {
            summary.skippedDuplicate++;
            this.logger.log(
              `[yna-backfill] 중복 스킵(완료 마커 존재): "${item.title}"`,
            );
            continue;
          }

          let titleEn = '';
          let contentEn = '';
          if (translate) {
            try {
              const translated =
                await this.translationClient.translateFields({
                  title: item.title,
                  content: item.content,
                });
              titleEn = translated.title ?? '';
              contentEn = translated.content ?? '';
              summary.translated++;
            } catch (e) {
              this.logger.warn(
                `[yna-backfill] 번역 실패, 원문만 저장: "${item.title}" — ${(e as Error).message}`,
              );
            }
          }

          const imgRows = await this.uploadImages(
            item.imgUrls,
            originId,
            articleHash,
          );
          summary.imageUploaded += imgRows.length;

          // 라이브 피드(YnaFeedService)와 동일한 meta.json 스키마
          const meta = {
            title: item.title,
            content: item.content,
            writer: item.writer,
            writedate: item.regDt,
            currentUrl: item.link,
            title_en: titleEn,
            content_text_en: contentEn,
            img: imgRows,
            guid: item.guid,
            matchedKeywords: item.matchedKeywords,
          };

          await this.s3Service.saveArticleMeta(originId, articleHash, meta);
          summary.saved++;
          this.logger.log(
            `[yna-backfill] 저장 완료 [${i + 1}/${files.length}] ${item.regDt.slice(0, 10)} ` +
              `hash=${articleHash} (이미지 ${imgRows.length}건) "${item.title}"`,
          );
        } catch (e) {
          summary.errors.push({
            file: path.basename(file),
            message: (e as Error).message,
          });
          this.logger.error(
            `[yna-backfill] 저장 실패 ${path.basename(file)}: ${(e as Error).message}`,
          );
        }
      }

      this.logger.log(
        `[yna-backfill] 종료: 파일 ${summary.totalFiles}, 파싱 ${summary.parsed}, ` +
          `키워드매칭 ${summary.keywordMatched}, 비매칭 ${summary.skippedNoKeyword}, ` +
          `신규 ${summary.saved}, 중복 ${summary.skippedDuplicate}, ` +
          `번역 ${summary.translated}, 파싱실패 ${summary.parseErrors}, 저장실패 ${summary.errors.length}`,
      );
      return summary;
    } finally {
      this.running = false;
    }
  }

  /** 파일명(AKR<YYYYMMDD>...xml)에서 'YYYY-MM-DD' 추출. 못 찾으면 ''. */
  private dayFromFilename(file: string): string {
    const m = path.basename(file).match(/(\d{4})(\d{2})(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }

  // ─── 파일 목록 ─────────────────────────────────────────────

  /** configs/yna/<월>/*.xml 경로 목록 (월/파일명 정렬). month 지정 시 해당 월만. */
  private async listXmlFiles(month?: string): Promise<string[]> {
    let monthDirs: string[];
    try {
      const entries = await fs.readdir(YNA_XML_DIR, { withFileTypes: true });
      monthDirs = entries
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((name) => !month || name === month)
        .sort();
    } catch (e) {
      this.logger.warn(
        `[yna-backfill] XML 디렉터리 읽기 실패 (${YNA_XML_DIR}): ${(e as Error).message}`,
      );
      return [];
    }

    const out: string[] = [];
    for (const dir of monthDirs) {
      const full = path.join(YNA_XML_DIR, dir);
      const names = (await fs.readdir(full))
        .filter((n) => n.toLowerCase().endsWith('.xml'))
        .sort();
      for (const n of names) out.push(path.join(full, n));
    }
    return out;
  }

  // ─── XML 파싱 ─────────────────────────────────────────────

  private async parseXml(xml: string): Promise<BackfillItem | null> {
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const root = parsed?.YNewsML;
    if (!root) return null;

    const header = root.Header ?? {};
    const md = root.Metadata ?? {};
    const nc = root.NewsContent ?? {};

    const guid = this.text(header.ContentID);
    const link = this.text(md.Href);
    const title = this.text(nc.Title);
    if (!title || (!guid && !link)) return null;

    const subTitle = this.text(nc.SubTitle);
    const content = this.bodyToContent(this.text(nc.Body), title, subTitle);
    const regDt = this.parseSendDate(
      this.text(header.SendDate),
      this.text(header.SendTime),
    );

    let writer = this.text(md.Writer);
    if (!writer) writer = this.extractWriter(content);

    const imgUrls = this.extractImages(nc.AppendData);
    const matchedKeywords = this.matchKeywords(
      `${title}\n${subTitle}\n${content}`,
    );

    return { guid, title, link, regDt, writer, content, imgUrls, matchedKeywords };
  }

  /** CDATA/속성 혼합 요소를 문자열로. {_, $} 형태면 _ 사용. */
  private text(x: any): string {
    if (x == null) return '';
    if (typeof x === 'object') return String(x._ ?? '').trim();
    return String(x).trim();
  }

  /** Body 텍스트 → <br> 본문. 선두의 제목/부제 중복 라인은 제거. */
  private bodyToContent(body: string, title: string, subTitle: string): string {
    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // Body 상단에 제목/부제가 중복되는 경우 제거
    while (lines.length && (lines[0] === title || lines[0] === subTitle)) {
      lines.shift();
    }
    return lines.join('<br>');
  }

  /** <AppendData mimetype="image/*"><Href>URL</Href> 에서 이미지 URL 추출(크기 접미사 중복 제거). */
  private extractImages(appendData: any): string[] {
    if (!appendData) return [];
    const arr = Array.isArray(appendData) ? appendData : [appendData];
    const baseOf = (url: string) =>
      (url.split('?')[0].split('/').pop() ?? url).replace(
        /_P\d+(?=\.[a-z]+$)/i,
        '',
      );

    const urls: string[] = [];
    const seen = new Set<string>();
    for (const a of arr) {
      const mime = String(a?.$?.mimetype ?? '');
      if (!mime.startsWith('image/')) continue;
      const href = this.normalizeYnaImageUrl(this.text(a?.Href));
      if (!href) continue;
      const base = baseOf(href);
      if (seen.has(base)) continue;
      seen.add(base);
      urls.push(href);
    }
    return urls;
  }

  /**
   * 아카이브 XML의 이미지 URL 보정.
   * XML은 번호 없는 host(img.yna.co.kr)를 쓰는데 이 host는 400을 반환한다.
   * 실제 서비스 CDN인 번호 붙은 host(img1.yna.co.kr)로 교체하고 https로 강제한다.
   * (원본 파일명은 그대로 유효 — 접미사 변경 불필요)
   */
  private normalizeYnaImageUrl(url: string): string {
    if (!url) return '';
    return url
      .replace(/^http:\/\//i, 'https://')
      .replace(/\/\/img\.yna\.co\.kr\//i, '//img1.yna.co.kr/');
  }

  /** SendDate(YYYYMMDD)+SendTime(HHmmss) → 'YYYY-MM-DD HH:mm:ss'. 실패 시 현재 시각. */
  private parseSendDate(date: string, time: string): string {
    const t = (time || '000000').padStart(6, '0').slice(0, 6);
    const dt = moment(`${date}${t}`, 'YYYYMMDDHHmmss', true);
    return (dt.isValid() ? dt : moment()).format(DT_FORMAT);
  }

  /** '(서울=연합뉴스) 홍길동 기자 =' 패턴에서 기자명 추출. 없으면 ''. */
  private extractWriter(content: string): string {
    const m = content.match(
      /\([^)=]*=\s*연합뉴스\)\s*([가-힣]+(?:\s+[가-힣]+)*)\s*기자/,
    );
    return m ? m[1].trim() : '';
  }

  /** 제목+부제+본문에서 매칭된 키워드 목록 (라이브 피드와 동일, 대소문자 무시). */
  private matchKeywords(text: string): string[] {
    const upper = text.toUpperCase();
    return KEYWORDS.filter((kw) => upper.includes(kw.toUpperCase()));
  }

  // ─── 이미지 업로드 ─────────────────────────────────────────

  /** 이미지 다운로드 → S3 업로드. meta.json img 배열용 { url, s3Path } 목록 반환. */
  private async uploadImages(
    imgUrls: string[],
    originId: number,
    articleHash: string,
  ): Promise<{ url: string; s3Path: string }[]> {
    const rows: { url: string; s3Path: string }[] = [];
    for (const url of imgUrls) {
      try {
        const res = await axios.get(url, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.yna.co.kr' },
          timeout: 15000,
        });
        const extMatch = url.split('?')[0].match(/\.([a-z0-9]+)$/i);
        const ext = `.${(extMatch?.[1] ?? 'jpg').toLowerCase()}`;
        const s3Path = await this.s3Service.saveImgToS3(
          Buffer.from(res.data),
          ext,
          'img',
          '',
          originId,
          articleHash,
        );
        rows.push({ url, s3Path });
      } catch (e) {
        this.logger.warn(
          `[yna-backfill] 이미지 다운로드 실패, 건너뜀: ${url} — ${(e as Error).message}`,
        );
      }
    }
    return rows;
  }
}
