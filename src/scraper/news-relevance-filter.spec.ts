import { describe, expect, it } from 'vitest';
import { NewsRelevanceFilterService } from './news-relevance-filter.service';

const make = (values: Record<string, string> = {}) =>
  new NewsRelevanceFilterService({ get: (k: string) => values[k] } as any);

describe('NewsRelevanceFilterService', () => {
  it('한반도 앵커어가 있으면 수집한다', () => {
    const v = make().isRelevant({
      title: '남북 접경지역 파주서 대북전단 살포',
      content: '군 당국은 군사분계선 인근 동향을 주시하고 있다.',
      matchedKeywords: ['접경', '군사분계선'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('anchor-keep');
  });

  it('해외 국경 이슈 키워드가 동시에 확인되면 제외한다', () => {
    const v = make().isRelevant({
      title: '스페인-모로코 접경서 난민 수백명 월경 시도',
      content: '유럽연합은 세우타 국경 통제를 강화하기로 했다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(false);
    expect(v.by).toBe('rule-drop');
    expect(v.matched).toContain('스페인·모로코 국경');
  });

  it("'통제를 강화'의 강화는 접경 시군 앵커로 보지 않는다", () => {
    const v = make().isRelevant({
      title: '그리스, 국경 통제를 강화',
      content: '난민 유입이 늘자 대책을 내놨다.',
      matchedKeywords: ['접경'],
    });
    expect(v.by).toBe('rule-drop');
  });

  it('해외 국경 키워드가 있어도 한반도 앵커어가 있으면 수집한다', () => {
    const v = make().isRelevant({
      title: '통일부, 접경지역 정책 유럽 사례 참고',
      content: '독일 사례를 남북 접경지역 지원에 적용하는 방안을 검토한다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('anchor-keep');
  });

  it('애매한 국가(러시아·우크라)만 있으면 수집하되 확인 대상으로 표시한다', () => {
    const v = make().isRelevant({
      title: '러-우크라 접경지대 무인기 공습',
      content: '현지 당국이 피해 규모를 집계 중이다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('ambiguous-keep');
    expect(v.matched?.length).toBeGreaterThan(0);
  });

  it('이란·중국도 제외하지 않고 확인 대상으로만 표시한다', () => {
    for (const title of ['이란 접경 지역 긴장 고조', '중국 접경 무역 재개']) {
      const v = make().isRelevant({ title, content: '현지 매체 보도.' });
      expect(v.relevant).toBe(true);
      expect(v.by).toBe('ambiguous-keep');
    }
  });

  it('스페인과 우크라이나가 함께 있으면 규칙 제외가 우선이다', () => {
    const v = make().isRelevant({
      title: '스페인 접경 난민 급증…우크라이나 피란민도 유입',
      content: '유럽연합이 대책을 논의한다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(false);
    expect(v.by).toBe('rule-drop');
  });

  it('YNA_RELEVANCE_FILTER=false면 필터를 건너뛴다', () => {
    const v = make({ YNA_RELEVANCE_FILTER: 'false' }).isRelevant({
      title: '스페인-모로코 접경서 난민 월경',
      content: '유럽연합 국경 통제 강화',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('filter-off');
  });

  it('해외·애매 키워드가 없으면 기본 수집한다', () => {
    const v = make().isRelevant({
      title: 'DMZ 생태관광 프로그램 확대',
      content: '방문객 편의시설을 늘린다.',
      matchedKeywords: ['DMZ'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('default-keep');
  });
});
