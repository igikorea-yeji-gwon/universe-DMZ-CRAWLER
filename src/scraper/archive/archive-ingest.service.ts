import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
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
  decideArchiveMenu,
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
    sourceHint?: ArchiveItem['source'],
  ): Promise<ArchiveIngestSummary> {
    // 수집 0건이어도 응답 source가 올바르게 나가도록 컬렉터가 준 힌트를 우선한다
    const source = items[0]?.source ?? sourceHint ?? 'kci';
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
    return decideArchiveMenu(item.materialType, verdict);
  }

  /**
   * (유지보수) 이미 S3에 저장된 RISS meta.json을 현재 분류기/규칙으로 재계산해
   * ① 바뀐 meta.json을 S3에 덮어쓰고 ② CUBRID UPDATE SQL을 프로젝트 루트에 생성한다.
   * - category: 자료유형(register_no 접두 A/T/U) 라벨로 통일 (기존 '접경지역'/null 교체)
   * - menu_id: decideArchiveMenu 규칙으로 재분류 (GOV→발간자료, PRIVATE면 book→단행본·그외 논문)
   * dryRun=true면 S3는 안 건드리고 집계 + SQL만 생성한다.
   */
  async reclassifyRiss(dryRun = true): Promise<{
    originId: number;
    total: number;
    menuChanged: number;
    catChanged: number;
    s3Updated: number;
    sqlPath: string;
    menuMoves: Record<string, number>;
  }> {
    const RISS_CAT: Record<string, { label: string; en: string; type: ArchiveItem['materialType'] }> = {
      A: { label: '국내학술논문', en: 'Domestic Academic Article', type: 'article' },
      T: { label: '학위논문', en: 'Dissertation', type: 'thesis' },
      U: { label: '단행본', en: 'Book', type: 'book' },
    };

    const originId = Number(process.env.RISS_ORIGIN_ID);
    const entries = await this.s3Service.listArchiveMetaEntries(originId);
    this.logger.log(`[reclassify:riss] S3 meta ${entries.length}건 로드 — 재분류 시작 (dryRun=${dryRun})`);

    // register_no별 최종 UPDATE 값 계산
    const rows: { registerNo: string; menuId: ArchiveMenuId; label: string; en: string }[] = [];
    const menuMoves: Record<string, number> = {}; // "BOOKS→PUBLICATIONS" 형태 집계
    let menuChanged = 0;
    let catChanged = 0;
    let s3Updated = 0;

    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(20);

    await Promise.all(
      entries.map((entry) =>
        limit(async () => {
          const meta = entry.meta as ArchiveMeta;
          const prefix = meta.registerNo?.split(':')[1]?.[0]?.toUpperCase(); // A/T/U
          const cat = RISS_CAT[prefix ?? ''];
          if (!cat) return; // RISS:A/T/U 아닌 예외는 건너뜀

          const verdict = await this.classifier.classify(meta.publisher);
          const newMenu = decideArchiveMenu(cat.type, verdict.verdict);

          const menuDiff = newMenu !== meta.menuId;
          const catDiff = meta.category !== cat.label;
          if (menuDiff) {
            menuChanged++;
            const k = `${meta.menuId}→${newMenu}`;
            menuMoves[k] = (menuMoves[k] ?? 0) + 1;
          }
          if (catDiff) catChanged++;

          rows.push({ registerNo: meta.registerNo, menuId: newMenu, label: cat.label, en: cat.en });

          if (!dryRun && (menuDiff || catDiff)) {
            const updated: ArchiveMeta = {
              ...meta,
              menuId: newMenu,
              category: cat.label,
              categoryEn: cat.en,
              classification: verdict,
            };
            await this.s3Service.overwriteArchiveMeta(entry.key, updated);
            s3Updated++;
          }
        }),
      ),
    );

    const sqlPath = path.join(process.cwd(), 'archive-reclassify-riss.sql');
    await fs.writeFile(sqlPath, this.buildReclassifySql(rows), 'utf-8');
    this.logger.log(
      `[reclassify:riss] 완료 — 총 ${rows.length} / menu변경 ${menuChanged} / cat변경 ${catChanged} ` +
      `/ S3덮어쓰기 ${s3Updated} / SQL ${sqlPath}`,
    );

    return { originId, total: rows.length, menuChanged, catChanged, s3Updated, sqlPath, menuMoves };
  }

  /**
   * category/category_en는 전체를 접두어 CASE 한 방으로, menu_id는 목표 메뉴별 IN-list로 묶어 SQL 생성.
   * (register_no가 유니크 키라 WHERE로 정확히 특정됨. mdfcn_dt는 SYSDATETIME)
   */
  private buildReclassifySql(
    rows: { registerNo: string; menuId: ArchiveMenuId; label: string; en: string }[],
  ): string {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const lines: string[] = [];

    lines.push('-- RISS 자료마당 재분류 (자동 생성) — CUBRID');
    lines.push('-- 1) category/category_en 를 자료유형 라벨로 (register_no 접두 A/T/U 기준), mdfcn_dt=현재시각');
    lines.push('UPDATE archive');
    lines.push("SET category = CASE");
    lines.push("      WHEN register_no LIKE 'RISS:A%' THEN '국내학술논문'");
    lines.push("      WHEN register_no LIKE 'RISS:T%' THEN '학위논문'");
    lines.push("      WHEN register_no LIKE 'RISS:U%' THEN '단행본'");
    lines.push('      ELSE category');
    lines.push('    END,');
    lines.push('    category_en = CASE');
    lines.push("      WHEN register_no LIKE 'RISS:A%' THEN 'Domestic Academic Article'");
    lines.push("      WHEN register_no LIKE 'RISS:T%' THEN 'Dissertation'");
    lines.push("      WHEN register_no LIKE 'RISS:U%' THEN 'Book'");
    lines.push('      ELSE category_en');
    lines.push('    END,');
    lines.push('    mdfcn_dt = SYSDATETIME');
    lines.push("WHERE remark = 'RISS OpenAPI 수집';");
    lines.push('');
    lines.push('-- 2) menu_id 재분류 — 목표 메뉴별로 대상 register_no를 IN-list로 UPDATE');

    for (const target of ['PUBLICATIONS', 'PAPERS', 'BOOKS'] as ArchiveMenuId[]) {
      const ids = rows.filter((r) => r.menuId === target).map((r) => r.registerNo);
      if (ids.length === 0) continue;
      lines.push('');
      lines.push(`-- → ${target}: ${ids.length}건`);
      // IN-list는 900개 단위로 쪼개 (CUBRID IN 절 상한 대비)
      for (let i = 0; i < ids.length; i += 900) {
        const chunk = ids.slice(i, i + 900).map(q).join(', ');
        lines.push(`UPDATE archive SET menu_id = '${target}', mdfcn_dt = SYSDATETIME`);
        lines.push(`WHERE remark = 'RISS OpenAPI 수집' AND register_no IN (${chunk});`);
      }
    }
    lines.push('');
    return lines.join('\n');
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
