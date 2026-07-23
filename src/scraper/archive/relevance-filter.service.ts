import { Injectable, Logger } from '@nestjs/common';
import { S3Service } from 'src/aws/s3/s3.service';
import { GeminiAnalyzerService } from 'src/common/utils/geminiAnalyze/gemini-analyzer.service';
import { ArchiveItem } from './archive.types';

/** DMZ 관련성 판정 결과 */
export interface RelevanceVerdict {
  relevant: boolean;
  by: 'rule-drop' | 'rule-keep' | 'cache' | 'llm' | 'llm-error-keep';
  reason?: string;
}

const CACHE_S3_KEY = 'archive-crawler/classifier-cache/relevance-cache.json';

/**
 * 명백한 노이즈를 잡는 DROP 규칙 (제목/맥락 기준).
 * 여기 걸리면 LLM 없이 즉시 무관 판정 — "한반도 DMZ·접경"과 무관한 오매칭 유형들.
 */
const DROP_PATTERNS: { re: RegExp; reason: string }[] = [
  // MDL 오매칭 — IT/과학/의학 용어
  { re: /minimum description length/i, reason: 'MDL=Minimum Description Length' },
  { re: /\bScience\s*DMZ\b/i, reason: 'Science DMZ(네트워크 용어)' },
  // 합성어 오매칭 (직접경구, 간접경계적분 등 '접경'이 단어 중간에 낀 경우)
  { re: /직접\s*경구|간접\s*경계|경계적분|직접경\b/, reason: '접경 합성어 오매칭' },
  // 해외 정전·분쟁
  { re: /장고봉|하산호|미얀마|아르메니아|아제르바이잔|키프로스|카슈미르/, reason: '해외 정전·분쟁' },
  // 한반도 밖 접경 (북중/북중러/만주/간도/연변 등)
  { re: /북[·\-\s]*중[·\-\s]*(러|국경|접경)|압록강|두만강|백두산|만주|간도|연변|요동|요서|요녕|길림|동북\s*3?성|중[·\-\s]*조\s*국경/, reason: '한반도 밖 접경(북중/만주 등)' },
  { re: /몽골|장성|만리장성/, reason: '한반도 밖 지역' },
  // 역사·해외 국경
  { re: /고려\s*(시대|말|초|전기|후기|시기)|조선\s*(전기|후기|시대)\s*국경|동서독|서독|동독|로마\s*제국|페르시아|합스부르크/, reason: '역사·해외 국경' },
  // 비유·학술 개념
  { re: /contact\s*zone/i, reason: 'Contact Zone(학술 개념)' },
];

/**
 * KEEP 규칙 — 한반도 DMZ 핵심어가 제목에 있으면 LLM 없이 관련 확정.
 * (DROP 규칙을 통과한 뒤 평가 — 노이즈부터 걸러야 오탐 없음)
 */
const KEEP_PATTERNS: RegExp[] = [
  /비무장지대|디엠지|군사분계선|민통선|민간인\s*통제|정전협정|군사정전위|유엔사|판문점|공동경비구역|JSA/i,
  /파주|연천|철원|고성|양구|인제|화천|김포|강화(?!도조약)/, // 남북 접경 시군
];

/**
 * DMZ(한반도 비무장지대·접경) 관련성 필터.
 * 규칙(DROP/KEEP) 우선 → 애매하면 Gemini LLM 폴백 → 판정 캐시(S3 + in-memory).
 * classify(기관분류)와 동일한 하이브리드+캐시 패턴. 무관(false) 판정은 저장하지 않는다.
 */
@Injectable()
export class RelevanceFilterService {
  private readonly logger = new Logger(RelevanceFilterService.name);

  private cache = new Map<string, RelevanceVerdict>();
  private cacheLoaded: Promise<void> | null = null;
  private cacheDirty = false;

  constructor(
    private readonly s3Service: S3Service,
    private readonly gemini: GeminiAnalyzerService,
  ) {}

  async isRelevant(item: ArchiveItem): Promise<RelevanceVerdict> {
    const title = String(item.title ?? '').trim();

    // ① 명백한 노이즈 DROP (제목 기준)
    for (const { re, reason } of DROP_PATTERNS) {
      if (re.test(title)) return { relevant: false, by: 'rule-drop', reason };
    }

    // ② 핵심어 KEEP
    if (KEEP_PATTERNS.some((re) => re.test(title))) {
      return { relevant: true, by: 'rule-keep' };
    }

    // ③ 캐시 (제목+발행기관 단위 — 애매한 건만 캐시 대상)
    const key = `${title}|${String(item.publisher ?? '').trim()}`;
    await this.ensureCacheLoaded();
    const cached = this.cache.get(key);
    if (cached) return { ...cached, by: 'cache' };

    // ④ Gemini 폴백
    const decided = await this.classifyByLlm(item);
    this.cache.set(key, decided);
    this.cacheDirty = true;
    return decided;
  }

  private async classifyByLlm(item: ArchiveItem): Promise<RelevanceVerdict> {
    const prompt =
      `다음 학술자료가 "한반도 DMZ(비무장지대)·군사분계선·민간인통제선, 또는 남북 접경지역` +
      `(경기·강원 북부 접경 시군), 한반도 정전체제(정전협정·유엔사·군사정전위)"와 실질적으로 관련되는지 판정하라.\n` +
      `아래는 키워드만 우연히 걸린 무관(DROP) 유형이다:\n` +
      `- MDL이 다른 뜻(Minimum Description Length, 약품·화학물질명 등 IT/과학/의학 용어)\n` +
      `- Science DMZ(네트워크), 직접경/간접경계 등 합성어 오매칭\n` +
      `- 해외 정전·분쟁(장고봉사건, 미얀마, 아르메니아-아제르바이잔 등)\n` +
      `- 한반도 밖 접경(북중/북중러 접경, 압록강·두만강·백두산, 만주·간도·연변, 몽골, 중국 동북)\n` +
      `- 역사·해외 국경(고려·조선시대 국경, 유럽·동서독·대만·키프로스 등)\n` +
      `- 비유·학술 개념(Contact Zone, 문학적 "접경" 은유)\n` +
      `- 주제 자체가 무관(시집, 의학·화학 논문, 부동산 법규 등)\n\n` +
      `제목: ${item.title}\n` +
      `발행기관: ${item.publisher || '-'}\n` +
      `저자: ${item.author || '-'}\n` +
      `매칭 키워드: ${item.matchedKeyword}\n\n` +
      `다른 설명 없이 JSON만 반환: {"relevant": true|false, "reason": "간단한 근거"}`;

    try {
      const text = await this.gemini.askQuestion(prompt);
      const jsonMatch = text?.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`JSON 응답 없음: ${text?.slice(0, 80)}`);
      const parsed = JSON.parse(jsonMatch[0]);
      const relevant = parsed.relevant === true;
      const reason = String(parsed.reason ?? '').slice(0, 120);
      this.logger.log(
        `[relevance] LLM 판정: ${relevant ? 'KEEP' : 'DROP'} "${item.title}" — ${reason}`,
      );
      return { relevant, by: 'llm', reason };
    } catch (e) {
      // LLM 불가·오류 시 보수적으로 KEEP — 관련 자료를 실수로 버리지 않도록
      this.logger.warn(
        `[relevance] LLM 실패 → KEEP(보수) "${item.title}": ${(e as Error).message}`,
      );
      return { relevant: true, by: 'llm-error-keep' };
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
          this.cache.set(k, v as RelevanceVerdict);
        }
        this.logger.log(`[relevance] 판정 캐시 로드: ${this.cache.size}건`);
      }
    } catch (e) {
      this.logger.warn(`[relevance] 캐시 로드 실패(무시): ${(e as Error).message}`);
    }
  }

  async flushCache(): Promise<void> {
    if (!this.cacheDirty) return;
    try {
      await this.s3Service.putJson(CACHE_S3_KEY, Object.fromEntries(this.cache));
      this.cacheDirty = false;
      this.logger.log(`[relevance] 판정 캐시 저장: ${this.cache.size}건`);
    } catch (e) {
      this.logger.warn(`[relevance] 캐시 저장 실패(무시): ${(e as Error).message}`);
    }
  }
}
