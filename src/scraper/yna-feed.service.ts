import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import axios from 'axios';
import { createHash } from 'crypto';
import moment from 'moment';
import { parseStringPromise } from 'xml2js';
import { S3Service } from 'src/aws/s3/s3.service';
import { TranslationClientService } from './translation-client.service';
import { GoogleChatService } from 'src/common/webhook/google-chat.service';
import { isSchedulingEnabled } from 'src/common/scheduling.util';

// 주무관 협의 키워드 — 제목/본문에 하나라도 포함되면 수집 대상
export const KEYWORDS = [
  'DMZ',
  '디엠지',
  '비무장지대',
  '민통선',
  '민간인출입',
  '민간인통제선',
  '접경',
  '접경지역',
  '접경지',
  '군사분계선',
  'MDL',
  '유엔사',
  '정전협정',
  '군사정전위원회',
];

// curl 기본 UA는 연합뉴스 WAF가 차단하므로 브라우저 UA 고정
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DT_FORMAT = 'YYYY-MM-DD HH:mm:ss';

interface FeedItem {
  guid: string;
  title: string;
  link: string;
  regDt: string; // YYYY-MM-DD HH:mm:ss
  writer: string; // 본문에서 추출한 기자명 (없으면 '')
  content: string; // HTML 제거 + <br> 줄바꿈 본문
  imgUrls: string[];
  matchedKeywords: string[];
}

// 5분 주기 수집 (매시 0·5·10…55분, 피드는 최신 목록만 제공 → 누적 저장)
const YNA_CRON_ID = 'yna-feed-collect';
const YNA_CRON_TIME = '0 */5 * * * *';

@Injectable()
export class YnaFeedService implements OnModuleInit {
  private readonly logger = new Logger(YnaFeedService.name);
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly s3Service: S3Service,
    private readonly translationClient: TranslationClientService,
    private readonly googleChatService: GoogleChatService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  // 기존 스크래퍼와 동일하게 SchedulerRegistry로 동적 등록한다.
  // (@Cron 데코레이터는 이 앱 구성에서 discovery가 안 붙어 발화하지 않음)
  onModuleInit(): void {
    // 전역 스케줄링 OFF면 yna 정기 수집 크론도 등록하지 않는다.
    // 수동 실행(/scraper/yna/collect)은 계속 동작한다.
    if (!isSchedulingEnabled(this.configService)) {
      this.logger.warn(
        '[yna] ⏸️ 전역 스케줄링 비활성화(SCHEDULING_ENABLED=false) — 정기 수집 크론 미등록.',
      );
      return;
    }

    if (this.schedulerRegistry.getCronJobs().has(YNA_CRON_ID)) {
      const existing = this.schedulerRegistry.getCronJob(YNA_CRON_ID);
      existing.stop();
      this.schedulerRegistry.deleteCronJob(YNA_CRON_ID);
    }

    const job = new CronJob(
      YNA_CRON_TIME,
      async () => {
        try {
          await this.collect();
        } catch (e) {
          this.logger.error(`[yna] 정기 수집 실패: ${(e as Error).message}`);
        }
      },
      null,
      false,
      'Asia/Seoul',
    );

    this.schedulerRegistry.addCronJob(YNA_CRON_ID, job);
    job.start();
    this.logger.log(`[yna] 정기 수집 크론 등록 완료 (${YNA_CRON_TIME})`);
  }

  /**
   * 연합뉴스 RSS 피드 수집 → 키워드 필터 → 중복 확인(S3 meta.json 존재 여부)
   * → (신규만) 번역 → 이미지 S3 업로드 → meta.json 저장.
   * DB 적재는 하지 않는다 — 스프링이 GET /scraper/articles/:originId 로 가져가 적재한다.
   * meta.json 필드는 기존 config 스크래퍼 출력과 동일 스키마를 따른다.
   */
  async collect() {
    if (this.running) {
      this.logger.warn('[yna] 이전 수집이 아직 실행 중 → 이번 회차 스킵');
      return { skipped: true, reason: 'already running' };
    }
    this.running = true;

    const feedUrl = this.configService.get<string>('YNA_FEED_URL');
    const originId = Number(this.configService.get('YNA_ORIGIN_ID'));
    if (!feedUrl || !Number.isFinite(originId) || originId <= 0) {
      this.running = false;
      this.logger.warn('[yna] YNA_FEED_URL / YNA_ORIGIN_ID 미설정 → 수집 생략');
      return { skipped: true, reason: 'env not configured' };
    }

    const summary = {
      totalItems: 0,
      keywordMatched: 0,
      skippedDuplicate: 0,
      saved: 0,
      imageUploaded: 0,
      translated: 0,
      errors: [] as { link: string; message: string }[],
    };

    try {
      const items = await this.fetchFeed(feedUrl);
      summary.totalItems = items.length;

      const matched = items.filter((it) => it.matchedKeywords.length > 0);
      summary.keywordMatched = matched.length;
      this.logger.log(
        `[yna] 피드 ${items.length}건 중 키워드 매칭 ${matched.length}건`,
      );
      if (matched.length === 0) return summary;

      // guid 기반 해시가 기사 식별자 — 배치 내 중복과 S3 중복(완료 마커) 모두 이걸로 거른다
      const seenInBatch = new Set<string>();

      for (const item of matched) {
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
          const alreadySaved = await this.s3Service.articleExists(originId, articleHash);
          if (alreadySaved) {
            summary.skippedDuplicate++;
            this.logger.log(`[yna] 중복 스킵(수집 완료 마커 존재): "${item.title}"`);
            continue;
          }

          // 중복이 아닌 것이 확정된 뒤에만 번역 호출 (토큰 절약)
          let titleEn = '';
          let contentEn = '';
          try {
            const translated = await this.translationClient.translateFields({
              title: item.title,
              content: item.content,
            });
            titleEn = translated.title ?? '';
            contentEn = translated.content ?? '';
            summary.translated++;
          } catch (e) {
            this.logger.warn(
              `[yna] 번역 실패, 원문만 저장: "${item.title}" — ${(e as Error).message}`,
            );
          }

          const imgRows = await this.uploadImages(item.imgUrls, originId, articleHash);
          summary.imageUploaded += imgRows.length;

          // 기존 config 스크래퍼의 meta.json 스키마와 동일한 필드명 사용
          // (writedate/currentUrl/img[].s3Path — 스프링 적재 API가 이 스키마를 읽는다)
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
            `[yna] meta.json 저장 완료 hash=${articleHash} (이미지 ${imgRows.length}건, ` +
            `키워드: ${item.matchedKeywords.join(',')}) "${item.title}"`,
          );
        } catch (e) {
          this.logger.error(`[yna] 기사 저장 실패 (${item.link}): ${(e as Error).message}`);
          summary.errors.push({ link: item.link, message: (e as Error).message });
        }
      }

      this.logger.log(
        `[yna] 수집 종료: 피드 ${summary.totalItems}건, 매칭 ${summary.keywordMatched}건, ` +
        `신규 ${summary.saved}건, 중복 ${summary.skippedDuplicate}건, ` +
        `번역 ${summary.translated}건, 실패 ${summary.errors.length}건`,
      );
      return summary;
    } catch (e) {
      this.logger.error(`[yna] 피드 수집 실패: ${(e as Error).message}`);
      this.googleChatService.sendAlert('연합뉴스 피드 수집 실패', {
        URL: feedUrl,
        에러: (e as Error).message,
      });
      throw e;
    } finally {
      this.running = false;
    }
  }

  // ─── 피드 조회/파싱 ─────────────────────────────────────────────

  private async fetchFeed(feedUrl: string): Promise<FeedItem[]> {
    const res = await axios.get(feedUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      timeout: 20000,
      responseType: 'text',
    });

    const parsed = await parseStringPromise(res.data, { explicitArray: false });
    const rawItems = parsed?.rss?.channel?.item;
    if (!rawItems) return [];
    const list = Array.isArray(rawItems) ? rawItems : [rawItems];

    return list
      .map((raw) => this.toFeedItem(raw))
      .filter((it): it is FeedItem => it !== null);
  }

  private toFeedItem(raw: any): FeedItem | null {
    const title = String(raw?.title ?? '').trim();
    const link = String(raw?.link ?? '').trim();
    if (!title || !link) return null;

    // guid는 <guid isPermaLink="false">AKR...</guid> 형태 → 속성 있으면 '_'에 텍스트가 담긴다
    const guid = String(
      typeof raw?.guid === 'object' ? raw.guid?._ ?? '' : raw?.guid ?? '',
    ).trim();

    const descriptionHtml = String(raw?.description ?? '');
    const { text: content, imgUrls: inlineImgs } = this.htmlToContent(descriptionHtml);

    const enclosureUrl = String(raw?.enclosure?.$?.url ?? '').trim();
    const imgUrls = this.mergeImageUrls(inlineImgs, enclosureUrl);

    const regDt = this.parsePubDate(raw?.pubDate);
    const writer = this.extractWriter(content);
    const matchedKeywords = this.matchKeywords(`${title}\n${content}`);

    return { guid, title, link, regDt, writer, content, imgUrls, matchedKeywords };
  }

  /** description HTML → 이미지 URL 추출 + 태그 제거 + 줄바꿈 <br> 변환 텍스트 */
  private htmlToContent(html: string): { text: string; imgUrls: string[] } {
    const imgUrls: string[] = [];
    for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
      imgUrls.push(m[1]);
    }

    let text = html
      // 이미지·캡션 블록은 통째로 제거 (이미지는 img 배열로 별도 저장)
      .replace(/<figure[\s\S]*?<\/figure>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '');

    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&');

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return { text: lines.join('<br>'), imgUrls };
  }

  /**
   * 인라인 이미지와 enclosure 썸네일 병합.
   * 연합뉴스는 같은 사진을 _P2(썸네일)/_P4(본문) 크기로 나눠 제공하므로
   * 크기 접미사를 제거한 파일명 기준으로 중복을 걸러 본문(P4)판을 우선한다.
   */
  private mergeImageUrls(inlineImgs: string[], enclosureUrl: string): string[] {
    const baseOf = (url: string) =>
      (url.split('?')[0].split('/').pop() ?? url).replace(/_P\d+(?=\.[a-z]+$)/i, '');

    const merged: string[] = [];
    const seen = new Set<string>();
    for (const url of inlineImgs) {
      const base = baseOf(url);
      if (seen.has(base)) continue;
      seen.add(base);
      merged.push(url);
    }
    if (enclosureUrl && !seen.has(baseOf(enclosureUrl))) {
      merged.push(enclosureUrl);
    }
    return merged;
  }

  /** pubDate(RFC822: 'Thu, 9 Jul 2026 16:13:14 +0900') → KST 문자열. 실패 시 현재 시각 */
  private parsePubDate(pubDate?: string): string {
    const parsed = pubDate ? moment(new Date(pubDate)) : moment.invalid();
    return (parsed.isValid() ? parsed : moment()).format(DT_FORMAT);
  }

  /** '(서울=연합뉴스) 박재하 노선웅 기자 =' 패턴에서 기자명 추출. 없으면 '' */
  private extractWriter(content: string): string {
    const m = content.match(/\([^)=]*=\s*연합뉴스\)\s*([가-힣]+(?:\s+[가-힣]+)*)\s*기자/);
    return m ? m[1].trim() : '';
  }

  private matchKeywords(text: string): string[] {
    const upper = text.toUpperCase();
    return KEYWORDS.filter((kw) => upper.includes(kw.toUpperCase()));
  }

  // ─── 이미지 업로드 ─────────────────────────────────────────────

  /** 이미지 다운로드 → S3 업로드. meta.json img 배열용 { url, s3Path } 목록 반환 */
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
        this.logger.warn(`[yna] 이미지 다운로드 실패, 건너뜀: ${url} — ${(e as Error).message}`);
      }
    }
    return rows;
  }
}
