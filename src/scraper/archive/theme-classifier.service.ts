import { Injectable, Logger } from '@nestjs/common';
import { GeminiAnalyzerService } from 'src/common/utils/geminiAnalyze/gemini-analyzer.service';

/**
 * DMZ 포털 자료마당 "주제분류(category)" 18종.
 * DB category 컬럼에 그대로 저장되므로 포털 내부기준 문자열과 100% 일치해야 한다.
 * 0번(접경지역)은 어디에도 안 걸릴 때의 기본값(fallback).
 */
export const ARCHIVE_THEMES = [
  '접경지역',
  'DMZ 생태(DMZ 일원 등)',
  'DMZ 관광',
  '영문논문',
  'DMZ 정치군사 (정전협정,군사분계)',
  'DMZ 평화적이용(평화지대조성, 평화의길)',
  'DMZ 인문 역사',
  '정부 지자체 진행 연구용역',
  '사례조사 학술 연구',
  'DMZ 자연 산림',
  'DMZ 법제도',
  'DMZ 예술 체육(전시 공연)',
  'DMZ 문화유산 유적 유해',
  'DMZ 세계생태평화공원(그린데탕트)',
  'DMZ 메타버스(공학)',
  'DMZ 기후 환경',
  '경제협력(철도,도로)',
  '기타',
] as const;
export type ArchiveTheme = (typeof ARCHIVE_THEMES)[number];

const THEME_SET = new Set<string>(ARCHIVE_THEMES);
/** 분류 실패·미매칭 시 기본 주제. 호출부(ingest·재분류)도 같은 값을 써야 하므로 export한다. */
export const ARCHIVE_THEME_FALLBACK: ArchiveTheme = '접경지역';
const FALLBACK = ARCHIVE_THEME_FALLBACK;
const BATCH = 25;

/**
 * 자료 제목(+발행기관)을 주제 18종 중 하나로 분류한다 (Gemini).
 * RISS는 초록이 없어 제목 기반으로 판정하며, 애매하면 '접경지역'으로 둔다.
 */
@Injectable()
export class ThemeClassifierService {
  private readonly logger = new Logger(ThemeClassifierService.name);

  constructor(private readonly gemini: GeminiAnalyzerService) {}

  /** 제목 배열 → 주제 배열 (같은 길이). 실패 배치는 접경지역 기본. */
  async classifyTitles(titles: string[]): Promise<string[]> {
    const out: string[] = new Array(titles.length).fill(FALLBACK);
    for (let s = 0; s < titles.length; s += BATCH) {
      const chunk = titles.slice(s, s + BATCH);
      try {
        const res = await this.classifyBatch(chunk);
        for (let i = 0; i < chunk.length; i++) out[s + i] = res[i] ?? FALLBACK;
      } catch (e) {
        this.logger.warn(
          `[theme] 배치(${s}~${s + chunk.length}) 분류 실패 → 접경지역 기본: ${(e as Error).message}`,
        );
      }
    }
    return out;
  }

  private async classifyBatch(titles: string[]): Promise<string[]> {
    const themeList = ARCHIVE_THEMES.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const items = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const prompt =
      `다음은 DMZ·접경지역 관련 자료(학술논문/학위논문/단행본)의 제목 목록이다.\n` +
      `각 제목을 아래 18개 "주제" 중 가장 적합한 **하나**로 분류하라.\n\n` +
      `[주제]\n${themeList}\n\n` +
      `[분류 지침]\n` +
      `- 먼저 아래 구체 주제 중 맞는 게 있으면 언어와 무관하게 그 주제를 우선한다.\n` +
      `- 영어(외국어) 제목이면서 아래 어떤 구체 DMZ 주제에도 뚜렷이 안 맞으면 "영문논문".\n` +
      `- 동식물·서식지·생물다양성·생태 → "DMZ 생태(DMZ 일원 등)".\n` +
      `- 산림·수목·식생·숲 → "DMZ 자연 산림", 기후·기상·탄소·온난화 → "DMZ 기후 환경".\n` +
      `- 관광·탐방·여행·둘레길 → "DMZ 관광".\n` +
      `- 정전협정·군사분계·안보·군사충돌·NLL → "DMZ 정치군사 (정전협정,군사분계)".\n` +
      `- 법·제도·조례·특별법·법제 → "DMZ 법제도".\n` +
      `- 평화지대·평화의길·평화적이용 → "DMZ 평화적이용(평화지대조성, 평화의길)".\n` +
      `- 세계생태평화공원·그린데탕트 → "DMZ 세계생태평화공원(그린데탕트)".\n` +
      `- 역사·문학·인문·기억·사상 → "DMZ 인문 역사".\n` +
      `- 문화재·유적·유해발굴·매장문화재 → "DMZ 문화유산 유적 유해".\n` +
      `- 전시·공연·예술·미술·음악·체육 → "DMZ 예술 체육(전시 공연)".\n` +
      `- VR·AR·메타버스·3D·로봇·공학·측량 → "DMZ 메타버스(공학)".\n` +
      `- 철도·도로·물류·경제협력 → "경제협력(철도,도로)".\n` +
      `- 정부·지자체 발주 연구용역 보고서 → "정부 지자체 진행 연구용역".\n` +
      `- 특정 지역/대상 사례조사 중심 학술연구 → "사례조사 학술 연구".\n` +
      `- 위 어디에도 안 맞고 접경지역(민통선·파주·철원·연천·고성·김포 등) 일반 주제면 "접경지역".\n` +
      `- 정말 아무 데도 안 맞으면 "기타".\n\n` +
      `[제목]\n${items}\n\n` +
      `각 제목의 주제를 주제 목록의 **문자열 그대로** 골라 JSON 배열로만 반환(다른 설명 금지):\n` +
      `[{"i":1,"theme":"..."}, {"i":2,"theme":"..."}, ...]`;

    const text = await this.gemini.askQuestion(prompt);
    const m = text?.match(/\[[\s\S]*\]/);
    if (!m) throw new Error(`JSON 응답 없음: ${text?.slice(0, 80)}`);

    const parsed = JSON.parse(m[0]) as { i: number; theme: string }[];
    const res: string[] = new Array(titles.length).fill(FALLBACK);
    for (const o of parsed) {
      const idx = Number(o.i) - 1;
      const th = String(o.theme ?? '').trim();
      if (idx >= 0 && idx < titles.length) {
        res[idx] = THEME_SET.has(th) ? th : FALLBACK;
      }
    }
    return res;
  }
}
