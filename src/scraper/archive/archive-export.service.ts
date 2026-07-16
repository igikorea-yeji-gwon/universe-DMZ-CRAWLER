import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import moment from 'moment';
import { S3Service } from 'src/aws/s3/s3.service';
import { ArchiveSource, ExportedArchiveItem } from './archive.types';

const DT_FORMAT = 'YYYY-MM-DD HH:mm:ss';

/**
 * S3의 아카이브 meta.json을 스프링(외부 적재기)이 바로 archive 테이블에 넣을 수 있는
 * DB-ready 형태로 정규화해 반환한다. 고정값(use_yn/rgtr_id 등)·trsl_yn 판정 등
 * 적재 비즈니스 규칙은 전부 여기서 끝내서 스프링이 재구현하지 않게 한다.
 * (뉴스의 ArticleExportService와 동일한 계약 방식 — GET /scraper/archives/:originId)
 */
@Injectable()
export class ArchiveExportService {
  private readonly logger = new Logger(ArchiveExportService.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly configService: ConfigService,
  ) {}

  async exportArchives(originId: number, since?: string) {
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

    // 아카이브 origin(RISS/KCI/NTIS_ORIGIN_ID)이 아니면 S3 조회 없이 빈 결과 반환
    const source = this.sourceOfOrigin(originId);
    if (!source) {
      this.logger.warn(`[archives] 등록되지 않은 origin_id=${originId} → 조회 생략, 빈 결과 반환`);
      return { originId, since: since ?? null, total: 0, knownOrigin: false, items: [] };
    }

    const entries = await this.s3Service.listArchiveMetaEntries(originId, sinceDate);
    const items = entries.map(({ meta, lastModified }) =>
      this.toDbReady(originId, source, meta, lastModified),
    );

    this.logger.log(
      `[archives] origin=${originId}(${source}) since=${since ?? '-'} → ${items.length}건 반환`,
    );
    return { originId, source, since: since ?? null, total: items.length, items };
  }

  /** 아카이브 수집 origin인지: RISS/KCI/NTIS_ORIGIN_ID 매칭 시 소스명 반환 */
  private sourceOfOrigin(originId: number): ArchiveSource | null {
    const mapping: [string, ArchiveSource][] = [
      ['RISS_ORIGIN_ID', 'riss'],
      ['KCI_ORIGIN_ID', 'kci'],
      ['NTIS_ORIGIN_ID', 'ntis'],
    ];
    for (const [envKey, source] of mapping) {
      const id = Number(this.configService.get(envKey));
      if (Number.isFinite(id) && id > 0 && id === originId) return source;
    }
    return null;
  }

  private toDbReady(
    originId: number,
    source: ArchiveSource,
    meta: Record<string, any>,
    lastModified: Date | null,
  ): ExportedArchiveItem {
    const trslYn =
      String(meta.titleEn ?? '').trim() || String(meta.summaryEn ?? '').trim()
        ? 'Y'
        : 'N';

    return {
      originId,
      source: meta.source ?? source,
      dedupKey: meta.registerNo ?? '',
      menuId: meta.menuId ?? 'PAPERS',
      title: meta.title ?? null,
      titleEn: meta.titleEn ?? null,
      publisher: meta.publisher ?? null,
      publisherEn: meta.publisherEn ?? null,
      publishYear: meta.publishYear || null,
      author: meta.author ?? '',
      authorEn: meta.authorEn ?? null,
      category: meta.category ?? null,
      categoryEn: meta.categoryEn ?? null,
      subCategory: meta.subCategory ?? null,
      subCategoryEn: meta.subCategoryEn ?? null,
      viewLocation: null,
      hasFile: 'X',
      summary: meta.summary ?? null,
      summaryEn: meta.summaryEn ?? null,
      linkUrl: meta.linkUrl ?? null,
      registerNo: meta.registerNo ?? '',
      callNo: null,
      filePath: null,
      remark: meta.remark ?? null,
      isbn: meta.isbn ?? null,
      coverUrl: meta.coverUrl ?? null,
      useYn: 'Y',
      rgtrId: 'admin',
      trslYn,
      collectedAt: lastModified ? moment(lastModified).format(DT_FORMAT) : null,
    };
  }
}
