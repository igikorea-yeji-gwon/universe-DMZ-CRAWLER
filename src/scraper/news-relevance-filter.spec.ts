import { describe, expect, it, vi } from 'vitest';
import { NewsRelevanceFilterService } from './news-relevance-filter.service';

const configStub = (values: Record<string, string> = {}) =>
  ({ get: (k: string) => values[k] }) as any;

/** askQuestion 호출 여부까지 확인하기 위해 vi.fn 노출 */
const geminiStub = (reply: string) => {
  const askQuestion = vi.fn(async () => reply);
  return { service: { askQuestion } as any, askQuestion };
};

const make = (reply = '{"relevant": false, "reason": "해외 분쟁"}') => {
  const g = geminiStub(reply);
  return {
    svc: new NewsRelevanceFilterService(configStub(), g.service),
    askQuestion: g.askQuestion,
  };
};

describe('NewsRelevanceFilterService', () => {
  it('한반도 앵커어가 있으면 LLM 없이 수집한다', async () => {
    const { svc, askQuestion } = make();
    const v = await svc.isRelevant({
      title: '남북 접경지역 파주서 대북전단 살포',
      content: '군 당국은 군사분계선 인근 동향을 주시하고 있다.',
      matchedKeywords: ['접경', '군사분계선'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('anchor-keep');
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it('해외 국경 이슈 키워드가 동시에 확인되면 규칙으로 제외한다 (LLM 미호출)', async () => {
    const { svc, askQuestion } = make();
    const v = await svc.isRelevant({
      title: '스페인-모로코 접경서 난민 수백명 월경 시도',
      content: '유럽연합은 세우타 국경 통제를 강화하기로 했다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(false);
    expect(v.by).toBe('rule-drop');
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it('해외 국경 키워드가 있어도 한반도 앵커어가 있으면 수집한다', async () => {
    const { svc } = make();
    const v = await svc.isRelevant({
      title: '통일부, 접경지역 정책 유럽 사례 참고',
      content: '독일 사례를 남북 접경지역 지원에 적용하는 방안을 검토한다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('anchor-keep');
  });

  it('러시아·우크라이나처럼 애매한 국가는 LLM으로 판정한다', async () => {
    const { svc, askQuestion } = make('{"relevant": false, "reason": "러-우 접경 교전"}');
    const v = await svc.isRelevant({
      title: '러시아군, 우크라이나 접경지대 포격 재개',
      content: '양측은 완충지대를 두고 대치 중이다.',
      matchedKeywords: ['접경'],
    });
    expect(askQuestion).toHaveBeenCalledOnce();
    expect(v.relevant).toBe(false);
    expect(v.by).toBe('llm');
  });

  it("축약형 '우크라'도 LLM 판정 대상이다", async () => {
    const { svc, askQuestion } = make('{"relevant": false, "reason": "러-우 접경"}');
    const v = await svc.isRelevant({
      title: '러-우크라 접경지대 무인기 공습',
      content: '현지 당국이 피해 규모를 집계 중이다.',
      matchedKeywords: ['접경'],
    });
    expect(askQuestion).toHaveBeenCalledOnce();
    expect(v.by).toBe('llm');
    expect(v.relevant).toBe(false);
  });

  it('스페인과 우크라이나가 함께 있으면 규칙 제외가 우선이라 LLM을 쓰지 않는다', async () => {
    const { svc, askQuestion } = make();
    const v = await svc.isRelevant({
      title: '스페인 접경 난민 급증…우크라이나 피란민도 유입',
      content: '유럽연합이 대책을 논의한다.',
      matchedKeywords: ['접경'],
    });
    expect(v.by).toBe('rule-drop');
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it('LLM이 관련 있다고 판정하면 수집한다', async () => {
    const { svc } = make('{"relevant": true, "reason": "북러 군사협력 관련"}');
    const v = await svc.isRelevant({
      title: '러시아, 접경 훈련에 신형 무기 투입',
      content: '군 소식통은 이란산 부품이 쓰였다고 전했다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('llm');
  });

  it('LLM 오류 시 보수적으로 수집한다', async () => {
    const gemini = {
      askQuestion: vi.fn(async () => {
        throw new Error('quota exceeded');
      }),
    } as any;
    const svc = new NewsRelevanceFilterService(configStub(), gemini);
    const v = await svc.isRelevant({
      title: '이란 접경 지역 긴장 고조',
      content: '현지 매체가 보도했다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('llm-error-keep');
  });

  it('YNA_RELEVANCE_LLM=false면 애매한 건도 LLM 없이 수집한다', async () => {
    const g = geminiStub('{"relevant": false}');
    const svc = new NewsRelevanceFilterService(
      configStub({ YNA_RELEVANCE_LLM: 'false' }),
      g.service,
    );
    const v = await svc.isRelevant({
      title: '이란 접경 지역 긴장 고조',
      content: '현지 매체가 보도했다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('llm-off');
    expect(g.askQuestion).not.toHaveBeenCalled();
  });

  it('YNA_RELEVANCE_FILTER=false면 필터를 건너뛴다', async () => {
    const g = geminiStub('{"relevant": false}');
    const svc = new NewsRelevanceFilterService(
      configStub({ YNA_RELEVANCE_FILTER: 'false' }),
      g.service,
    );
    const v = await svc.isRelevant({
      title: '스페인-모로코 접경서 난민 월경',
      content: '유럽연합 국경 통제 강화',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(true);
    expect(g.askQuestion).not.toHaveBeenCalled();
  });

  it('해외·애매 키워드가 없으면 기본 수집한다', async () => {
    const { svc, askQuestion } = make();
    const v = await svc.isRelevant({
      title: 'DMZ 생태관광 프로그램 확대',
      content: '방문객 편의시설을 늘린다.',
      matchedKeywords: ['DMZ'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('default-keep');
    expect(askQuestion).not.toHaveBeenCalled();
  });
});
