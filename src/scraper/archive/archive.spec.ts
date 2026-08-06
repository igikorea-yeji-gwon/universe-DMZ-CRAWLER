import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import { AcademicFilterService } from './academic-filter.service';
import { InstitutionClassifierService } from './institution-classifier.service';
import { RelevanceFilterService } from './relevance-filter.service';
import { KciCollectorService } from './kci-collector.service';
import { RissCollectorService } from './riss-collector.service';
import { NtisCollectorService } from './ntis-collector.service';
import { LosiCollectorService } from './losi-collector.service';
import { KistiCollectorService } from './kisti-collector.service';
import { EncykoreaCollectorService } from './encykorea-collector.service';
import { ArchiveExportService } from './archive-export.service';
import {
  ArchiveItem,
  toArray,
  stripTags,
  titleToS3Suffix,
  withRetry,
  sanitizeXmlAmp,
} from './archive.types';

// ─── 테스트 더블 ──────────────────────────────────────────────────────────────

const s3Stub = {
  getJson: vi.fn(async () => null),
  putJson: vi.fn(async () => undefined),
} as any;

const geminiStub = (reply: string) =>
  ({ askQuestion: vi.fn(async () => reply) }) as any;

function makeClassifier(geminiReply = '{"verdict":"GOV","confidence":0.9}') {
  return new InstitutionClassifierService(s3Stub, geminiStub(geminiReply));
}

// 컬렉터의 XML→ArchiveItem 매핑(private)만 검증 — 생성자 의존성은 사용하지 않으므로 스텁
function makeCollector<T>(ctor: new (...args: any[]) => T): T {
  return new ctor({} as any, {} as any, {} as any, {} as any);
}

const fixture = (name: string) =>
  fs.readFileSync(
    path.join(__dirname, '../../../configs/samples', name),
    'utf-8',
  );

// ─── 기관 분류기 ──────────────────────────────────────────────────────────────

describe('InstitutionClassifierService', () => {
  it.each([
    // [발행기관, 기대 verdict, 기대 경로]
    ['통일연구원', 'GOV', 'dict'],
    ['한국환경연구원', 'GOV', 'dict'],
    ['경기연구원', 'GOV', 'dict'],
    ['국립생태원', 'GOV', 'dict'],
    ['(재)강원연구원', 'GOV', 'dict'], // 법인격 접두어 제거 후 사전 매치
    ['국립수목원', 'GOV', 'dict'],
    ['강원도청', 'GOV', 'pattern'],
    ['파주시', 'GOV', 'pattern'],
    ['외교부', 'GOV', 'pattern'], // 사전에 없는 부처 — 패턴 매치
    ['병무청', 'GOV', 'pattern'],
    ['한국수목보호진흥원', 'GOV', 'pattern'], // 한국○○진흥원
    ['대한건축학회', 'PRIVATE', 'pattern'],
    ['한국조경학회', 'PRIVATE', 'pattern'],
    ['서울대학교 환경대학원', 'PRIVATE', 'pattern'],
    ['대진대학교 DMZ연구원', 'PRIVATE', 'dict'], // 대학 부설 — PRIVATE 사전(DMZ연구원) 우선
    ['통일평화연구원', 'PRIVATE', 'dict'], // 서울대 부설 — PRIVATE 사전
    ['경인문화사', 'PRIVATE', 'pattern'],
    ['대한불교조계종 총무원', 'PRIVATE', 'pattern'],
    ['한국DMZ평화생명동산', 'PRIVATE', 'pattern'],
    ['공공정책연구소', 'PRIVATE', 'pattern'], // ○○연구소 = 대학부설/민간 기본
    ['법학연구소', 'PRIVATE', 'pattern'],
    ['극지연구소', 'GOV', 'dict'], // 정부 소속 연구소는 사전이 먼저 매치
  ])('%s → %s (%s)', async (publisher, verdict, by) => {
    const classifier = makeClassifier();
    const result = await classifier.classify(publisher as string);
    expect(result.verdict).toBe(verdict);
    expect(result.by).toBe(by);
  });

  it('사전·패턴 미매칭 기관은 LLM 폴백으로 판정한다', async () => {
    const classifier = makeClassifier('{"verdict":"GOV","confidence":0.85}');
    const result = await classifier.classify('이상한이름기관');
    expect(result).toEqual({ verdict: 'GOV', by: 'llm' });
  });

  it('LLM 저신뢰(<0.6) 판정은 PRIVATE 기본값으로 처리한다', async () => {
    const classifier = makeClassifier('{"verdict":"GOV","confidence":0.3}');
    const result = await classifier.classify('알수없는연구모임');
    expect(result).toEqual({ verdict: 'PRIVATE', by: 'llm-lowconf' });
  });

  it('같은 기관은 캐시로 재판정 없이 반환한다', async () => {
    const gemini = geminiStub('{"verdict":"GOV","confidence":0.9}');
    const classifier = new InstitutionClassifierService(s3Stub, gemini);
    await classifier.classify('처음보는기관센터');
    const second = await classifier.classify('처음보는기관센터');
    expect(second.by).toBe('cache');
    expect(gemini.askQuestion).toHaveBeenCalledTimes(1);
  });

  it('빈 발행기관은 PRIVATE(default)', async () => {
    const classifier = makeClassifier();
    expect(await classifier.classify('')).toEqual({
      verdict: 'PRIVATE',
      by: 'default',
    });
  });
});

// ─── 학술자료 필터 ────────────────────────────────────────────────────────────

describe('AcademicFilterService', () => {
  // LLM이 불려야 할 경우를 구분하려고 gemini 스텁 호출 여부를 함께 본다
  function makeFilter(llmReply = '{"academic":false,"reason":"잡지 기사"}') {
    const gemini = geminiStub(llmReply);
    return { filter: new AcademicFilterService(s3Stub, gemini), gemini };
  }
  const item = (over: Partial<ArchiveItem>): ArchiveItem =>
    ({
      source: 'losi',
      sourceId: 'x',
      title: '제목',
      publisher: '한국조경학회',
      author: '홍길동',
      publishYear: '2024',
      category: null,
      subCategory: null,
      summary: null,
      detailUrl: null,
      isbn: null,
      materialType: 'article',
      matchedKeyword: 'DMZ',
      ...over,
    }) as ArchiveItem;

  it.each([
    // [설명, item, 기대 academic, 기대 by]
    ['언론사 발행처는 소스 불문 제외', { source: 'riss', publisher: '경향신문사' }, false, 'rule-publisher'],
    ['의원실 발행물 제외', { publisher: '한기호 의원실' }, false, 'rule-publisher'],
    ['사무처 발행물 제외', { publisher: '국회사무처 국회민원지원센터' }, false, 'rule-publisher'],
    ['EncyKorea는 면제', { source: 'encykorea', publisher: '한국학중앙연구원' }, true, 'rule-exempt'],
    ['단행본은 학술 여부 안 따짐', { materialType: 'book' }, true, 'rule-exempt'],
    ['플래그 신뢰 소스는 통과', { source: 'kci' }, true, 'source-flag'],
    ['NTIS 연구보고서 통과', { source: 'ntis', materialType: 'report' }, true, 'source-flag'],
    ['인터뷰 기사 제외', { title: '접경지 규제 사슬 끊고 :김성원 의원 [인터뷰]' }, false, 'rule-title'],
    ['좌담·칼럼 제외', { title: 'DMZ 평화 좌담회' }, false, 'rule-title'],
    ['학술지 수록은 통과', { subCategory: '한국환경생태학회지' }, true, 'rule-journal'],
    ['영문 저널명도 통과', { subCategory: 'Korean Journal of Ecology' }, true, 'rule-journal'],
  ])('%s', async (_desc, over, expected, by) => {
    const { filter, gemini } = makeFilter();
    const verdict = await filter.isAcademic(item(over as Partial<ArchiveItem>));
    expect(verdict.academic).toBe(expected);
    expect(verdict.by).toBe(by);
    // 규칙으로 결론난 건은 LLM을 부르지 않아야 한다 (비용/지연)
    expect(gemini.askQuestion).not.toHaveBeenCalled();
  });

  it('규칙에 안 걸리는 LOSI 건만 LLM으로 판정한다', async () => {
    const { filter, gemini } = makeFilter();
    const verdict = await filter.isAcademic(
      item({ title: '세계의 분열을 거부한다', subCategory: '주간경향' }),
    );
    expect(gemini.askQuestion).toHaveBeenCalledOnce();
    expect(verdict).toMatchObject({ academic: false, by: 'llm' });
  });

  it('LLM 실패 시 보수적으로 KEEP한다', async () => {
    const gemini = { askQuestion: vi.fn(async () => 'JSON 아님') } as any;
    const filter = new AcademicFilterService(s3Stub, gemini);
    const verdict = await filter.isAcademic(item({ title: '애매한 제목' }));
    expect(verdict).toMatchObject({ academic: true, by: 'llm-error-keep' });
  });
});

// ─── KCI 매핑 (실 응답 샘플 픽스처) ──────────────────────────────────────────

describe('KciCollectorService XML 매핑', () => {
  it('kci-sample.xml 레코드를 ArchiveItem으로 정규화한다', async () => {
    const collector = makeCollector(KciCollectorService) as any;
    const parsed = await parseStringPromise(fixture('kci-sample.xml'), {
      explicitArray: false,
    });
    const records = toArray<any>(parsed.MetaData.outputData.record);
    expect(records.length).toBeGreaterThan(0);

    const item = collector.toArchiveItem(records[0], 'DMZ');
    expect(item).toMatchObject({
      source: 'kci',
      sourceId: 'ART003027350',
      title: 'DMZ(Demilitarized Zone) 접경지역의 문화서비스 평가',
      publisher: '한국조경학회',
      publishYear: '2023',
      category: '조경학',
      subCategory: '한국조경학회지 51(6)',
      materialType: 'article',
      matchedKeyword: 'DMZ',
    });
    // API 제공 영문 필드
    expect(item.titleEn).toBe(
      'Cultural Services Assessment in DMZ(Demilitarized Zone) Border Areas',
    );
    expect(item.authorEn).toContain('Ko, Ha-jung');
    // 저자 소속 괄호 제거
    expect(item.author).toBe('고하정, 권혁수, 김정인');
    expect(item.summary).toContain('본 연구는 접경지역 문화서비스 평가');
    expect(item.detailUrl).toContain('artiId=ART003027350');
  });
});

// ─── LOSI 매핑 (실 응답 JSON 픽스처) ─────────────────────────────────────────

describe('LosiCollectorService JSON 매핑', () => {
  it('losi-sample.json 레코드를 ArchiveItem으로 정규화한다', () => {
    const collector = makeCollector(LosiCollectorService) as any;
    const data = JSON.parse(fixture('losi-sample.json'));
    const list = data.result[0].searchList;

    // ARTICLE: publisher 비어있음, 국문+로마자 저자 혼재 → 국문만
    const article = collector.toArchiveItem(list[0], 'article', 'DMZ');
    expect(article).toMatchObject({
      source: 'losi',
      sourceId: '8860089', // lodID
      publisher: '',
      publishYear: '2024',
      materialType: 'article',
      matchedKeyword: 'DMZ',
    });
    expect(article.author).toBe('이수광, 양재동, 이정희'); // 로마자(Sugwang Lee 등) 제외
    expect(article.summary).toBeNull(); // abstractCont 비어있음
    expect(article.category).toBeNull(); // 주제는 이후 태깅

    // BOOK: publisher(국립수목원) 존재
    const book = collector.toArchiveItem(list[1], 'book', 'DMZ');
    expect(book).toMatchObject({
      source: 'losi',
      sourceId: '499252',
      publisher: '국립수목원',
      materialType: 'book',
    });
  });
});

// ─── KISTI 매핑 (문서 구조 픽스처) ───────────────────────────────────────────

describe('KistiCollectorService XML 매핑', () => {
  it('kisti-sample.xml 레코드를 target/DBCode로 정규화한다', async () => {
    const collector = makeCollector(KistiCollectorService) as any;
    const parsed = await parseStringPromise(fixture('kisti-sample.xml'), {
      explicitArray: false,
    });
    const records = toArray<any>(parsed.MetaData.recordList.record);
    expect(records.length).toBe(3);

    // ARTI + JAKO → article, publisher 비면 JournalName 사용
    const arti = collector.toArchiveItem(records[0], 'ARTI', 'article', 'DMZ');
    expect(arti).toMatchObject({
      source: 'kisti',
      sourceId: 'JAKO202419076986999',
      publisher: '한국환경생태학회지', // Publisher 비어 JournalName 대체
      materialType: 'article',
      publishYear: '2024',
    });
    expect(arti.summary).toContain('식생을 분석');

    // REPORT + TRKO → report (NTIS와 겹치지만 스프링이 dedup)
    const report = collector.toArchiveItem(
      records[1],
      'REPORT',
      'report',
      '접경',
    );
    expect(report).toMatchObject({
      sourceId: 'TRKO201500002377',
      publisher: '통일연구원',
      materialType: 'report',
    });

    // ARTI + DIKO(DBCode) → thesis
    const thesis = collector.toArchiveItem(
      records[2],
      'ARTI',
      'article',
      'DMZ',
    );
    expect(thesis.materialType).toBe('thesis');
    expect(thesis.publisher).toBe('서울대학교 대학원');
  });
});

// ─── EncyKorea 매핑 (예상 JSON 구조 픽스처) ────────────────────────────────

describe('EncykoreaCollectorService JSON 매핑', () => {
  it('encykorea-sample.json 레코드를 ArchiveItem으로 정규화한다', () => {
    const collector = makeCollector(EncykoreaCollectorService) as any;
    const data = JSON.parse(fixture('encykorea-sample.json'));
    const rec = data.items[0];

    const item = collector.toArchiveItem(rec, '비무장지대');
    expect(item).toMatchObject({
      source: 'encykorea',
      sourceId: 'E0025142',
      title: '비무장지대',
      publisher: '한국학중앙연구원',
      author: '김창수',
      publishYear: '1995',
      category: '정치·법제',
      subCategory: '개념용어 / 군사',
      materialType: 'article',
      matchedKeyword: '비무장지대',
      detailUrl: 'https://encykorea.aks.ac.kr/Article/E0025142',
    });
    expect(item.summary).toContain('군사분계선을 기준으로');
    expect(item.isbn).toBeNull();
  });

  it('정의보다 내용요약(summary)을 summary로 우선 저장한다', () => {
    const collector = makeCollector(EncykoreaCollectorService) as any;
    const item = collector.toArchiveItem(
      {
        eid: 'E0080603',
        title: '서해 해상군사분계선',
        writer: '강석승',
        field: '정치·법제/국방',
        writeYear: '2024',
        definition: '짧은 정의값',
        summary: '내용요약에 해당하는 긴 설명값',
      },
      'DMZ',
    );

    expect(item.summary).toBe('내용요약에 해당하는 긴 설명값');
    expect(collector.needsDetail(item, { definition: '짧은 정의값' })).toBe(
      true,
    );
    expect(collector.needsDetail(item, { summary: item.summary })).toBe(false);
  });

  it('summary가 빈 문자열이면 definition을 fallback으로 사용한다', () => {
    const collector = makeCollector(EncykoreaCollectorService) as any;
    const item = collector.toArchiveItem(
      {
        eid: 'E0025142',
        title: '비무장지대',
        writer: '박진구',
        field: '정치·법제/국방',
        writeYear: '1995',
        summary: '',
        definition: '조약이나 협정에 의하여 무장이 금지된 완충지대.',
      },
      '비무장지대',
    );

    expect(item.summary).toBe('조약이나 협정에 의하여 무장이 금지된 완충지대.');
  });
});

// ─── RISS 매핑 (실 응답 샘플 픽스처) ─────────────────────────────────────────

describe('RissCollectorService XML 매핑', () => {
  it('riss-sample.xml metadata를 ArchiveItem으로 정규화한다', async () => {
    const collector = makeCollector(RissCollectorService) as any;
    const parsed = await parseStringPromise(fixture('riss-sample.xml'), {
      explicitArray: false,
    });
    expect(parsed.record.head.Error).toBe('0');
    const metadataList = toArray<any>(parsed.record.metadata);
    expect(metadataList.length).toBe(2);

    const item = collector.toArchiveItem(metadataList[1], 'article', '접경');
    expect(item).toMatchObject({
      source: 'riss',
      sourceId: 'A109157244', // url의 link?id= 파라미터
      title: 'DMZ 접경지역의 식물 Ⅴ (Flora of DMZ Ⅴ)',
      publisher: '국립수목원',
      publishYear: '2020',
      summary: null, // RISS는 초록 원문 미제공
      materialType: 'article',
    });
    // 저자 | 구분 → ', ' join
    expect(item.author).toContain('길희영, 정재상');
    // vol=0 → 권호 라벨 생략
    expect(item.subCategory).toBe('DMZ접경지역의 식물');
  });
});

// ─── NTIS 매핑 (매뉴얼 예시 기반 + 하이라이트 제거) ──────────────────────────

describe('NtisCollectorService HIT 매핑', () => {
  it('하이라이트 태그를 제거하고 다국어 필드를 정규화한다', () => {
    const collector = makeCollector(NtisCollectorService) as any;
    const hit = {
      TermSn: 'REP-2011-0115016243',
      PublicationYm: '201112',
      ResearchPublicNo: 'TRKO201300016082',
      PublicationAgency: '<span class="search_word">DMZ</span>평화연구원',
      ResultTitle: {
        Korean: '<span class="search_word">DMZ</span> 일원 생태조사 보고서',
        English: 'DMZ Ecological Survey Report',
      },
      Abstract: {
        Korean: '본 보고서는 <span class="search_word">DMZ</span> 일원…',
        English: '',
      },
      Keyword: { Korean: 'DMZ;접경지역;', English: 'DMZ;Border;' },
      Contents: '',
      DocUrl: 'https://nrms.kisti.re.kr/sc/pop.do?rpt_ctrl_no=RT1',
      Manager: '홍길동',
    };

    const item = collector.toArchiveItem(hit, 'DMZ');
    expect(item).toMatchObject({
      source: 'ntis',
      sourceId: 'TRKO201300016082',
      title: 'DMZ 일원 생태조사 보고서',
      publisher: 'DMZ평화연구원',
      author: '홍길동',
      publishYear: '2011',
      subCategory: 'DMZ, 접경지역',
      materialType: 'report',
      titleEn: 'DMZ Ecological Survey Report',
      summaryEn: null, // 빈 영문 초록은 null
    });
    expect(item.summary).not.toContain('<span');
  });

  it('HIT가 단일 객체여도 toArray로 배열 정규화된다', () => {
    const single = { a: 1 };
    expect(toArray(single)).toEqual([single]);
    expect(toArray([single, single])).toHaveLength(2);
    expect(toArray(undefined)).toEqual([]);
  });
});

// ─── Export DB-ready 변환 ─────────────────────────────────────────────────────

describe('ArchiveExportService toDbReady', () => {
  const configStub = {
    get: (key: string) =>
      ({
        RISS_ORIGIN_ID: '1',
        KCI_ORIGIN_ID: '2',
        NTIS_ORIGIN_ID: '3',
        ENCYKOREA_ORIGIN_ID: '6',
      })[key],
  } as any;

  it('meta.json을 archive 테이블 적재용 행으로 변환한다 (고정값·trslYn 포함)', () => {
    const service = new ArchiveExportService({} as any, configStub) as any;
    const meta = {
      source: 'kci',
      menuId: 'PAPERS',
      title: '제목',
      titleEn: 'Title',
      publisher: '한국조경학회',
      publishYear: '2023',
      author: '고하정',
      registerNo: 'KCI:ART003027350',
      linkUrl: 'https://example.com',
      remark: 'KCI OpenAPI 수집',
    };
    const row = service.toDbReady(
      2,
      'kci',
      meta,
      new Date('2026-07-16T03:00:00+09:00'),
    );

    expect(row).toMatchObject({
      originId: 2,
      dedupKey: 'KCI:ART003027350',
      menuId: 'PAPERS',
      useYn: 'Y',
      rgtrId: 'admin',
      hasFile: 'X',
      trslYn: 'Y',
      callNo: null,
      filePath: null,
    });
    expect(row.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('영문 필드가 없으면 trslYn=N', () => {
    const service = new ArchiveExportService({} as any, configStub) as any;
    const row = service.toDbReady(
      1,
      'riss',
      { title: 't', registerNo: 'RISS:A1' },
      null,
    );
    expect(row.trslYn).toBe('N');
    expect(row.collectedAt).toBeNull();
  });

  it('미등록 origin은 knownOrigin:false로 빈 결과 반환', async () => {
    const service = new ArchiveExportService({} as any, configStub);
    const res = await service.exportArchives(99);
    expect(res).toMatchObject({
      originId: 99,
      total: 0,
      knownOrigin: false,
      items: [],
    });
  });
});

// ─── 공통 유틸 ────────────────────────────────────────────────────────────────

describe('stripTags', () => {
  it('하이라이트 span과 중첩 태그를 제거하고 공백을 정리한다', () => {
    expect(
      stripTags('<span class="search_word">나노</span>융합산업  연구조합'),
    ).toBe('나노융합산업 연구조합');
    expect(stripTags(null)).toBe('');
    expect(stripTags(201112)).toBe('201112');
  });
});

describe('titleToS3Suffix', () => {
  it('S3 키 금지문자·공백을 _로 치환하고 길이를 제한한다', () => {
    expect(titleToS3Suffix('DMZ 접경지역의 문화서비스 평가')).toBe(
      'DMZ_접경지역의_문화서비스_평가',
    );
    expect(
      titleToS3Suffix('한반도 정전체제 하 "DMZ"의 평화적/국제법적 이용: 검토'),
    ).toBe('한반도_정전체제_하_DMZ_의_평화적_국제법적_이용_검토');
    // 40자 초과는 잘리고 끝의 _는 제거
    expect(titleToS3Suffix('가'.repeat(60)).length).toBeLessThanOrEqual(40);
    expect(titleToS3Suffix('')).toBe('');
  });
});

describe('withRetry', () => {
  it('실패하다 성공하면 그 값을 반환하고, 재시도 횟수만큼 onRetry가 호출된다', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('stream has been aborted');
        return 'ok';
      },
      onRetry,
      3,
      1, // 테스트에선 백오프 1ms
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('모든 시도가 실패하면 마지막 오류를 throw한다', async () => {
    const onRetry = vi.fn();
    await expect(
      withRetry(
        async () => {
          throw new Error('timeout');
        },
        onRetry,
        3,
        1,
      ),
    ).rejects.toThrow('timeout');
    expect(onRetry).toHaveBeenCalledTimes(2); // 마지막 시도 후에는 재시도 안 함
  });
});

describe('sanitizeXmlAmp', () => {
  it('이스케이프 안 된 &만 &amp;로 바꾸고 유효한 엔티티는 유지한다', async () => {
    expect(sanitizeXmlAmp('<T>국가R&D 보고서 & 계획</T>')).toBe(
      '<T>국가R&amp;D 보고서 &amp; 계획</T>',
    );
    expect(sanitizeXmlAmp('<T>A &amp; B &lt;C&gt; &#38; &#x26;</T>')).toBe(
      '<T>A &amp; B &lt;C&gt; &#38; &#x26;</T>',
    );
    // 치환 후엔 실제로 파싱 가능해야 한다 (NTIS 실패 케이스 재현)
    const parsed = await parseStringPromise(
      sanitizeXmlAmp(
        '<RESULT><HIT><ResultTitle><Korean>국가R&D와 DMZ</Korean></ResultTitle></HIT></RESULT>',
      ),
      { explicitArray: false },
    );
    expect(parsed.RESULT.HIT.ResultTitle.Korean).toBe('국가R&D와 DMZ');
  });
});

describe('RelevanceFilterService (규칙 판정)', () => {
  const svc = new RelevanceFilterService({} as any, {} as any);
  const item = (title: string, extra: any = {}) =>
    ({
      title,
      publisher: '',
      author: '',
      matchedKeyword: 'DMZ',
      source: 'riss',
      ...extra,
    }) as any;

  it('명백한 노이즈는 규칙으로 DROP (LLM 없이)', async () => {
    const cases: [string, string][] = [
      ['Science DMZ 네트워크 아키텍처 성능 분석', 'Science DMZ'],
      ['Minimum Description Length 기반 모델 선택', 'MDL'],
      ['북·중 접경지역 교역 연구', '북중 접경'],
      ['압록강 유역 생태 조사', '압록강'],
      ['간도 협약의 국제법적 검토', '간도'],
      ['고려시대 국경 방어체계 연구', '고려시대'],
      ['동서독 접경지역 통합 사례', '동서독'],
      ['미얀마 정전협정과 소수민족', '미얀마'],
      ['Contact Zone으로서의 문학 공간', 'Contact Zone'],
    ];
    for (const [title, label] of cases) {
      const v = await svc.isRelevant(item(title));
      expect(v.relevant, `${label}: "${title}"`).toBe(false);
      expect(v.by).toBe('rule-drop');
    }
  });

  it('한반도 DMZ 핵심어가 제목에 있으면 규칙으로 KEEP', async () => {
    for (const title of [
      'DMZ 비무장지대의 생태 가치',
      '군사분계선 일대 산림 조사',
      '파주 접경지역 관광 활성화 방안',
      '정전협정 체제와 유엔사의 역할',
    ]) {
      const v = await svc.isRelevant(item(title));
      expect(v.relevant, title).toBe(true);
      expect(v.by).toBe('rule-keep');
    }
  });
});
