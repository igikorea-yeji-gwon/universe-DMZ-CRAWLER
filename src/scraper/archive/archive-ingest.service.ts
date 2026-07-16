import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import moment from 'moment';
import { S3Service } from 'src/aws/s3/s3.service';
import { IsbnService } from 'src/isbn/isbn.service';
import { TranslationClientService } from '../translation-client.service';
import { ArchiveReportService } from './archive-report.service';
import { InstitutionClassifierService } from './institution-classifier.service';
import {
  ArchiveCollectOptions,
  ArchiveIngestSummary,
  ArchiveItem,
  ArchiveMenuId,
  ArchiveMeta,
  titleToS3Suffix,
} from './archive.types';

const DT_FORMAT = 'YYYY-MM-DD HH:mm:ss';
const SOURCE_LABEL: Record<string, string> = {
  kci: 'KCI OpenAPI 수집',
  riss: 'RISS OpenAPI 수집',
  ntis: 'NTIS OpenAPI 수집',
};
const DRY_RUN_PREVIEW_LIMIT = 20;

/**
 * RISS/KCI/NTIS 공통 수집 파이프라인.
 * 컬렉터가 정규화한 ArchiveItem[]을 받아
 * 중복확인(S3 완료 마커) → 기관분류(menu_id) → 번역 → (BOOKS) 표지조회 → meta.json 저장.
 * DB 적재는 하지 않는다 — 스프링이 GET /scraper/archives/:originId 로 가져가 적재한다.
 */
@Injectable()
export class ArchiveIngestService {
  private readonly logger = new Logger(ArchiveIngestService.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly classifier: InstitutionClassifierService,
    private readonly translationClient: TranslationClientService,
    private readonly isbnService: IsbnService,
    private readonly reportService: ArchiveReportService,
  ) {}

  async ingest(
    originId: number,
    items: ArchiveItem[],
    opts: ArchiveCollectOptions,
  ): Promise<ArchiveIngestSummary> {
    const source = items[0]?.source ?? 'kci';
    const summary: ArchiveIngestSummary = {
      originId,
      source,
      fetched: items.length,
      deduped: 0,
      skippedExisting: 0,
      classified: { PUBLICATIONS: 0, PAPERS: 0, BOOKS: 0 },
      translated: 0,
      coverFetched: 0,
      saved: 0,
      dryRun: opts.dryRun,
      errors: [],
      ...(opts.dryRun ? { preview: [] } : {}),
    };

    // 키워드 간 중복(같은 자료가 여러 키워드에서 검색)은 sourceId 기준으로 병합
    const merged = this.mergeBySourceId(items);
    summary.deduped = merged.length;
    this.logger.log(
      `[archive:${source}] 수집 ${items.length}건 → 키워드 간 중복 병합 후 ${merged.length}건 처리 시작` +
      ` (S3에 이미 저장된 건은 처리 중 스킵되므로 실제 신규 저장은 이 이하)${opts.dryRun ? ' [dryRun]' : ''}`,
    );

    for (const { item, matchedKeywords } of merged) {
      const itemHash = createHash('md5')
        .update(`${item.source}:${item.sourceId}`)
        .digest('hex')
        .slice(0, 8);

      try {
        if (!opts.dryRun) {
          const exists = await this.s3Service.archiveItemExists(originId, itemHash);
          if (exists) {
            summary.skippedExisting++;
            continue;
          }
        }

        // menu_id 결정: 단행본은 BOOKS 고정, 그 외 발행기관 분류로 발간자료/논문 분기
        const classification = await this.classifier.classify(item.publisher);
        const menuId = this.decideMenuId(item, classification.verdict);
        summary.classified[menuId]++;

        // 번역 — API가 영문을 직접 준 필드는 건너뛰고, 나머지만 번역앱 호출
        const en = await this.buildEnglishFields(item, opts, summary);

        // BOOKS + ISBN → 표지 URL (실패해도 수집은 계속)
        let coverUrl: string | null = null;
        if (!opts.dryRun && menuId === 'BOOKS' && item.isbn) {
          try {
            const book = await this.isbnService.getBookInfo(item.isbn);
            coverUrl = book.coverUrl;
            if (coverUrl) summary.coverFetched++;
          } catch (e) {
            this.logger.warn(
              `[archive:${item.source}] 표지 조회 실패(계속 진행) isbn=${item.isbn}: ${(e as Error).message}`,
            );
          }
        }

        const meta: ArchiveMeta = {
          source: item.source,
          sourceId: item.sourceId,
          menuId,
          title: item.title,
          titleEn: en.titleEn,
          publisher: item.publisher,
          publisherEn: en.publisherEn,
          author: item.author,
          authorEn: en.authorEn,
          publishYear: item.publishYear,
          category: item.category,
          categoryEn: en.categoryEn,
          subCategory: item.subCategory,
          subCategoryEn: null,
          summary: item.summary,
          summaryEn: en.summaryEn,
          linkUrl: item.detailUrl,
          isbn: item.isbn,
          coverUrl,
          registerNo: `${item.source.toUpperCase()}:${item.sourceId}`,
          remark: SOURCE_LABEL[item.source] ?? null,
          matchedKeywords,
          classification,
          collectedAt: moment().format(DT_FORMAT),
        };

        if (opts.dryRun) {
          if ((summary.preview?.length ?? 0) < DRY_RUN_PREVIEW_LIMIT) {
            summary.preview!.push(meta);
          }
          continue;
        }

        // 폴더명에 정리된 제목을 붙여 S3 콘솔에서 바로 식별 가능하게 저장
        await this.s3Service.saveArchiveMeta(
          originId, itemHash, meta, titleToS3Suffix(item.title),
        );
        summary.saved++;
        this.logger.log(
          `[archive:${item.source}] meta.json 저장 hash=${itemHash} menu=${menuId} ` +
          `(발행: ${item.publisher || '-'} → ${classification.verdict}/${classification.by}) "${item.title}"`,
        );
      } catch (e) {
        this.logger.error(
          `[archive:${item.source}] 아이템 처리 실패 (${item.sourceId}): ${(e as Error).message}`,
        );
        summary.errors.push({ sourceId: item.sourceId, message: (e as Error).message });
      }
    }

    // LLM 판정 캐시 영속화 (실패해도 무시)
    await this.classifier.flushCache();

    this.logger.log(
      `[archive:${source}] ingest 종료: fetched=${summary.fetched} deduped=${summary.deduped} ` +
      `신규저장=${summary.saved} 중복=${summary.skippedExisting} ` +
      `(발간자료 ${summary.classified.PUBLICATIONS} / 논문 ${summary.classified.PAPERS} / 단행본 ${summary.classified.BOOKS}) ` +
      `번역=${summary.translated} 오류=${summary.errors.length}${opts.dryRun ? ' [dryRun]' : ''}`,
    );

    // 수집 완료 후 S3 저장분 전체 현황(제목+메타+분류근거)을 프로젝트 루트에 텍스트 리포트로 출력.
    // 리포트 실패가 수집 결과를 깨면 안 되므로 오류는 경고만 남긴다.
    if (!opts.dryRun) {
      try {
        await this.reportService.writeReport(originId, source);
      } catch (e) {
        this.logger.warn(
          `[archive:${source}] 저장 현황 리포트 생성 실패(무시): ${(e as Error).message}`,
        );
      }
    }
    return summary;
  }

  private decideMenuId(item: ArchiveItem, verdict: 'GOV' | 'PRIVATE'): ArchiveMenuId {
    if (item.materialType === 'book') return 'BOOKS';
    return verdict === 'GOV' ? 'PUBLICATIONS' : 'PAPERS';
  }

  private mergeBySourceId(
    items: ArchiveItem[],
  ): { item: ArchiveItem; matchedKeywords: string[] }[] {
    const map = new Map<string, { item: ArchiveItem; matchedKeywords: string[] }>();
    for (const item of items) {
      const key = `${item.source}:${item.sourceId}`;
      const existing = map.get(key);
      if (existing) {
        if (!existing.matchedKeywords.includes(item.matchedKeyword)) {
          existing.matchedKeywords.push(item.matchedKeyword);
        }
      } else {
        map.set(key, { item, matchedKeywords: [item.matchedKeyword] });
      }
    }
    return [...map.values()];
  }

  /**
   * 영문 필드 구성. API 제공 영문(KCI/NTIS)이 있으면 그대로 쓰고,
   * 없는 필드만 번역앱(translateFields)으로 채운다. 번역 실패 시 null — 수집은 계속.
   */
  private async buildEnglishFields(
    item: ArchiveItem,
    opts: ArchiveCollectOptions,
    summary: ArchiveIngestSummary,
  ) {
    const en = {
      titleEn: this.presentOrNull(item.titleEn),
      summaryEn: this.presentOrNull(item.summaryEn),
      authorEn: this.presentOrNull(item.authorEn), // 인명은 번역하지 않음 — API 제공분만
      publisherEn: null as string | null,
      categoryEn: null as string | null,
    };

    if (!opts.translate || opts.dryRun) return en;

    // 번역이 필요한 필드만 모은다 (원문이 없으면 번역할 것도 없음)
    const fields: Record<string, string> = {};
    if (!en.titleEn && item.title) fields.title = item.title;
    if (item.publisher) fields.publisher = item.publisher;
    if (!en.summaryEn && item.summary) fields.summary = item.summary;
    if (item.category) fields.category = item.category;
    if (Object.keys(fields).length === 0) return en;

    try {
      const translated = await this.translationClient.translateFields(fields);
      en.titleEn = en.titleEn ?? this.presentOrNull(translated.title);
      en.publisherEn = this.presentOrNull(translated.publisher);
      en.summaryEn = en.summaryEn ?? this.presentOrNull(translated.summary);
      en.categoryEn = this.presentOrNull(translated.category);
      summary.translated++;
    } catch (e) {
      // 번역 앱 다운/실패 → _en null 저장, trsl_yn='N' (export 시 판정)
      this.logger.warn(
        `[archive:${item.source}] 번역 실패, 원문만 저장 "${item.title}": ${(e as Error).message}`,
      );
    }
    return en;
  }

  private presentOrNull(value?: string | null): string | null {
    const text = String(value ?? '').trim();
    return text ? text : null;
  }
}
