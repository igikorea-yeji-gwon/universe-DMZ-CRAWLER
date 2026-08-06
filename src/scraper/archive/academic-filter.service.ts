import { Injectable, Logger } from '@nestjs/common';
import { S3Service } from 'src/aws/s3/s3.service';
import { GeminiAnalyzerService } from 'src/common/utils/geminiAnalyze/gemini-analyzer.service';
import { NON_ACADEMIC_PUBLISHER_PATTERNS } from './gov-institutions.const';
import { ArchiveItem, ArchiveSource } from './archive.types';

/** 학술자료 여부 판정 결과 */
export interface AcademicVerdict {
  academic: boolean;
  by:
    | 'rule-publisher' // 발행처가 언론사·의원실·사무처 → 비학술 확정
    | 'rule-exempt' // 학술 여부를 따지지 않는 소스·자료유형
    | 'source-flag' // 검색 API가 자료종별을 보증하는 소스
    | 'rule-title' // 제목의 비학술 표지(인터뷰·칼럼 등)
    | 'rule-journal' // 수록지명이 학술지
    | 'cache'
    | 'llm'
    | 'llm-error-keep';
  reason?: string;
}

const CACHE_S3_KEY = 'archive-crawler/classifier-cache/academic-cache.json';

/**
 * 검색 API 자체가 학술자료만 색인해 자료종별 플래그를 신뢰할 수 있는 소스.
 * (RISS type A/T/U, KCI articleSearch=등재지 논문, NTIS rresearchpdf=국가R&D 보고서,
 *  KISTI DBCode=자료종별) → LLM 판정 없이 통과시킨다.
 */
const FLAG_TRUSTED_SOURCES: ReadonlySet<ArchiveSource> = new Set([
  'riss',
  'kci',
  'ntis',
  'kisti',
] as ArchiveSource[]);

/**
 * 학술자료 여부를 따지지 않는 소스.
 * EncyKorea(백과사전 표제어)는 학술자료는 아니지만 자료 축적 목적으로 수집하기로 한 소스다.
 */
const EXEMPT_SOURCES: ReadonlySet<ArchiveSource> = new Set([
  'encykorea',
] as ArchiveSource[]);

/** 제목에 드러난 비학술 표지 — 걸리면 LLM 없이 즉시 제외 (고정밀 패턴만) */
const NON_ACADEMIC_TITLE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /[[<(]\s*인터뷰\s*[\]>)]/, reason: '인터뷰 기사' },
  { re: /[[<(]\s*(화보|포토|르포)\s*[\]>)]/, reason: '잡지 화보·르포' },
  { re: /좌담회?|대담|취재기|칼럼|사설/, reason: '좌담·칼럼 등 비학술 기고' },
];

/** 수록지명이 학술지임이 뚜렷하면 LLM 없이 통과 (LOSI journal.title 등) */
const ACADEMIC_JOURNAL_PATTERNS: RegExp[] = [
  /학회지$|학회$|논총$|논집$|학보$|연구$|연구지$|저널$/,
  /journal/i,
];

/**
 * 학술자료(논문·학위논문·연구보고서) 여부 필터.
 *
 * 포털 자료마당의 논문/발간자료 분류는 둘 다 "논문인 경우"가 전제인데, 발행기관 분류만으로는
 * 그 전제를 확인할 수 없다(경향신문사 칼럼도 '민간 발행 → 논문'이 돼버린다). 이 필터가
 * 그 전제를 명시적으로 판정한다.
 *
 * 소스별 자료종별 플래그 신뢰도가 다르므로 신뢰 소스는 규칙으로 통과시키고,
 * 플래그가 부실한 소스(LOSI: searchRange=ARTICLE에 시사주간지·칼럼이 섞임)만 LLM으로 판정한다.
 * classify(기관분류)·isRelevant(관련성)와 동일한 하이브리드+캐시 패턴.
 */
@Injectable()
export class AcademicFilterService {
  private readonly logger = new Logger(AcademicFilterService.name);

  private cache = new Map<string, AcademicVerdict>();
  private cacheLoaded: Promise<void> | null = null;
  private cacheDirty = false;

  constructor(
    private readonly s3Service: S3Service,
    private readonly gemini: GeminiAnalyzerService,
  ) {}

  async isAcademic(item: ArchiveItem): Promise<AcademicVerdict> {
    const title = String(item.title ?? '').trim();
    const publisher = String(item.publisher ?? '').trim();
    const journal = String(item.subCategory ?? '').trim();

    // ① 발행처가 언론사·의원실·사무처면 자료유형·소스와 무관하게 비학술 확정.
    //    (전 소스 공통 — RISS에 실린 신문사 발행물도 동일하게 제외)
    if (NON_ACADEMIC_PUBLISHER_PATTERNS.some((p) => p.test(publisher))) {
      return {
        academic: false,
        by: 'rule-publisher',
        reason: `비학술 발행처: ${publisher}`,
      };
    }

    // ② 학술 여부를 따지지 않는 대상 — 면제 소스, 그리고 단행본(BOOKS 메뉴는 학술 여부 무관)
    if (EXEMPT_SOURCES.has(item.source)) {
      return { academic: true, by: 'rule-exempt', reason: '면제 소스' };
    }
    if (item.materialType === 'book') {
      return { academic: true, by: 'rule-exempt', reason: '단행본' };
    }

    // ③ 자료종별 플래그를 신뢰할 수 있는 소스는 그대로 통과 (LLM 비용 0)
    if (FLAG_TRUSTED_SOURCES.has(item.source)) {
      return { academic: true, by: 'source-flag' };
    }

    // ─── 이하 플래그를 못 믿는 소스(LOSI 등)만 해당 ───

    // ④ 제목의 비학술 표지
    for (const { re, reason } of NON_ACADEMIC_TITLE_PATTERNS) {
      if (re.test(title)) return { academic: false, by: 'rule-title', reason };
    }

    // ⑤ 수록지명이 학술지면 통과
    if (journal && ACADEMIC_JOURNAL_PATTERNS.some((re) => re.test(journal))) {
      return { academic: true, by: 'rule-journal', reason: journal };
    }

    // ⑥ 캐시 (제목+발행기관 단위 — 애매한 건만 캐시 대상)
    const key = `${title}|${publisher}`;
    await this.ensureCacheLoaded();
    const cached = this.cache.get(key);
    if (cached) return { ...cached, by: 'cache' };

    // ⑦ Gemini 폴백
    const decided = await this.classifyByLlm(item, journal);
    this.cache.set(key, decided);
    this.cacheDirty = true;
    return decided;
  }

  private async classifyByLlm(
    item: ArchiveItem,
    journal: string,
  ): Promise<AcademicVerdict> {
    const prompt =
      `다음 자료가 "학술자료"인지 판정하라.\n\n` +
      `[학술자료 = true]\n` +
      `- 학술지 게재 논문, 학위논문(석·박사), 연구보고서, 학술 단행본\n` +
      `- 학술대회 발표논문·심포지엄 자료집\n\n` +
      `[학술자료 아님 = false]\n` +
      `- 신문·시사주간지 기사, 칼럼, 사설, 인터뷰, 좌담, 르포, 화보\n` +
      `- 기관 홍보물, 보도자료, 소식지·회보, 사보\n` +
      `- 정책자료집·민원 안내, 행사 안내\n` +
      `- 백과사전 표제어, 단순 자료 목록\n\n` +
      `판단 근거는 수록지명(학술지면 논문, 잡지·주간지면 기사)과 제목의 성격이다.\n` +
      `애매하면 true(학술자료)로 둔다.\n\n` +
      `제목: ${item.title}\n` +
      `발행기관: ${item.publisher || '-'}\n` +
      `수록지명: ${journal || '-'}\n` +
      `저자: ${item.author || '-'}\n` +
      `발행년: ${item.publishYear || '-'}\n\n` +
      `다른 설명 없이 JSON만 반환: {"academic": true|false, "reason": "간단한 근거"}`;

    try {
      const text = await this.gemini.askQuestion(prompt);
      const jsonMatch = text?.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`JSON 응답 없음: ${text?.slice(0, 80)}`);
      const parsed = JSON.parse(jsonMatch[0]);
      // 명시적 false일 때만 제외 — 파싱 애매값은 통과(보수)
      const academic = parsed.academic !== false;
      const reason = String(parsed.reason ?? '').slice(0, 120);
      this.logger.log(
        `[academic] LLM 판정: ${academic ? 'KEEP' : 'DROP'} "${item.title}" — ${reason}`,
      );
      return { academic, by: 'llm', reason };
    } catch (e) {
      // LLM 불가·오류 시 보수적으로 KEEP — 학술자료를 실수로 버리지 않도록
      this.logger.warn(
        `[academic] LLM 실패 → KEEP(보수) "${item.title}": ${(e as Error).message}`,
      );
      return { academic: true, by: 'llm-error-keep' };
    }
  }

  // ─── 캐시 (S3 영속화) ─────────────────────────────────────────────────────

  private ensureCacheLoaded(): Promise<void> {
    if (!this.cacheLoaded) this.cacheLoaded = this.loadCache();
    return this.cacheLoaded;
  }

  private async loadCache(): Promise<void> {
    try {
      const data = await this.s3Service.getJson(CACHE_S3_KEY);
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          this.cache.set(k, v as AcademicVerdict);
        }
        this.logger.log(`[academic] 판정 캐시 로드: ${this.cache.size}건`);
      }
    } catch (e) {
      this.logger.warn(`[academic] 캐시 로드 실패(무시): ${(e as Error).message}`);
    }
  }

  async flushCache(): Promise<void> {
    if (!this.cacheDirty) return;
    try {
      await this.s3Service.putJson(CACHE_S3_KEY, Object.fromEntries(this.cache));
      this.cacheDirty = false;
      this.logger.log(`[academic] 판정 캐시 저장: ${this.cache.size}건`);
    } catch (e) {
      this.logger.warn(`[academic] 캐시 저장 실패(무시): ${(e as Error).message}`);
    }
  }
}
