import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiAnalyzerService } from 'src/common/utils/geminiAnalyze/gemini-analyzer.service';

/** 뉴스 기사 관련성 판정 결과 */
export interface NewsRelevanceVerdict {
  relevant: boolean;
  /**
   * anchor-keep : 한반도 앵커어가 있어 즉시 관련 확정 (LLM 미호출)
   * rule-drop   : 해외 국경 이슈 키워드 동시 확인 → 규칙으로 즉시 제외 (LLM 미호출)
   * llm         : 애매한 국가(러시아·우크라이나·이란 등) → LLM 판정
   * llm-off     : LLM 비활성화 상태라 보수적으로 수집
   * llm-error-keep : LLM 오류 → 보수적으로 수집
   * default-keep: 어느 규칙에도 걸리지 않아 수집
   */
  by:
    | 'anchor-keep'
    | 'rule-drop'
    | 'llm'
    | 'llm-off'
    | 'llm-error-keep'
    | 'default-keep';
  reason?: string;
  /** 판정 근거가 된 매칭 토큰 (모니터링용) */
  matched?: string[];
}

export interface NewsRelevanceInput {
  title: string;
  content: string;
  matchedKeywords?: string[];
}

/**
 * 한반도 앵커어 — 하나라도 있으면 해외 국경 기사가 아니라고 보고 즉시 수집 확정.
 * (해외 국경/난민 기사에는 사실상 등장하지 않는 표현만 넣는다.
 *  '한국'처럼 해외 기사에도 섞일 수 있는 말은 제외)
 */
const KOREA_ANCHORS: RegExp[] = [
  // DMZ·정전체제 핵심어
  /비무장지대|디엠지|군사분계선|민통선|민간인\s*통제|민간인\s*출입|판문점|공동경비구역|대성동|9[·.]\s*19\s*(군사)?합의/,
  /유엔군사령부|유엔사|군사정전위/,
  // 남북 관계
  /남북|북한|한반도|대북|북측|남측|국군|우리\s*군|합참|합동참모본부|국방부|통일부/,
  // 접경 시군·지역 (경기·강원·인천 북부)
  // '강화'는 '통제를 강화' 같은 일반 동사와 겹치므로 지명 형태로만 인정한다
  /파주|연천|철원|양구|인제|화천|김포|옹진|백령|연평|임진강|한강\s*하구|서해\s*5도/,
  /강화군|강화읍|강화도(?!\s*조약)|인천\s*강화/,
  /경기도|강원도|강원특별자치도|인천시|인천광역시/,
];

/**
 * ① 규칙 즉시 제외 — 해외 국경/난민 이슈 고유 키워드.
 * 한반도 정세 기사에는 사실상 함께 등장하지 않는 지역·이슈만 넣는다.
 * (한반도 앵커어가 하나도 없을 때에만 적용)
 */
const FOREIGN_BORDER_TERMS: { re: RegExp; label: string }[] = [
  { re: /스페인|모로코|세우타|멜리야|지브롤터/, label: '스페인·모로코 국경' },
  { re: /유럽연합|EU\s*(집행위|정상회의|국경|이사회)|솅겐|프론텍스/i, label: '유럽연합 국경' },
  { re: /난민|망명\s*신청|이민자|밀입국|불법\s*월경|국경\s*장벽|분리\s*장벽/, label: '난민·이민 이슈' },
  { re: /멕시코|리오그란데|과테말라|온두라스|엘살바도르|베네수엘라|콜롬비아|아이티/, label: '중남미 국경' },
  { re: /폴란드|벨라루스|리투아니아|라트비아|에스토니아|핀란드|헝가리|세르비아|크로아티아|불가리아|루마니아/, label: '유럽 국경' },
  { re: /인도|파키스탄|방글라데시|카슈미르|아프가니스탄/, label: '남아시아 국경' },
  { re: /미얀마|캄보디아|라오스|말레이시아/, label: '동남아 국경' },
  { re: /아르메니아|아제르바이잔|나고르노|키프로스|조지아|압하지야/, label: '캅카스·키프로스 분쟁' },
  { re: /이스라엘|가자\s*지구|팔레스타인|레바논|시리아|요르단|골란/, label: '중동 국경·정전' },
  { re: /튀르키예|터키|그리스|쿠르드/, label: '튀르키예·그리스 국경' },
  { re: /콩고|르완다|수단|에티오피아|에리트레아|차드|니제르|말리|리비아|알제리|튀니지/, label: '아프리카 국경' },
];

/**
 * ② LLM 판정 대상 — 한반도 정세 기사에도 등장할 수 있어
 * 단순 포함 여부만으로는 제외할 수 없는 국가·지역.
 */
const AMBIGUOUS_TERMS: RegExp[] = [
  // 연합뉴스 제목은 '우크라 전쟁', '러-우크라 접경'처럼 축약형을 더 많이 쓴다
  /러시아|우크라|모스크바|크렘린|푸틴|젤렌스키|러[·\-]\s*우|북[·\-\s]*러/,
  /이란|테헤란|이라크|예멘|아프가니스탄/,
  /중국|북[·\-\s]*중|중[·\-\s]*조|압록강|두만강|백두산|만주|간도|연변|랴오닝|지린/,
  /몽골|카자흐스탄|우즈베키스탄|키르기스/,
  /대만|양안|남중국해|필리핀/,
  /인도네시아|아프리카|중동/,
];

/**
 * 연합뉴스 등 뉴스 수집의 DMZ 관련성 필터.
 *
 * ① 한반도 앵커어 있으면 즉시 수집 (LLM 미호출)
 * ② 해외 국경 이슈 키워드 동시 확인 → 규칙으로 즉시 제외 (LLM 미호출)
 * ③ 러시아·우크라이나·이란처럼 애매한 국가만 LLM 판정
 * ④ 어디에도 안 걸리면 보수적으로 수집
 *
 * LLM 판정은 100% 정확하지 않으므로 제외 건은 `[yna-relevance] DROP` 로그로 남긴다
 * (일 1회 수동 모니터링용). LLM 오류·비활성화 시에는 항상 수집(false negative 방지).
 */
@Injectable()
export class NewsRelevanceFilterService {
  private readonly logger = new Logger(NewsRelevanceFilterService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly gemini: GeminiAnalyzerService,
  ) {}

  /** 필터 자체 사용 여부 (기본 ON, YNA_RELEVANCE_FILTER=false 로 끌 수 있음) */
  private get filterEnabled(): boolean {
    return (
      String(this.configService.get('YNA_RELEVANCE_FILTER') ?? 'true') !==
      'false'
    );
  }

  /** LLM 폴백 사용 여부 (기본 ON, 끄면 애매한 건은 전부 수집) */
  private get llmEnabled(): boolean {
    return (
      String(this.configService.get('YNA_RELEVANCE_LLM') ?? 'true') !== 'false'
    );
  }

  async isRelevant(item: NewsRelevanceInput): Promise<NewsRelevanceVerdict> {
    if (!this.filterEnabled) {
      return { relevant: true, by: 'default-keep', reason: '필터 비활성화' };
    }

    const title = String(item.title ?? '');
    // 본문은 앞부분(리드)에 기사 주제가 드러나므로 과도한 토큰 사용을 막기 위해 잘라 쓴다
    const body = String(item.content ?? '').replace(/<br>/g, '\n');
    const text = `${title}\n${body}`;

    // ① 한반도 앵커어 → 즉시 수집
    if (KOREA_ANCHORS.some((re) => re.test(text))) {
      return { relevant: true, by: 'anchor-keep' };
    }

    // ② 해외 국경 이슈 키워드 → 규칙으로 즉시 제외
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

    // ③ 애매한 국가 → LLM 판정
    const ambiguous = AMBIGUOUS_TERMS.filter((re) => re.test(text))
      .map((re) => text.match(re)?.[0] ?? '')
      .filter(Boolean);
    if (ambiguous.length > 0) {
      if (!this.llmEnabled) {
        return {
          relevant: true,
          by: 'llm-off',
          reason: `애매(${ambiguous.join(', ')}) — LLM 비활성화로 수집`,
          matched: ambiguous,
        };
      }
      return this.classifyByLlm(item, ambiguous, body);
    }

    // ④ 기본 수집
    return { relevant: true, by: 'default-keep' };
  }

  private async classifyByLlm(
    item: NewsRelevanceInput,
    ambiguous: string[],
    body: string,
  ): Promise<NewsRelevanceVerdict> {
    const prompt =
      `다음 뉴스 기사가 "한반도 DMZ(비무장지대)·군사분계선·민간인통제선, 남북 접경지역(경기·강원·인천 북부 접경 시군), ` +
      `한반도 정전체제(정전협정·유엔사·군사정전위), 남북관계·북한 정세"와 실질적으로 관련되는지 판정하라.\n\n` +
      `[제외(무관) 유형]\n` +
      `- 해외 국경·난민 이슈 (스페인-모로코, 유럽연합 국경, 미국-멕시코 국경 등)\n` +
      `- 한반도와 무관한 해외 분쟁·정전 (러시아-우크라이나 접경 교전, 중동 휴전 등)\n` +
      `- 'DMZ/MDL/접경'이 다른 뜻으로 쓰인 경우 (네트워크 DMZ, 합성어 오매칭 등)\n\n` +
      `[포함(관련) 유형]\n` +
      `- 해외 국가가 등장해도 한반도 정세·북한·남북 접경이 기사 주제인 경우\n` +
      `  (예: 북러 군사협력, 북중 관계, 이란-북한 무기거래, 유엔사 회원국 동향)\n\n` +
      `제목: ${item.title}\n` +
      `본문: ${body.slice(0, 1200)}\n` +
      `매칭 키워드: ${(item.matchedKeywords ?? []).join(', ') || '-'}\n` +
      `판단이 필요한 국가/지역: ${ambiguous.join(', ')}\n\n` +
      `다른 설명 없이 JSON만 반환: {"relevant": true|false, "reason": "간단한 근거"}`;

    try {
      const text = await this.gemini.askQuestion(prompt);
      const jsonMatch = text?.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`JSON 응답 없음: ${text?.slice(0, 80)}`);
      const parsed = JSON.parse(jsonMatch[0]);
      const relevant = parsed.relevant === true;
      const reason = String(parsed.reason ?? '').slice(0, 150);
      return { relevant, by: 'llm', reason, matched: ambiguous };
    } catch (e) {
      // LLM 불가·오류 시 보수적으로 수집 — 관련 기사를 실수로 버리지 않도록
      this.logger.warn(
        `[yna-relevance] LLM 실패 → 수집(보수) "${item.title}": ${(e as Error).message}`,
      );
      return { relevant: true, by: 'llm-error-keep', matched: ambiguous };
    }
  }
}
