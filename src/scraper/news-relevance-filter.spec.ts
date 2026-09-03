import { describe, expect, it, vi } from 'vitest';
import { NewsRelevanceFilterService } from './news-relevance-filter.service';

/** S3 캐시는 비활성(로드 null / 저장 무시) — 규칙·LLM 판정 자체만 검증한다 */
const stubS3 = () => ({
  getJson: vi.fn().mockResolvedValue(null),
  putJson: vi.fn().mockResolvedValue(undefined),
});

const make = (
  values: Record<string, string> = {},
  gemini: { askQuestion: any } = { askQuestion: vi.fn() },
  s3: any = stubS3(),
) =>
  new NewsRelevanceFilterService(
    { get: (k: string) => values[k] } as any,
    s3 as any,
    gemini as any,
  );

/** LLM 단계까지 태우려면 API 키가 있어야 한다 */
const LLM_ENV = { GEMINI_API_KEY: 'test-key' };

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

  it('6·25 참전국 관련 기사는 해외 기사로 오인하지 않는다', () => {
    const svc = make();
    for (const title of [
      '6·25 참전국 콜롬비아, DMZ 평화의 길 방문',
      '튀르키예 참전용사 유족, 판문점 견학',
    ]) {
      const v = svc.isRelevant({ title, content: '' });
      expect(v.relevant).toBe(true);
      expect(v.by).toBe('anchor-keep');
    }
  });

  it('콜롬비아 등 국가명만으로는 제외하지 않는다', () => {
    const v = make().isRelevant({
      title: '콜롬비아 접경 지역서 반군 충돌',
      content: '현지 매체 보도.',
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('ambiguous-keep');
  });

  it('우크라이나(축약형 포함)는 제외한다', () => {
    const svc = make();
    for (const title of [
      '러-우크라 접경지대 무인기 공습',
      '우크라이나 접경 지역 포격 재개',
      '젤렌스키, 접경 방어선 시찰',
    ]) {
      const v = svc.isRelevant({ title, content: '' });
      expect(v.relevant).toBe(false);
      expect(v.by).toBe('rule-drop');
    }
  });

  it('러시아 단독은 제외하지 않는다 (북러 협력 기사 보호)', () => {
    const v = make().isRelevant({
      title: '러시아, 접경 훈련에 신형 무기 투입',
      content: '현지 매체 보도.',
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('ambiguous-keep');
  });

  it('제외 목록에서 내린 지역은 수집하고 확인 대상으로만 표시한다', () => {
    const svc = make();
    for (const title of [
      '멕시코 접경 지역 단속 강화 조치',
      '미얀마 접경서 무력 충돌',
      '수단 내전 접경지 교전',
      '인도-파키스탄 접경 총격',
    ]) {
      const v = svc.isRelevant({ title, content: '' });
      expect(v.relevant).toBe(true);
      expect(v.by).toBe('ambiguous-keep');
    }
  });

  it('일반어와 겹치는 국가명(수단·인도·말리·조지아)은 오탐하지 않는다', () => {
    const svc = make();
    for (const title of [
      '접경지역 감시 수단 확대',
      '접경지 주민 인도적 지원 논의',
      'DMZ 인근 농작물 말리기 작업',
      '접경지 카페서 조지아 원두 판매',
    ]) {
      const v = svc.isRelevant({ title, content: '' });
      expect(v.relevant).toBe(true);
      expect(v.by).not.toBe('rule-drop');
    }
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

  it('우크라이나 기사도 한반도 앵커어가 있으면 수집한다', () => {
    const v = make().isRelevant({
      title: '북한군 우크라이나 전선 추가 파병 정황',
      content: '국방부는 관련 동향을 확인 중이라고 밝혔다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('anchor-keep');
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

  it('DMZ는 영문 표기도 앵커로 인정한다', () => {
    const v = make().isRelevant({
      title: 'DMZ 생태관광 프로그램 확대',
      content: '방문객 편의시설을 늘린다.',
      matchedKeywords: ['DMZ'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('anchor-keep');
  });

  it('해외·애매 키워드가 없으면 기본 수집한다', () => {
    const v = make().isRelevant({
      title: '접경지역 지원 조례 개정안 의결',
      content: '주민 편의시설 확충 예산이 포함됐다.',
      matchedKeywords: ['접경'],
    });
    expect(v.relevant).toBe(true);
    expect(v.by).toBe('default-keep');
  });
  // ─── LLM 최종 확인 (confirmRelevance) ──────────────────────────────────────

  describe('confirmRelevance (LLM 최종 확인)', () => {
    it('규칙 제외 건은 LLM을 호출하지 않고 그대로 제외한다', async () => {
      const gemini = { askQuestion: vi.fn() };
      const v = await make(LLM_ENV, gemini).confirmRelevance({
        title: '스페인-모로코 접경서 난민 수백명 월경 시도',
        content: '유럽연합은 세우타 국경 통제를 강화하기로 했다.',
        matchedKeywords: ['접경'],
      });
      expect(v.relevant).toBe(false);
      expect(v.by).toBe('rule-drop');
      expect(gemini.askQuestion).not.toHaveBeenCalled();
    });

    it('규칙은 통과했지만 LLM이 무관으로 보면 제외한다 (접경 지자체 일반 사건·사고)', async () => {
      const gemini = {
        askQuestion: vi.fn().mockResolvedValue(
          '{"relevant": false, "reason": "DMZ·접경 맥락과 무관한 지역 교통사고"}',
        ),
      };
      const v = await make(LLM_ENV, gemini).confirmRelevance({
        title: '파주서 승용차 전복…1명 경상',
        content: '경찰은 사고 경위를 조사 중이다.',
        matchedKeywords: ['접경'],
      });
      expect(v.relevant).toBe(false);
      expect(v.by).toBe('llm-drop');
      expect(v.ruleBy).toBe('anchor-keep'); // 규칙만으로는 못 걸렀을 건
      expect(gemini.askQuestion).toHaveBeenCalledTimes(1);
    });

    it('LLM이 관련으로 보면 수집한다', async () => {
      const gemini = {
        askQuestion: vi
          .fn()
          .mockResolvedValue('{"relevant": true, "reason": "DMZ 생태 정책 기사"}'),
      };
      const v = await make(LLM_ENV, gemini).confirmRelevance({
        title: 'DMZ 생태관광 프로그램 확대',
        content: '방문객 편의시설을 늘린다.',
        matchedKeywords: ['DMZ'],
      });
      expect(v.relevant).toBe(true);
      expect(v.by).toBe('llm-keep');
    });

    it('같은 기사는 캐시를 써서 LLM을 다시 부르지 않는다', async () => {
      const gemini = {
        askQuestion: vi
          .fn()
          .mockResolvedValue('{"relevant": false, "reason": "네트워크 용어"}'),
      };
      const svc = make(LLM_ENV, gemini);
      const input = {
        title: '방화벽 DMZ 구간 설정 오류로 서비스 장애',
        content: '보안장비 설정이 문제였다.',
        matchedKeywords: ['DMZ'],
        key: 'AKR20260101000000001',
      };
      const first = await svc.confirmRelevance(input);
      const second = await svc.confirmRelevance(input);
      expect(first.by).toBe('llm-drop');
      expect(second.by).toBe('llm-cache');
      expect(second.relevant).toBe(false);
      expect(gemini.askQuestion).toHaveBeenCalledTimes(1);
    });

    it('LLM 호출이 실패하면 보수적으로 수집한다', async () => {
      const gemini = {
        askQuestion: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')),
      };
      const v = await make(LLM_ENV, gemini).confirmRelevance({
        title: '접경지역 지원 조례 개정안 의결',
        content: '주민 편의시설 확충 예산이 포함됐다.',
        matchedKeywords: ['접경'],
      });
      expect(v.relevant).toBe(true);
      expect(v.by).toBe('llm-error-keep');
    });

    it('응답에 relevant 필드가 없으면 수집한다 (보수)', async () => {
      const gemini = {
        askQuestion: vi.fn().mockResolvedValue('{"reason": "판단 애매"}'),
      };
      const v = await make(LLM_ENV, gemini).confirmRelevance({
        title: '접경지역 주민 지원 사업 공고',
        content: '신청은 다음 달까지다.',
        matchedKeywords: ['접경'],
      });
      expect(v.relevant).toBe(true);
      expect(v.by).toBe('llm-keep');
    });

    it('YNA_LLM_RELEVANCE_FILTER=false면 규칙 판정만 쓴다', async () => {
      const gemini = { askQuestion: vi.fn() };
      const v = await make(
        { ...LLM_ENV, YNA_LLM_RELEVANCE_FILTER: 'false' },
        gemini,
      ).confirmRelevance({
        title: '파주서 승용차 전복…1명 경상',
        content: '경찰은 사고 경위를 조사 중이다.',
        matchedKeywords: ['접경'],
      });
      expect(v.relevant).toBe(true);
      expect(v.by).toBe('anchor-keep');
      expect(gemini.askQuestion).not.toHaveBeenCalled();
    });

    it('GEMINI_API_KEY가 없으면 LLM 확인을 생략한다', async () => {
      const gemini = { askQuestion: vi.fn() };
      const v = await make({}, gemini).confirmRelevance({
        title: 'DMZ 생태관광 프로그램 확대',
        content: '방문객 편의시설을 늘린다.',
        matchedKeywords: ['DMZ'],
      });
      expect(v.relevant).toBe(true);
      expect(v.by).toBe('llm-off');
      expect(gemini.askQuestion).not.toHaveBeenCalled();
    });

    it('프롬프트에 제목·본문·매칭 키워드를 함께 넘긴다', async () => {
      const gemini = {
        askQuestion: vi.fn().mockResolvedValue('{"relevant": true, "reason": "-"}'),
      };
      await make(LLM_ENV, gemini).confirmRelevance({
        title: 'DMZ 평화의 길 개방',
        content: '탐방 예약이 시작됐다.<br>파주 구간이 대상이다.',
        matchedKeywords: ['DMZ'],
      });
      const prompt = gemini.askQuestion.mock.calls[0][0] as string;
      expect(prompt).toContain('당신은 뉴스 기사 분류기입니다.');
      expect(prompt).toContain('DMZ 평화의 길 개방');
      expect(prompt).toContain('파주 구간이 대상이다.');
      expect(prompt).toContain('매칭 키워드: DMZ');
    });

    it('판정 캐시는 변경분이 있을 때만 S3에 저장한다', async () => {
      const s3 = stubS3();
      const gemini = {
        askQuestion: vi.fn().mockResolvedValue('{"relevant": true, "reason": "-"}'),
      };
      const svc = make(LLM_ENV, gemini, s3);

      await svc.flushCache();
      expect(s3.putJson).not.toHaveBeenCalled();

      await svc.confirmRelevance({
        title: 'DMZ 생태 조사 착수',
        content: '연구진이 현장을 조사한다.',
        matchedKeywords: ['DMZ'],
        key: 'AKR20260101000000002',
      });
      await svc.flushCache();
      expect(s3.putJson).toHaveBeenCalledTimes(1);

      await svc.flushCache();
      expect(s3.putJson).toHaveBeenCalledTimes(1); // 변경 없으면 재저장 안 함
    });
  });
});
