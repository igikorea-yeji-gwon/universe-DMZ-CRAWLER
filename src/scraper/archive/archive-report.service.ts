import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import moment from 'moment';
import { S3Service } from 'src/aws/s3/s3.service';
import { ArchiveMenuId, ArchiveMeta } from './archive.types';

const MENU_LABEL: Record<ArchiveMenuId, string> = {
  PUBLICATIONS: '발간자료',
  PAPERS: '논문',
  BOOKS: '단행본',
};
const BY_LABEL: Record<string, string> = {
  dict: '사전',
  pattern: '패턴',
  llm: 'LLM판정',
  'llm-lowconf': 'LLM저신뢰→PRIVATE',
  cache: 'LLM캐시',
  default: '기본값(PRIVATE)',
};

/**
 * 수집 완료 후 S3에 저장된 아카이브 전체 현황을 텍스트 리포트로 프로젝트 루트에 출력한다.
 * 파일명: archive-report-{source}.txt (매 수집 run 종료 시 전체 재생성·덮어쓰기)
 * 내용: 요약 통계 → 발행기관별 분류 요약 → menu_id별 전체 아이템 목록(제목+메타+분류근거)
 */
@Injectable()
export class ArchiveReportService {
  private readonly logger = new Logger(ArchiveReportService.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly configService: ConfigService,
  ) {}

  /** 수동 재생성용 — source(kci/riss/ntis) → env의 ORIGIN_ID를 찾아 리포트 생성 */
  async writeReportBySource(source: string): Promise<{ filePath: string; total: number }> {
    const normalized = String(source ?? '').toLowerCase();
    if (!['kci', 'riss', 'ntis'].includes(normalized)) {
      throw new BadRequestException(`source는 kci/riss/ntis 중 하나여야 합니다: "${source}"`);
    }
    const originId = Number(this.configService.get(`${normalized.toUpperCase()}_ORIGIN_ID`));
    if (!Number.isFinite(originId) || originId <= 0) {
      throw new BadRequestException(`${normalized.toUpperCase()}_ORIGIN_ID 환경변수가 설정되지 않았습니다.`);
    }
    return this.writeReport(originId, normalized);
  }

  /** S3 저장분 전체를 읽어 리포트 파일 생성. 반환값은 파일 절대경로 (0건이면 null) */
  async writeReport(originId: number, source: string): Promise<{ filePath: string; total: number }> {
    const entries = await this.s3Service.listArchiveMetaEntries(originId);
    const metas = entries.map((e) => e.meta as ArchiveMeta);

    const filePath = path.join(process.cwd(), `archive-report-${source}.txt`);
    await fs.writeFile(filePath, this.render(originId, source, metas), 'utf-8');

    this.logger.log(
      `[archive:${source}] 저장 현황 리포트 생성: ${filePath} (총 ${metas.length}건)`,
    );
    return { filePath, total: metas.length };
  }

  private render(originId: number, source: string, metas: ArchiveMeta[]): string {
    const byMenu: Record<ArchiveMenuId, ArchiveMeta[]> = {
      PUBLICATIONS: [],
      PAPERS: [],
      BOOKS: [],
    };
    for (const m of metas) {
      (byMenu[m.menuId] ?? byMenu.PAPERS).push(m);
    }

    const lines: string[] = [];
    const bar = '='.repeat(100);
    const sub = '-'.repeat(100);

    lines.push(bar);
    lines.push(` ${source.toUpperCase()} (origin ${originId}) 아카이브 저장 현황 리포트`);
    lines.push(` 생성: ${moment().format('YYYY-MM-DD HH:mm:ss')} (KST)`);
    lines.push(
      ` 총 ${metas.length}건 — 발간자료(PUBLICATIONS) ${byMenu.PUBLICATIONS.length} / ` +
      `논문(PAPERS) ${byMenu.PAPERS.length} / 단행본(BOOKS) ${byMenu.BOOKS.length}`,
    );
    lines.push(
      ` 분류기준: 단행본→BOOKS 고정, 발행기관 GOV(정부·지자체·국책연)→PUBLICATIONS, PRIVATE(학회·대학·민간)→PAPERS`,
    );
    lines.push(` 분류근거 표기: ${Object.entries(BY_LABEL).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    lines.push(bar);

    // ── 발행기관별 분류 요약 (오분류 검토용) ──
    const byPublisher = new Map<string, { verdict: string; by: string; menuId: string; count: number }>();
    for (const m of metas) {
      const key = m.publisher || '(발행기관 없음)';
      const cur = byPublisher.get(key);
      if (cur) cur.count++;
      else {
        byPublisher.set(key, {
          verdict: m.classification?.verdict ?? '-',
          by: m.classification?.by ?? '-',
          menuId: m.menuId,
          count: 1,
        });
      }
    }
    lines.push('');
    lines.push(`■ 발행기관별 분류 요약 — ${byPublisher.size}개 기관 (건수 내림차순)`);
    lines.push(sub);
    const publishers = [...byPublisher.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [publisher, p] of publishers) {
      lines.push(
        `${String(p.count).padStart(5)}건 | ${p.menuId.padEnd(12)} | ` +
        `${p.verdict.padEnd(7)}/${(BY_LABEL[p.by] ?? p.by).padEnd(10)} | ${publisher}`,
      );
    }

    // ── menu_id별 전체 아이템 목록 ──
    for (const menuId of ['PUBLICATIONS', 'PAPERS', 'BOOKS'] as ArchiveMenuId[]) {
      const items = byMenu[menuId];
      lines.push('');
      lines.push(`■ ${menuId} (${MENU_LABEL[menuId]}) — ${items.length}건`);
      lines.push(sub);
      // 발행기관 → 연도 → 제목 순 정렬 (같은 기관 자료가 모여 검토 쉬움)
      items.sort(
        (a, b) =>
          (a.publisher || '').localeCompare(b.publisher || '', 'ko') ||
          (b.publishYear || '').localeCompare(a.publishYear || '') ||
          (a.title || '').localeCompare(b.title || '', 'ko'),
      );
      for (const m of items) {
        const by = BY_LABEL[m.classification?.by ?? ''] ?? m.classification?.by ?? '-';
        lines.push(
          `[${m.registerNo}] ${m.publishYear || '----'} | ` +
          `${m.publisher || '(발행기관 없음)'} → ${m.classification?.verdict ?? '-'}(${by}) | ` +
          `"${m.title}"` +
          (m.matchedKeywords?.length ? ` | 키워드: ${m.matchedKeywords.join(', ')}` : ''),
        );
      }
      if (items.length === 0) lines.push('(없음)');
    }

    lines.push('');
    lines.push(bar);
    lines.push(` 끝 — 총 ${metas.length}건`);
    lines.push(bar);
    lines.push('');
    return lines.join('\n');
  }
}
