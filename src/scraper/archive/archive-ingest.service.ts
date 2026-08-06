import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import moment from 'moment';
import { S3Service } from 'src/aws/s3/s3.service';
import { IsbnService } from 'src/isbn/isbn.service';
import { TranslationClientService } from '../translation-client.service';
import { ArchiveReportService } from './archive-report.service';
import { NON_ACADEMIC_PUBLISHER_PATTERNS } from './gov-institutions.const';
import { InstitutionClassifierService } from './institution-classifier.service';
import { RelevanceFilterService } from './relevance-filter.service';
import { ThemeClassifierService } from './theme-classifier.service';
import {
  ArchiveCollectOptions,
  ArchiveIngestSummary,
  ArchiveItem,
  ArchiveMaterialType,
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
  losi: '국회도서관 LOSI OpenAPI 수집',
  kisti: 'KISTI ScienceON OpenAPI 수집',
  encykorea: '한국민족문화대백과사전 OpenAPI 수집',
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
    private readonly relevanceFilter: RelevanceFilterService,
    private readonly themeClassifier: ThemeClassifierService,
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
      droppedIrrelevant: 0,
      droppedNonAcademic: 0,
      droppedUnclassifiable: 0,
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

    // Pass 1: 중복확인(S3) + DMZ 관련성 필터 — 생존 아이템만 다음 단계로 넘긴다.
    // (스킵/제외될 건에 불필요한 주제분류 LLM 호출을 하지 않기 위해 먼저 거른다)
    const survivors: {
      item: ArchiveItem;
      matchedKeywords: string[];
      itemHash: string;
    }[] = [];
    for (const { item, matchedKeywords } of merged) {
      const itemHash = createHash('md5')
        .update(`${item.source}:${item.sourceId}`)
        .digest('hex')
        .slice(0, 8);

      try {
        if (!opts.dryRun) {
          const exists = await this.s3Service.archiveItemExists(
            originId,
            itemHash,
          );
          if (exists) {
            summary.skippedExisting++;
            continue;
          }
        }

        // DMZ 무관(키워드 오매칭·해외 접경 등) 필터 — 규칙 우선 + LLM 폴백.
        // 무관이면 저장하지 않는다. S3 존재확인 직후 = 이미 저장된 건엔 판정 LLM을 태우지 않음.
        const relevance = await this.relevanceFilter.isRelevant(item);
        if (!relevance.relevant) {
          summary.droppedIrrelevant++;
          this.logger.log(
            `[archive:${item.source}] DMZ 무관 → 저장 제외 (${relevance.by}${relevance.reason ? `: ${relevance.reason}` : ''}) "${item.title}"`,
          );
          continue;
        }

        // 언론사·의원실·사무처 발행물은 발행기관 판정이 옳더라도 학술자료가 아니므로 제외.
        // (LOSI의 ARTICLE 검색범위가 시사주간지·신문 칼럼까지 함께 잡아오는 문제 대응)
        if (
          NON_ACADEMIC_PUBLISHER_PATTERNS.some((p) =>
            p.test(item.publisher ?? ''),
          )
        ) {
          summary.droppedNonAcademic++;
          this.logger.log(
            `[archive:${item.source}] 학술자료 발행처 아님 → 저장 제외 (발행처: ${item.publisher}) "${item.title}"`,
          );
          continue;
        }

        survivors.push({ item, matchedKeywords, itemHash });
      } catch (e) {
        this.logger.error(
          `[archive:${item.source}] 아이템 처리 실패 (${item.sourceId}): ${(e as Error).message}`,
        );
        summary.errors.push({
          sourceId: item.sourceId,
          message: (e as Error).message,
        });
      }
    }

    // Pass 2: 주제분류(포털 18종, ThemeClassifier) — 소스 불문 제목 기준 일괄 배치 분류.
    // 컬렉터가 채운 원래 category(있다면)는 쓰지 않고 여기서 결정한 값으로 통일한다.
    const themes = survivors.length
      ? await this.themeClassifier.classifyTitles(
          survivors.map((s) => s.item.title),
        )
      : [];

    // Pass 3: 발행기관분류(menu_id) + 번역 + (BOOKS) 표지조회 + 저장
    for (let i = 0; i < survivors.length; i++) {
      const { item, matchedKeywords, itemHash } = survivors[i];
      const category = themes[i] ?? '접경지역';

      try {
        // menu_id 결정: 단행본은 BOOKS 고정, 그 외 발행기관 분류로 발간자료/논문 분기
        const classification = await this.classifier.classify(item.publisher);
        // publisher가 없어 판정 근거가 전혀 없는 건(by='default')은 PRIVATE로 찍고 논문 취급하면
        // "정부기관 아님이 확인된 논문"이라는 분류기준을 만족 못 하므로 저장하지 않는다.
        if (classification.by === 'default') {
          summary.droppedUnclassifiable++;
          this.logger.log(
            `[archive:${item.source}] 발행기관 판정불가(publisher 없음) → 저장 제외 "${item.title}"`,
          );
          continue;
        }
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
          category,
          categoryEn: null, // 주제분류(18종)는 고정 한국어 라벨 — 번역하지 않음
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
          originId,
          itemHash,
          meta,
          titleToS3Suffix(item.title),
        );
        summary.saved++;
        this.logger.log(
          `[archive:${item.source}] meta.json 저장 hash=${itemHash} menu=${menuId} category=${category} ` +
            `(발행: ${item.publisher || '-'} → ${classification.verdict}/${classification.by}) "${item.title}"`,
        );
      } catch (e) {
        this.logger.error(
          `[archive:${item.source}] 아이템 처리 실패 (${item.sourceId}): ${(e as Error).message}`,
        );
        summary.errors.push({
          sourceId: item.sourceId,
          message: (e as Error).message,
        });
      }
    }

    // LLM 판정 캐시 영속화 (실패해도 무시)
    await this.classifier.flushCache();
    await this.relevanceFilter.flushCache();

    this.logger.log(
      `[archive:${source}] ingest 종료: fetched=${summary.fetched} deduped=${summary.deduped} ` +
        `신규저장=${summary.saved} 중복=${summary.skippedExisting} DMZ무관제외=${summary.droppedIrrelevant} ` +
        `비학술발행처제외=${summary.droppedNonAcademic} 발행기관판정불가제외=${summary.droppedUnclassifiable} ` +
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

  private decideMenuId(
    item: ArchiveItem,
    verdict: 'GOV' | 'PRIVATE',
  ): ArchiveMenuId {
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
    const RISS_CAT: Record<
      string,
      { label: string; en: string; type: ArchiveItem['materialType'] }
    > = {
      A: {
        label: '국내학술논문',
        en: 'Domestic Academic Article',
        type: 'article',
      },
      T: { label: '학위논문', en: 'Dissertation', type: 'thesis' },
      U: { label: '단행본', en: 'Book', type: 'book' },
    };

    const originId = Number(process.env.RISS_ORIGIN_ID);
    const entries = await this.s3Service.listArchiveMetaEntries(originId);
    this.logger.log(
      `[reclassify:riss] S3 meta ${entries.length}건 로드 — 재분류 시작 (dryRun=${dryRun})`,
    );

    // register_no별 최종 UPDATE 값 계산
    const rows: {
      registerNo: string;
      menuId: ArchiveMenuId;
      label: string;
      en: string;
    }[] = [];
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

          rows.push({
            registerNo: meta.registerNo,
            menuId: newMenu,
            label: cat.label,
            en: cat.en,
          });

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

    return {
      originId,
      total: rows.length,
      menuChanged,
      catChanged,
      s3Updated,
      sqlPath,
      menuMoves,
    };
  }

  /**
   * category/category_en는 전체를 접두어 CASE 한 방으로, menu_id는 목표 메뉴별 IN-list로 묶어 SQL 생성.
   * (register_no가 유니크 키라 WHERE로 정확히 특정됨. mdfcn_dt는 SYSDATETIME)
   */
  private buildReclassifySql(
    rows: {
      registerNo: string;
      menuId: ArchiveMenuId;
      label: string;
      en: string;
    }[],
  ): string {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const lines: string[] = [];

    lines.push('-- RISS 자료마당 재분류 (자동 생성) — CUBRID');
    lines.push(
      '-- 1) category/category_en 를 자료유형 라벨로 (register_no 접두 A/T/U 기준), mdfcn_dt=현재시각',
    );
    lines.push('UPDATE archive');
    lines.push('SET category = CASE');
    lines.push("      WHEN register_no LIKE 'RISS:A%' THEN '국내학술논문'");
    lines.push("      WHEN register_no LIKE 'RISS:T%' THEN '학위논문'");
    lines.push("      WHEN register_no LIKE 'RISS:U%' THEN '단행본'");
    lines.push('      ELSE category');
    lines.push('    END,');
    lines.push('    category_en = CASE');
    lines.push(
      "      WHEN register_no LIKE 'RISS:A%' THEN 'Domestic Academic Article'",
    );
    lines.push("      WHEN register_no LIKE 'RISS:T%' THEN 'Dissertation'");
    lines.push("      WHEN register_no LIKE 'RISS:U%' THEN 'Book'");
    lines.push('      ELSE category_en');
    lines.push('    END,');
    lines.push('    mdfcn_dt = SYSDATETIME');
    lines.push("WHERE remark = 'RISS OpenAPI 수집';");
    lines.push('');
    lines.push(
      '-- 2) menu_id 재분류 — 목표 메뉴별로 대상 register_no를 IN-list로 UPDATE',
    );

    for (const target of [
      'PUBLICATIONS',
      'PAPERS',
      'BOOKS',
    ] as ArchiveMenuId[]) {
      const ids = rows
        .filter((r) => r.menuId === target)
        .map((r) => r.registerNo);
      if (ids.length === 0) continue;
      lines.push('');
      lines.push(`-- → ${target}: ${ids.length}건`);
      // IN-list는 900개 단위로 쪼개 (CUBRID IN 절 상한 대비)
      for (let i = 0; i < ids.length; i += 900) {
        const chunk = ids
          .slice(i, i + 900)
          .map(q)
          .join(', ');
        lines.push(
          `UPDATE archive SET menu_id = '${target}', mdfcn_dt = SYSDATETIME`,
        );
        lines.push(
          `WHERE remark = 'RISS OpenAPI 수집' AND register_no IN (${chunk});`,
        );
      }
    }
    lines.push('');
    return lines.join('\n');
  }

  /**
   * (유지보수) CUBRID에 적재된 RISS 부분집합(docs/ARCHIVE_RISS.csv: archive_id,title,register_no)만
   * 현재 기준으로 재분류한다.
   *  - category  = 주제분류 18종 (ThemeClassifier, 제목 기반 LLM)
   *  - menu_id   = 발행처분류(GOV/PRIVATE) + 자료유형 규칙
   *  - category_en = NULL (앞서 잘못 넣은 자료유형 영문 제거)
   * apply=false면 S3/SQL 안 만들고 분류 결과 샘플만, limit로 앞 N건만 처리(샘플 확인용).
   * S3 meta 덮어쓰기 + register_no 기준 CUBRID UPDATE SQL(archive-reclassify-riss.sql) 생성.
   */
  async reclassifyRissFromCsv(opts: {
    limit?: number;
    apply?: boolean;
  }): Promise<{
    csvRegisterNos: number;
    notFoundInS3: number;
    processed: number;
    s3Updated: number;
    apply: boolean;
    themeDist: Record<string, number>;
    menuMoves: Record<string, number>;
    sample: {
      registerNo: string;
      title: string;
      publisher: string;
      oldMenu: string;
      newMenu: string;
      oldCategory: string | null;
      theme: string;
    }[];
  }> {
    const csvPath = path.join(process.cwd(), 'docs/ARCHIVE_RISS.csv');
    const raw = await fs.readFile(csvPath, 'utf-8');
    // 제목에 콤마/따옴표가 있어도 안전하게, register_no만 정규식으로 추출
    const rns = [...new Set(raw.match(/RISS:[ATU][A-Za-z0-9]+/g) ?? [])];

    const originId = Number(process.env.RISS_ORIGIN_ID);
    const entries = await this.s3Service.listArchiveMetaEntries(originId);
    const byRn = new Map<string, { key: string; meta: ArchiveMeta }>();
    for (const e of entries) {
      byRn.set((e.meta as ArchiveMeta).registerNo, {
        key: e.key,
        meta: e.meta as ArchiveMeta,
      });
    }

    let targets = rns.map((rn) => byRn.get(rn)).filter(Boolean) as {
      key: string;
      meta: ArchiveMeta;
    }[];
    const notFoundInS3 = rns.length - targets.length;
    if (opts.limit && opts.limit > 0) targets = targets.slice(0, opts.limit);

    this.logger.log(
      `[reclassify-csv] CSV register_no ${rns.length} / S3매칭 ${rns.length - notFoundInS3} / 처리대상 ${targets.length} (apply=${!!opts.apply})`,
    );

    // 1) 주제분류 (LLM 배치) — 제목 기준
    const themes = await this.themeClassifier.classifyTitles(
      targets.map((t) => t.meta.title),
    );

    // 2) 발행처분류 → menu_id 재계산 + (apply) S3 덮어쓰기
    const sqlRows: {
      registerNo: string;
      menuId: ArchiveMenuId;
      theme: string;
    }[] = [];
    const sample: any[] = [];
    const themeDist: Record<string, number> = {};
    const menuMoves: Record<string, number> = {};
    let s3Updated = 0;

    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(20);
    await Promise.all(
      targets.map((t, i) =>
        limit(async () => {
          const meta = t.meta;
          const prefix = meta.registerNo.split(':')[1]?.[0]?.toUpperCase();
          const materialType: ArchiveMaterialType =
            prefix === 'U' ? 'book' : prefix === 'T' ? 'thesis' : 'article';
          const verdict = await this.classifier.classify(meta.publisher);
          const newMenu = decideArchiveMenu(materialType, verdict.verdict);
          const theme = themes[i] ?? '접경지역';

          themeDist[theme] = (themeDist[theme] ?? 0) + 1;
          if (newMenu !== meta.menuId) {
            const k = `${meta.menuId}→${newMenu}`;
            menuMoves[k] = (menuMoves[k] ?? 0) + 1;
          }
          sqlRows.push({ registerNo: meta.registerNo, menuId: newMenu, theme });
          if (sample.length < 60) {
            sample.push({
              registerNo: meta.registerNo,
              title: meta.title,
              publisher: meta.publisher,
              oldMenu: meta.menuId,
              newMenu,
              oldCategory: meta.category,
              theme,
            });
          }

          if (opts.apply) {
            const updated: ArchiveMeta = {
              ...meta,
              menuId: newMenu,
              category: theme,
              categoryEn: null,
              classification: verdict,
            };
            await this.s3Service.overwriteArchiveMeta(t.key, updated);
            s3Updated++;
          }
        }),
      ),
    );

    if (opts.apply) {
      const sqlPath = path.join(process.cwd(), 'archive-reclassify-riss.sql');
      await fs.writeFile(sqlPath, this.buildCsvReclassifySql(sqlRows), 'utf-8');
      this.logger.log(
        `[reclassify-csv] S3 ${s3Updated}건 덮어쓰기 + SQL ${sqlPath} (${sqlRows.length}행)`,
      );
    }

    return {
      csvRegisterNos: rns.length,
      notFoundInS3,
      processed: targets.length,
      s3Updated,
      apply: !!opts.apply,
      themeDist,
      menuMoves,
      sample,
    };
  }

  /** register_no 기준 per-row UPDATE (category=주제, category_en=NULL, menu_id, mdfcn_dt). CUBRID */
  private buildCsvReclassifySql(
    rows: { registerNo: string; menuId: ArchiveMenuId; theme: string }[],
  ): string {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const lines: string[] = [
      '-- RISS 재분류 (CUBRID 적재분 = docs/ARCHIVE_RISS.csv) — register_no 기준',
      '-- category=주제분류(18종), menu_id=발행처분류(공공/민간)+자료유형 규칙, category_en=NULL(자료유형 영문 제거)',
    ];
    for (const r of rows) {
      lines.push(
        `UPDATE archive SET menu_id=${q(r.menuId)}, category=${q(r.theme)}, category_en=NULL, ` +
          `mdfcn_dt=SYSDATETIME WHERE register_no=${q(r.registerNo)};`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  /**
   * (유지보수, 1회성) 이미 S3에 저장된 LOSI meta.json의 category를 ThemeClassifier(18종)로 채운다.
   * LOSI 컬렉터는 원래 category를 늘 null로 수집했고(재분류 파이프라인 부재), CUBRID 쪽에서
   * null이 기본값 '접경지역'으로 들어가 전건이 같은 분류로 보이던 문제를 제목 기준 일괄 재분류로 해소한다.
   * menu_id는 건드리지 않는다(문제된 건 category뿐). dryRun=true면 S3는 안 건드리고 집계만 낸다.
   */
  async reclassifyLosi(dryRun = true): Promise<{
    originId: number;
    total: number;
    s3Updated: number;
    sqlPath: string | null;
    themeDist: Record<string, number>;
    sample: {
      registerNo: string;
      title: string;
      oldCategory: string | null;
      theme: string;
    }[];
  }> {
    const originId = Number(process.env.LOSI_ORIGIN_ID);
    const entries = await this.s3Service.listArchiveMetaEntries(originId);
    this.logger.log(
      `[reclassify:losi] S3 meta ${entries.length}건 로드 — 재분류 시작 (dryRun=${dryRun})`,
    );

    const themes = entries.length
      ? await this.themeClassifier.classifyTitles(
          entries.map((e) => (e.meta as ArchiveMeta).title),
        )
      : [];

    const themeDist: Record<string, number> = {};
    const sample: {
      registerNo: string;
      title: string;
      oldCategory: string | null;
      theme: string;
    }[] = [];
    let s3Updated = 0;

    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(20);
    await Promise.all(
      entries.map((entry, i) =>
        limit(async () => {
          const meta = entry.meta as ArchiveMeta;
          const theme = themes[i] ?? '접경지역';
          themeDist[theme] = (themeDist[theme] ?? 0) + 1;
          if (sample.length < 60) {
            sample.push({
              registerNo: meta.registerNo,
              title: meta.title,
              oldCategory: meta.category,
              theme,
            });
          }
          if (!dryRun) {
            const updated: ArchiveMeta = {
              ...meta,
              category: theme,
              categoryEn: null,
            };
            await this.s3Service.overwriteArchiveMeta(entry.key, updated);
            s3Updated++;
          }
        }),
      ),
    );

    let sqlPath: string | null = null;
    if (!dryRun) {
      sqlPath = path.join(process.cwd(), 'archive-reclassify-losi.sql');
      await fs.writeFile(
        sqlPath,
        this.buildLosiReclassifySql(entries, themes),
        'utf-8',
      );
    }
    this.logger.log(
      `[reclassify:losi] 완료 — 총 ${entries.length} / S3덮어쓰기 ${s3Updated}` +
        (sqlPath ? ` / SQL ${sqlPath}` : ''),
    );

    return {
      originId,
      total: entries.length,
      s3Updated,
      sqlPath,
      themeDist,
      sample,
    };
  }

  /** register_no 기준 per-row UPDATE (category=주제 18종, category_en=NULL, mdfcn_dt). CUBRID */
  private buildLosiReclassifySql(
    entries: { meta: unknown }[],
    themes: string[],
  ): string {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const lines: string[] = [
      '-- LOSI 재분류 (자동 생성) — category=주제분류(18종, ThemeClassifier), category_en=NULL — CUBRID',
    ];
    entries.forEach((entry, i) => {
      const meta = entry.meta as ArchiveMeta;
      const theme = themes[i] ?? '접경지역';
      lines.push(
        `UPDATE archive SET category=${q(theme)}, category_en=NULL, ` +
          `mdfcn_dt=SYSDATETIME WHERE register_no=${q(meta.registerNo)};`,
      );
    });
    lines.push('');
    return lines.join('\n');
  }

  private mergeBySourceId(
    items: ArchiveItem[],
  ): { item: ArchiveItem; matchedKeywords: string[] }[] {
    const map = new Map<
      string,
      { item: ArchiveItem; matchedKeywords: string[] }
    >();
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
    };

    if (!opts.translate || opts.dryRun) return en;

    // 번역이 필요한 필드만 모은다 (원문이 없으면 번역할 것도 없음)
    // category는 ThemeClassifier가 정한 18종 고정 라벨로 통일되므로 번역 대상에서 제외
    const fields: Record<string, string> = {};
    if (!en.titleEn && item.title) fields.title = item.title;
    if (item.publisher) fields.publisher = item.publisher;
    if (!en.summaryEn && item.summary) fields.summary = item.summary;
    if (Object.keys(fields).length === 0) return en;

    try {
      const translated = await this.translationClient.translateFields(fields);
      en.titleEn = en.titleEn ?? this.presentOrNull(translated.title);
      en.publisherEn = this.presentOrNull(translated.publisher);
      en.summaryEn = en.summaryEn ?? this.presentOrNull(translated.summary);
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
