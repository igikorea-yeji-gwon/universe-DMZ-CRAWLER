import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { S3Service } from 'src/aws/s3/s3.service';
import { GeminiAnalyzerService } from 'src/common/utils/geminiAnalyze/gemini-analyzer.service';

/** 뉴스 기사 관련성 판정 결과 */
export interface NewsRelevanceVerdict {
  relevant: boolean;
  /**
   * anchor-keep    : 한반도 앵커어가 있어 규칙 단계 통과
   * rule-drop      : 해외 국경 이슈 키워드 동시 확인 → 제외 (LLM 호출 없음)
   * ambiguous-keep : 러시아·우크라·이란처럼 애매한 국가만 확인됨 → 규칙 단계 통과
   * default-keep   : 어느 규칙에도 걸리지 않아 규칙 단계 통과
   * filter-off     : 규칙 필터 비활성화 상태
   * llm-keep/-drop : LLM(Gemini)이 DMZ 관련/무관으로 최종 판정
   * llm-cache      : 같은 기사에 대한 이전 LLM 판정 재사용
   * llm-error-keep : LLM 호출 실패 → 보수적으로 수집
   * llm-off        : LLM 확인 비활성화(또는 API 키 미설정) → 규칙 판정만 사용
   */
  by:
    | 'anchor-keep'
    | 'rule-drop'
    | 'ambiguous-keep'
    | 'default-keep'
    | 'filter-off'
    | 'llm-keep'
    | 'llm-drop'
    | 'llm-cache'
    | 'llm-error-keep'
    | 'llm-off';
  reason?: string;
  /** 판정 근거가 된 매칭 토큰 (모니터링용) */
  matched?: string[];
  /** LLM 확인 전 규칙 단계 판정 — 모니터링용 (confirmRelevance에서만 채워진다) */
  ruleBy?: NewsRelevanceVerdict['by'];
}

export interface NewsRelevanceInput {
  title: string;
  content: string;
  matchedKeywords?: string[];
  /** 판정 캐시 키로 쓸 기사 식별자 (연합뉴스 guid 등). 없으면 제목+본문 해시를 쓴다 */
  key?: string;
}

/**
 * 한반도 앵커어 — 하나라도 있으면 해외 국경 기사가 아니라고 보고 수집 확정.
 * (해외 국경/난민 기사에는 사실상 등장하지 않는 표현만 넣는다.
 *  '한국'처럼 해외 기사에도 섞일 수 있는 말은 제외)
 */
const KOREA_ANCHORS: RegExp[] = [
  // DMZ·정전체제 핵심어
  /비무장지대|디엠지|군사분계선|민통선|민간인\s*통제|민간인\s*출입|판문점|공동경비구역|대성동|9[·.]\s*19\s*(군사)?합의/,
  /\bDMZ\b/i,
  /유엔군사령부|유엔사|군사정전위/,
  // 6·25 참전국(콜롬비아·튀르키예 등) 관련 기사를 해외 기사로 오인하지 않도록
  /6[·.]\s*25|한국\s*전쟁|유엔군\s*참전|참전\s*용사/,
  // 남북 관계
  /남북|북한|한반도|대북|북측|남측|국군|우리\s*군|합참|합동참모본부|국방부|통일부/,
  // 접경 시군·지역 (경기·강원·인천 북부)
  // '강화'는 '통제를 강화' 같은 일반 동사와 겹치므로 지명 형태로만 인정한다
  /파주|연천|철원|양구|인제|화천|김포|옹진|백령|연평|임진강|한강\s*하구|서해\s*5도/,
  /강화군|강화읍|강화도(?!\s*조약)|인천\s*강화/,
];

/**
 * 규칙 제외 — 해외 국경/난민 이슈 고유 키워드.
 * 실제로 반복 유입되는 유형만 좁게 유지한다. 나머지 해외 지역은 제외하지 않고
 * AMBIGUOUS_TERMS 로 내려 확인 대상 표시만 한다.
 * (한반도 앵커어가 하나도 없을 때에만 적용)
 */
const FOREIGN_BORDER_TERMS: { re: RegExp; label: string }[] = [
  { re: /스페인|모로코|세우타|멜리야|지브롤터/, label: '스페인·모로코 국경' },
  { re: /유럽연합|EU\s*(집행위|정상회의|국경|이사회)|솅겐|프론텍스/i, label: '유럽연합 국경' },
  { re: /난민|망명\s*신청|이민자|밀입국|불법\s*월경|국경\s*장벽|분리\s*장벽/, label: '난민·이민 이슈' },
  // '러시아'는 북러 협력 기사에도 나오므로 제외 대상이 아니고, 우크라이나 쪽만 잡는다
  { re: /우크라|젤렌스키|러\s*[·\-]\s*우/, label: '러시아-우크라이나 전선' },
];

/**
 * 애매한 국가·지역 — 한반도 정세 기사에도 등장할 수 있어 단순 포함 여부로는 제외할 수 없다.
 * 제외하지 않고 수집하되, 수동 모니터링에서 알아볼 수 있게 표시만 남긴다.
 */
const AMBIGUOUS_TERMS: RegExp[] = [
  /러시아|모스크바|크렘린|푸틴|북[·\-\s]*러/,
  /이란|테헤란|이라크|예멘|이스라엘|가자\s*지구|팔레스타인|레바논|시리아|골란\s*고원/,
  /중국|북[·\-\s]*중|중[·\-\s]*조|압록강|두만강|백두산|만주|간도|연변|랴오닝|지린/,
  /몽골|카자흐스탄|우즈베키스탄|키르기스/,
  /대만|양안|남중국해|필리핀/,
  // 아래는 제외(②)에서 내린 지역들 — 버리지 않고 확인 대상으로만 표시한다
  /멕시코|리오그란데|과테말라|온두라스|베네수엘라|콜롬비아|아이티/,
  /폴란드|벨라루스|리투아니아|라트비아|에스토니아|핀란드|헝가리|세르비아|불가리아|루마니아/,
  // '인도'는 인도적 지원·보행자 인도와 겹치므로 국가로 읽히는 형태만 인정
  /파키스탄|방글라데시|카슈미르|아프가니스탄|인도[·\-]파|인도\s*(정부|군|총리|당국|북부|국경)/,
  /미얀마|캄보디아|라오스|말레이시아/,
  // '조지아'는 조지아주·조지아 커피와 겹치므로 국가 형태만 인정
  /아르메니아|아제르바이잔|나고르노|키프로스|압하지야|조지아\s*(공화국|정부|국경)/,
  /튀르키예|터키|그리스|쿠르드/,
  // '수단'(手段)·'말리'(말리다)는 일반어와 겹치므로 국가 형태만 인정
  /콩고|르완다|에티오피아|에리트레아|리비아|알제리|튀니지|남수단|수단\s*(공화국|정부|내전|군|반군)|말리\s*(공화국|정부|내전|반군|북부)/,
];

/** LLM 최종 확인 판정 캐시 (S3 영속화) */
const CACHE_S3_KEY = 'news-crawler/classifier-cache/yna-relevance-cache.json';

/** 캐시 보존 기간 — 피드에서 내려간 기사 판정은 재사용할 일이 없어 정리한다 */
const CACHE_TTL_DAYS = 30;

/** 본문은 앞부분만 보내도 주제 판단에 충분하다 (토큰 절약) */
const LLM_CONTENT_CHARS = 2000;

/** 주무관 확정 프롬프트 — DMZ 관련 기사 확인 (수정 시 이 상수만 고치면 된다) */
const DMZ_RELEVANCE_PROMPT = `당신은 뉴스 기사 분류기입니다.
아래 기사가 "대한민국의 DMZ(비무장지대) 또는 접경지역"과 실질적으로 관련이 있는지 판단하세요.

[관련 있음으로 판단하는 기준]
다음 중 하나 이상에 해당하면 관련 기사입니다.

1. 한반도 DMZ, 비무장지대, JSA, 판문점, 군사분계선(MDL)을 주제·배경·소재로 다루는 기사
2. 접경지역 지자체(파주, 연천, 철원, 화천, 양구, 인제, 고성, 김포, 강화, 옹진)의 이슈 중 DMZ·접경 특성과 관련된 내용 (안보, 남북관계, 생태·환경, 평화·통일, 관광·탐방, 지역개발, 문화유산 등)
3. DMZ 일원의 생태·환경·평화·안보·남북협력·문화·관광 관련 정책, 행사, 연구, 사건
4. 해외 비무장지대·완충지대·분단국 사례를 한반도 DMZ 또는 남북관계에 적용·비교·시사점 도출하는 관점으로 다룬 기사

[관련 없음으로 판단하는 기준]
다음에 해당하면 무관 기사입니다.

1. "DMZ"가 IT/네트워크 용어(방화벽 DMZ 존)로 쓰인 경우
2. "DMZ"가 게임·영화·상품명 등 고유명사로만 쓰인 경우
3. 접경지역 지자체가 언급되었지만 DMZ·접경 맥락과 무관한 일반 지역 뉴스(예: 파주의 일반 교통사고, 철원의 농산물 가격 등 지역 특성과 무관한 사건·사고·생활 뉴스)
4. 해외 비무장지대(키프로스, 베트남, 남중국해 등) 관련 기사이면서, 한반도 DMZ·접경지역과의 비교·연계·시사점·협력 등 연결고리가 없이 해외 사안만 단독으로 다루는 경우
5. 지명·키워드가 단순 스치듯 1~2회 언급될 뿐, 기사 본문의 주제가 다른 경우

[판단 절차]
1) 기사 제목과 본문에서 DMZ/접경지역이 "주제"인지 "단순 언급"인지 구분
2) IT·게임·해외 등 오탐 케이스인지 확인
3) 접경지자체 기사라면 그 지역의 접경적 특성과 연결되는지 확인
4) 해외 사례 기사라면, 한반도 DMZ/접경지역과의 연결고리(비교·시사점·협력·모델 적용 등)가 본문에 실제로 있는지 확인`;

/**
 * 연합뉴스 등 뉴스 수집의 DMZ 관련성 필터 — 키워드 규칙 + LLM(Gemini) 최종 확인.
 *
 * [규칙 단계 — isRelevant(), 동기·무비용]
 * ① 한반도 앵커어 있으면 통과
 * ② 해외 국경 이슈 키워드 동시 확인 → 제외 (LLM까지 갈 필요 없는 확정 노이즈)
 * ③ 애매한 국가(러시아·우크라·이란 등)만 있으면 통과 — 제외 판단은 LLM에 맡긴다
 * ④ 어디에도 안 걸리면 통과
 *
 * [LLM 단계 — confirmRelevance(), 최종 적재 판정]
 * 규칙을 통과한 기사만 Gemini에 보내 "DMZ·접경지역과 실질적으로 관련된 기사인지"를 확인한다.
 * 규칙만으로는 못 거르는 유형(파주의 일반 교통사고, 방화벽 DMZ, 스치듯 언급 등)을 여기서 제외한다.
 * 판정은 S3 캐시에 남겨 같은 기사를 5분마다 재판정하지 않는다(제외 기사는 S3 완료 마커가 없어
 * 피드에 남아 있는 동안 계속 후보로 올라오기 때문).
 *
 * 제외 건은 `[yna-relevance] DROP` 로그로 남긴다 (일 1회 수동 모니터링용).
 */
@Injectable()
export class NewsRelevanceFilterService {
  private readonly logger = new Logger(NewsRelevanceFilterService.name);

  private cache = new Map<string, { relevant: boolean; reason?: string; at: string }>();
  private cacheLoaded: Promise<void> | null = null;
  private cacheDirty = false;
  private noApiKeyWarned = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly s3Service: S3Service,
    private readonly gemini: GeminiAnalyzerService,
  ) {}

  /** 규칙 필터 사용 여부 (기본 ON, YNA_RELEVANCE_FILTER=false 로 끌 수 있음) */
  private get filterEnabled(): boolean {
    return (
      String(this.configService.get('YNA_RELEVANCE_FILTER') ?? 'true') !==
      'false'
    );
  }

  /** LLM 최종 확인 사용 여부 (기본 ON, YNA_LLM_RELEVANCE_FILTER=false 로 끌 수 있음) */
  private get llmEnabled(): boolean {
    return (
      String(this.configService.get('YNA_LLM_RELEVANCE_FILTER') ?? 'true') !==
      'false'
    );
  }

  /** 규칙 단계 판정 (동기·무비용) — LLM 확인 전 1차 필터 */
  isRelevant(item: NewsRelevanceInput): NewsRelevanceVerdict {
    if (!this.filterEnabled) {
      return { relevant: true, by: 'filter-off' };
    }

    const title = String(item.title ?? '');
    const body = String(item.content ?? '').replace(/<br>/g, '\n');
    const text = `${title}\n${body}`;

    // ① 한반도 앵커어 → 수집 확정
    if (KOREA_ANCHORS.some((re) => re.test(text))) {
      return { relevant: true, by: 'anchor-keep' };
    }

    // ② 해외 국경 이슈 키워드 → 제외
    const foreign = FOREIGN_BORDER_TERMS.filter(({ re }) => re.test(text)).map(
      ({ label }) => label,
    );
    if (foreign.length > 0) {
      return {
        relevant: false,
        by: 'rule-drop',
        reason: `해외 국경 이슈(${foreign.join(', ')}) — 한반도 앵커어 없음`,
        matched: foreign,
      };
    }

    // ③ 애매한 국가 → 규칙으로는 버리지 않는다 (제외 판단은 LLM 단계에서)
    const ambiguous = AMBIGUOUS_TERMS.map((re) => text.match(re)?.[0] ?? '')
      .filter(Boolean);
    if (ambiguous.length > 0) {
      return {
        relevant: true,
        by: 'ambiguous-keep',
        reason: `규칙 판단 애매(${ambiguous.join(', ')}) — LLM 확인 대상`,
        matched: ambiguous,
      };
    }

    // ④ 기본 수집
    return { relevant: true, by: 'default-keep' };
  }

  /**
   * 최종 적재 판정 — 규칙 통과 기사에 대해 LLM(Gemini)으로 DMZ 관련 여부를 확인한다.
   * 규칙에서 이미 제외된 기사는 LLM을 호출하지 않는다(확정 노이즈 + 토큰 절약).
   * LLM 호출이 불가하거나 실패하면 보수적으로 수집한다 — 관련 기사를 실수로 버리지 않기 위함.
   */
  async confirmRelevance(
    item: NewsRelevanceInput,
  ): Promise<NewsRelevanceVerdict> {
    const rule = this.isRelevant(item);
    const ruleBy = rule.by;

    // 규칙 제외 건 → LLM 확인 없이 그대로 제외
    if (!rule.relevant) return { ...rule, ruleBy };

    if (!this.llmEnabled) {
      return { ...rule, ruleBy };
    }

    if (!this.configService.get('GEMINI_API_KEY')) {
      if (!this.noApiKeyWarned) {
        this.noApiKeyWarned = true;
        this.logger.warn(
          '[yna-relevance] GEMINI_API_KEY 미설정 → LLM 최종 확인 생략, 규칙 판정만 사용',
        );
      }
      return {
        ...rule,
        by: 'llm-off',
        reason: 'GEMINI_API_KEY 미설정 — LLM 확인 생략',
        ruleBy,
      };
    }

    const key = this.cacheKey(item);
    await this.ensureCacheLoaded();
    const cached = this.cache.get(key);
    if (cached) {
      return {
        relevant: cached.relevant,
        by: 'llm-cache',
        reason: cached.reason,
        ruleBy,
      };
    }

    const decided = await this.classifyByLlm(item);
    // 실패 폴백(llm-error-keep)은 캐시하지 않는다 — 다음 회차에 다시 판정받도록
    if (decided.by !== 'llm-error-keep') {
      this.cache.set(key, {
        relevant: decided.relevant,
        reason: decided.reason,
        at: new Date().toISOString(),
      });
      this.cacheDirty = true;
    }
    return { ...decided, ruleBy };
  }

  private async classifyByLlm(
    item: NewsRelevanceInput,
  ): Promise<NewsRelevanceVerdict> {
    const title = String(item.title ?? '').trim();
    const body = String(item.content ?? '')
      .replace(/<br>/g, '\n')
      .slice(0, LLM_CONTENT_CHARS);

    const prompt =
      `${DMZ_RELEVANCE_PROMPT}\n\n` +
      `[기사]\n` +
      `제목: ${title}\n` +
      `매칭 키워드: ${(item.matchedKeywords ?? []).join(', ') || '-'}\n` +
      `본문:\n${body || '-'}\n\n` +
      `다른 설명 없이 JSON만 반환: {"relevant": true|false, "reason": "간단한 근거"}`;

    try {
      const text = await this.gemini.askQuestion(prompt);
      const jsonMatch = text?.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`JSON 응답 없음: ${text?.slice(0, 80)}`);
      const parsed = JSON.parse(jsonMatch[0]);

      // 명시적 false일 때만 제외 — 필드 누락 등 애매한 응답은 수집(보수)
      const raw = parsed.relevant;
      const relevant =
        typeof raw === 'string' ? raw.trim().toLowerCase() !== 'false' : raw !== false;
      const reason = String(parsed.reason ?? '').slice(0, 200);

      return {
        relevant,
        by: relevant ? 'llm-keep' : 'llm-drop',
        reason,
      };
    } catch (e) {
      this.logger.warn(
        `[yna-relevance] LLM 확인 실패 → KEEP(보수) "${title}": ${(e as Error).message}`,
      );
      return { relevant: true, by: 'llm-error-keep' };
    }
  }

  /** 판정 캐시 키 — 기사 식별자(guid) 우선, 없으면 제목+본문 해시 */
  private cacheKey(item: NewsRelevanceInput): string {
    const id = String(item.key ?? '').trim();
    if (id) return id;
    return createHash('md5')
      .update(`${item.title ?? ''}\n${item.content ?? ''}`)
      .digest('hex')
      .slice(0, 16);
  }

  // ─── 판정 캐시 (S3 영속화) ────────────────────────────────────────────────

  private ensureCacheLoaded(): Promise<void> {
    if (!this.cacheLoaded) this.cacheLoaded = this.loadCache();
    return this.cacheLoaded;
  }

  private async loadCache(): Promise<void> {
    try {
      const data = await this.s3Service.getJson(CACHE_S3_KEY);
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          this.cache.set(k, v as { relevant: boolean; reason?: string; at: string });
        }
        this.logger.log(`[yna-relevance] 판정 캐시 로드: ${this.cache.size}건`);
      }
    } catch (e) {
      this.logger.warn(
        `[yna-relevance] 캐시 로드 실패(무시): ${(e as Error).message}`,
      );
    }
  }

  /** 수집 회차 종료 시 호출 — 변경분이 있을 때만 저장하고, 오래된 판정은 정리한다 */
  async flushCache(): Promise<void> {
    if (!this.cacheDirty) return;
    try {
      const cutoff = Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
      for (const [k, v] of this.cache) {
        const at = Date.parse(v?.at ?? '');
        if (Number.isFinite(at) && at < cutoff) this.cache.delete(k);
      }
      await this.s3Service.putJson(CACHE_S3_KEY, Object.fromEntries(this.cache));
      this.cacheDirty = false;
      this.logger.log(`[yna-relevance] 판정 캐시 저장: ${this.cache.size}건`);
    } catch (e) {
      this.logger.warn(
        `[yna-relevance] 캐시 저장 실패(무시): ${(e as Error).message}`,
      );
    }
  }
}
