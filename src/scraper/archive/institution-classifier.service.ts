import { Injectable, Logger } from '@nestjs/common';
import { S3Service } from 'src/aws/s3/s3.service';
import { GeminiAnalyzerService } from 'src/common/utils/geminiAnalyze/gemini-analyzer.service';
import { InstitutionVerdict } from './archive.types';
import {
  GOV_INSTITUTIONS,
  GOV_PATTERNS,
  GOV_STRONG_PREFIX_PATTERNS,
  PRIVATE_INSTITUTIONS,
  PRIVATE_PATTERNS,
} from './gov-institutions.const';

/** S3에 영속화하는 판정 캐시 엔트리 */
interface CacheEntry extends InstitutionVerdict {
  decidedAt: string;
}

const CACHE_S3_KEY = 'archive-crawler/classifier-cache/publisher-cache.json';
const LLM_CONFIDENCE_MIN = 0.6;

/**
 * 발행기관이 정부·지자체·국책연구기관(GOV)인지 판별한다.
 * ①캐시 → ②GOV 사전 → ③PRIVATE 패턴 → ④GOV 패턴 → ⑤Gemini 폴백 → PRIVATE 기본.
 * LLM 판정은 발행기관명 단위로 캐시(S3 + in-memory)해 같은 기관을 두 번 묻지 않는다.
 */
@Injectable()
export class InstitutionClassifierService {
  private readonly logger = new Logger(InstitutionClassifierService.name);

  private cache = new Map<string, CacheEntry>();
  private cacheLoaded: Promise<void> | null = null;
  private cacheDirty = false;

  constructor(
    private readonly s3Service: S3Service,
    private readonly gemini: GeminiAnalyzerService,
  ) {}

  /**
   * 발행기관 분류. 빈 값이면 PRIVATE(default).
   * 사전·패턴(결정적 규칙)은 항상 먼저 평가하고, 캐시는 LLM 폴백 결과에만 쓴다 —
   * 사전/패턴을 코드에서 고치면 오래된 캐시가 이를 덮어쓰지 못하게 하기 위함.
   */
  async classify(publisher: string): Promise<InstitutionVerdict> {
    const name = this.normalize(publisher);
    if (!name) return { verdict: 'PRIVATE', by: 'default' };

    // ① PRIVATE 사전 — 대학 부설 연구소 등 패턴·LLM으로 오판되기 쉬운 기관 (가장 우선)
    for (const priv of PRIVATE_INSTITUTIONS) {
      if (name === priv || name.startsWith(`${priv} `) || name.endsWith(` ${priv}`)) {
        return { verdict: 'PRIVATE', by: 'dict' };
      }
    }

    // ② GOV 사전 — 정확 일치 또는 '기관명 + 부설조직' 형태(공백 구분 접두) 매치
    for (const gov of GOV_INSTITUTIONS) {
      if (name === gov || name.startsWith(`${gov} `)) {
        return { verdict: 'GOV', by: 'dict' };
      }
    }

    // ③ 정부 소속 강한 접두(국립·부처·청) — '국방부군사편찬연구소'가
    //    /연구소$/ PRIVATE 패턴에 잡히기 전에 GOV로 확정
    if (GOV_STRONG_PREFIX_PATTERNS.some((p) => p.test(name))) {
      return { verdict: 'GOV', by: 'pattern' };
    }

    // ④ PRIVATE 패턴 (대학원·학회·○○연구소 등이 GOV 패턴에 오인되지 않게 먼저)
    if (PRIVATE_PATTERNS.some((p) => p.test(name))) {
      return { verdict: 'PRIVATE', by: 'pattern' };
    }

    // ⑤ GOV 패턴
    if (GOV_PATTERNS.some((p) => p.test(name))) {
      return { verdict: 'GOV', by: 'pattern' };
    }

    // ⑥ LLM 캐시 (사전·패턴 미매칭 기관만 캐시 대상)
    await this.ensureCacheLoaded();
    const cached = this.cache.get(name);
    if (cached) return { verdict: cached.verdict, by: 'cache' };

    // ⑦ Gemini 폴백
    const decided = await this.classifyByLlm(name);
    this.cache.set(name, { ...decided, decidedAt: new Date().toISOString() });
    this.cacheDirty = true;
    return decided;
  }

  private async classifyByLlm(name: string): Promise<InstitutionVerdict> {
    const prompt =
      `다음 발행기관이 한국의 "정부기관·지방자치단체·국책연구기관(공공기관 포함)"인지 판정하라.\n` +
      `학회, 대학교(부설연구소 포함), 민간 기업·출판사·언론사·종교단체·순수 민간단체는 공공이 아니다.\n` +
      `발행기관: "${name}"\n` +
      `다른 설명 없이 JSON만 반환: {"verdict":"GOV"|"PRIVATE","confidence":0~1}`;

    try {
      const text = await this.gemini.askQuestion(prompt);
      const jsonMatch = text?.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`JSON 응답 없음: ${text?.slice(0, 80)}`);

      const parsed = JSON.parse(jsonMatch[0]);
      const verdict = parsed.verdict === 'GOV' ? 'GOV' : 'PRIVATE';
      const confidence = Number(parsed.confidence) || 0;

      if (confidence < LLM_CONFIDENCE_MIN) {
        this.logger.warn(
          `[classifier] LLM 저신뢰 판정(${confidence}) → PRIVATE 기본 적용: "${name}"`,
        );
        return { verdict: 'PRIVATE', by: 'llm-lowconf' };
      }
      this.logger.log(`[classifier] LLM 판정: "${name}" → ${verdict} (${confidence})`);
      return { verdict, by: 'llm' };
    } catch (e) {
      // LLM 불가(키 미설정·오류)면 보수적으로 PRIVATE — 발간자료 오염 방지
      this.logger.warn(
        `[classifier] LLM 폴백 실패 → PRIVATE 기본: "${name}" — ${(e as Error).message}`,
      );
      return { verdict: 'PRIVATE', by: 'default' };
    }
  }

  /** 법인격 접두어((재)·(사)·재단법인 등) 제거 + 공백 정리 */
  normalize(publisher: string): string {
    return String(publisher ?? '')
      .replace(/^\s*(\(재\)|\(사\)|\(사단\)|\(재단\)|재단법인|사단법인)\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ─── 캐시 (S3 영속화) ─────────────────────────────────────────────────────

  private ensureCacheLoaded(): Promise<void> {
    if (!this.cacheLoaded) {
      this.cacheLoaded = this.loadCache();
    }
    return this.cacheLoaded;
  }

  private async loadCache(): Promise<void> {
    try {
      const data = await this.s3Service.getJson(CACHE_S3_KEY);
      if (data && typeof data === 'object') {
        for (const [name, entry] of Object.entries(data)) {
          this.cache.set(name, entry as CacheEntry);
        }
        this.logger.log(`[classifier] 판정 캐시 로드: ${this.cache.size}건`);
      }
    } catch (e) {
      // 캐시는 최적화일 뿐 — 로드 실패해도 분류는 계속한다
      this.logger.warn(`[classifier] 캐시 로드 실패(무시): ${(e as Error).message}`);
    }
  }

  /** 수집 run 종료 시 호출 — 신규 판정이 있으면 S3에 저장 */
  async flushCache(): Promise<void> {
    if (!this.cacheDirty) return;
    try {
      await this.s3Service.putJson(CACHE_S3_KEY, Object.fromEntries(this.cache));
      this.cacheDirty = false;
      this.logger.log(`[classifier] 판정 캐시 저장: ${this.cache.size}건`);
    } catch (e) {
      this.logger.warn(`[classifier] 캐시 저장 실패(무시): ${(e as Error).message}`);
    }
  }
}
