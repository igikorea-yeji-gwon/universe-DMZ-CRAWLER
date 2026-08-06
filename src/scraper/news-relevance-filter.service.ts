import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** 뉴스 기사 관련성 판정 결과 */
export interface NewsRelevanceVerdict {
  relevant: boolean;
  /**
   * anchor-keep    : 한반도 앵커어가 있어 관련 확정
   * rule-drop      : 해외 국경 이슈 키워드 동시 확인 → 제외
   * ambiguous-keep : 러시아·우크라·이란처럼 애매한 국가만 확인됨 → 수집(표시만)
   * default-keep   : 어느 규칙에도 걸리지 않아 수집
   * filter-off     : 필터 비활성화 상태
   */
  by:
    | 'anchor-keep'
    | 'rule-drop'
    | 'ambiguous-keep'
    | 'default-keep'
    | 'filter-off';
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
 * 한반도 앵커어 — 하나라도 있으면 해외 국경 기사가 아니라고 보고 수집 확정.
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

/**
 * 연합뉴스 등 뉴스 수집의 DMZ 관련성 필터 (키워드 규칙 기반, LLM 미사용).
 *
 * ① 한반도 앵커어 있으면 수집 확정
 * ② 해외 국경 이슈 키워드 동시 확인 → 제외
 * ③ 애매한 국가(러시아·우크라·이란 등)만 있으면 수집 — 표시만 남김
 * ④ 어디에도 안 걸리면 수집
 *
 * 제외 건은 `[yna-relevance] DROP` 로그로 남긴다 (일 1회 수동 모니터링용).
 */
@Injectable()
export class NewsRelevanceFilterService {
  constructor(private readonly configService: ConfigService) {}

  /** 필터 사용 여부 (기본 ON, YNA_RELEVANCE_FILTER=false 로 끌 수 있음) */
  private get filterEnabled(): boolean {
    return (
      String(this.configService.get('YNA_RELEVANCE_FILTER') ?? 'true') !==
      'false'
    );
  }

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

    // ③ 애매한 국가 → 수집하되 표시 (제외 판단은 수동 모니터링에서)
    const ambiguous = AMBIGUOUS_TERMS.map((re) => text.match(re)?.[0] ?? '')
      .filter(Boolean);
    if (ambiguous.length > 0) {
      return {
        relevant: true,
        by: 'ambiguous-keep',
        reason: `판단 애매(${ambiguous.join(', ')}) — 수집 후 수동 확인 대상`,
        matched: ambiguous,
      };
    }

    // ④ 기본 수집
    return { relevant: true, by: 'default-keep' };
  }
}
