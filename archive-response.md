# DMZ 아카이브 수집 소스 6종 — API 응답 필드 정리

| 소스 | 확인 상태 | 비고 |
|---|---|---|
| RISS | 실호출 확인 | |
| KCI | 실호출 확인 | |
| LOSI | 실호출 확인 | searchTotal(목록)만. searchView(상세)는 미발급 |
| NTIS | 픽스처 기준 | 등록 IP(EC2)에서만 호출 가능 |
| KISTI | 픽스처 기준 | 등록 MAC에서만 토큰 발급 — 실응답 미확인 |
| EncyKorea | 픽스처 기준 | |

---

## RISS (실호출 확인)

`GET http://www.riss.kr/openApi?key={KEY}&version=1.0&type=A&keyword=DMZ&rsnum=1&rowcount=100`

```
riss.type       A                   자료종별 A=국내학술논문 T=학위논문 U=단행본
riss.title      제목                 제목 (국문 + 괄호 안 영문 병기)
riss.author     최원혁               저자, 다수는 | 로 구분
riss.publisher  DMZ 연구원           발행기관
riss.pubdate    2012                발행년 (YYYY 또는 YYYY.MM)
riss.stitle     DMZ 연구             수록지명
riss.vol / no   3 / -               권 / 호 (없으면 0 또는 -)
riss.abstract   Y                   초록 보유 여부 (본문 미제공)
riss.toc        N                   목차 보유 여부 (본문 미제공)
riss.image      Y                   표지이미지 보유 여부
riss.charge     1                   유료 여부
url             link?id=A100112275  상세페이지 링크 (id값이 제어번호)
```

초록·목차·표지는 모두 Y/N 플래그이며 본문은 내려오지 않는다.

---

## KCI (실호출 확인)

`GET .../openApiSearch.kci?apiCode=articleSearch&key={KEY}&title=DMZ&page=1&displayCount=100`
displayCount는 10/20/50/100만 유효 (그 외 값은 서버가 10으로 폴백)

```
journal-name          한국조경학회지        수록 학술지명
publisher-name        한국조경학회          발행기관(학회)
pub-year / pub-mon    2023 / 12           발행년 / 발행월
volume / issue        51 / 6              권 / 호
article-id            ART003027350        논문 고유ID (속성)
article-categories    조경학               주제분류 (KCI 자체 분류)
article-regularity    Y                   등재지 여부
article-title[original]  제목              제목 원문
article-title[english]   Cultural Serv…   제목 영문
author                고하정(경희대학교)     저자 (소속 괄호 포함)
author@english        Ko, Ha-jung         저자 영문명 (속성)
abstract[original]    본 연구는…            초록 원문
abstract[english]     This study…         초록 영문
fpage / lpage         46 / 60             시작 / 끝 페이지
doi                   10.9715/KILA…       DOI
uci                                       UCI 식별자 (빈 값 많음)
citation-count        0 (@kci @wos)       인용 횟수
url                   …artiId=ART0030…    KCI 상세페이지
verified              Y                   검증 여부
```

6종 중 가장 풍부. 초록 국·영문, 저자 영문명, DOI, 인용횟수까지 제공.

---

## LOSI (실호출 확인)

`POST http://losi-api.nanet.go.kr/searchTotal` (form-urlencoded, JSON 응답)
파라미터: authKey, searchTerm, searchRange(ARTICLE/THESIS/BOOK), pageNo, printRowCnt

```
divFlag            ARTICLE            자료구분 ARTICLE/THESIS/BOOK
lodID              8860089            LOD 고유ID (sourceId로 사용)
title              제목                제목
pubYear            2024               발행년
authorList[].name  이수광              저자명 (국문·로마자 혼재)
authorList[].lodAuthorID  null        저자 LOD 식별자
publisher          ""                 발행기관 (ARTICLE은 빈 경우 많음)
journal            null               수록지 정보 (title 등)
keywordList[].name  economic impacts  주제어
keywordList[].lodKeywordID  1051388   주제어 LOD 식별자
url                click.ndsl.kr/…    상세페이지 (BOOK은 null 많음)
lodYn              N                  LOD 구축 여부
abstractCont       ""                 초록 (목록 API에선 항상 빈 값)
policyDataSeq      ""                 정책자료 일련번호
controlNum         JAKO2024190769…    제어번호
```

초록은 상세 API(searchView) 권한이 있어야 취득 가능 — 현재 키로는 인증 오류(code 300).
divFlag는 형태(낱개 글/책)만 알려주므로 학술성 판별에는 쓸 수 없다(시사주간지 기사도 ARTICLE).

---

## NTIS (픽스처 — 등록 IP에서만 호출 가능)

`GET .../rndopen/openApi/rresearchpdf?apprvKey={KEY}&collection=rresearchpdf&query=DMZ&searchField=BI&returnType=xml`

```
ResearchPublicNo    TRKO201300016082    보고서등록번호 (sourceId)
TermSn              REP-2011-0115016…   성과번호 (등록번호 없을 때 대체)
PublicationAgency   DMZ평화연구원         발행기관
PublicationYm       201112              발행년월
PublicationYear     2011                발행년
ResultTitle.Korean  DMZ 일원 생태조사…    제목 국문
ResultTitle.English DMZ Ecological…     제목 영문
Abstract.Korean     본 보고서는…          초록 국문
Abstract.English                        초록 영문
Keyword.Korean      DMZ;접경지역;         주제어 (; 구분)
Keyword.English     DMZ;Border;         주제어 영문
Contents                                목차
DocUrl              nrms.kisti.re.kr…   원문 상세 URL
Manager             홍길동               연구책임자
```

주의사항
- `Accept: application/xml` 헤더 필수 (axios 기본값이면 JSON으로 응답)
- 값에 검색어 하이라이트 `<span class="search_word">`가 섞여 오므로 태그 제거 필수
- 이스케이프 안 된 `&`(예: 국가R&D)가 섞여 와 XML 파싱 전 치환 필요

---

## KISTI (픽스처 — 등록 MAC에서만 토큰 발급, 실응답 미확인)

인증: 인증키(32자)를 AES256 키로 `{mac_address, datetime}` JSON을 암호화 → tokenrequest.do 로 access_token 발급

```
CN            JAKO202419076986999   고유식별자 (sourceId)
DBCode        JAKO                  자료종별 JAKO=논문 DIKO=학위 TRKO=보고서
Title                               제목
Author                              저자
Publisher                           발행기관 (비면 JournalName 대체)
JournalName                         수록지명
Pubyear                             발행년
Abstract      비무장지대 인근 식생을…   초록
Keyword                             주제어
ISSN                                ISSN
DOI                                 DOI
ContentURL                          상세페이지
TotalCount                          전체건수 (resultSummary 하위)
```

현재 MAC 미등록으로 토큰 발급이 안 돼 수집 이력 0건. `.env`의 `KISTI_MAC`으로 지정 가능.

---

## EncyKorea (픽스처)

`GET .../api/articles/search?q=DMZ&p=1&ps=100` (헤더 `X-API-Key`)

```
eid          E0025142              항목 고유ID
title        비무장지대              표제어
writer       김창수(한국학중앙연구원)  집필자 (소속 포함)
writeYear    1995                  집필년
field        정치·법제               분야
type         개념용어                유형
nature       군사                   성격
definition   군사분계선을 기준으로…    정의 (한 줄 요약)
url          encykorea.aks.ac.kr…  상세페이지
totalCount   1                     전체건수 (최상위)
```

목록 API에는 `definition`(한 줄)만 있고, 본문 요약은 상세 API `/articles/{eid}` 를 따로 호출해야 취득.

---

## 초록(요약) 취득 가능 여부 요약

취득 가능
- KCI — 국·영문 초록 제공. 실측 채움률 92.9% (1,417/1,526), 평균 896자
- NTIS — 국·영문 초록 제공. 실측 채움률 41.4% (12/29)
- KISTI — Abstract 필드 존재하나 수집 이력 0건이라 실측 불가
- EncyKorea — 초록이 아닌 항목 요약/정의. 평균 83자

취득 불가
- RISS — 원문 미제공 (abstract는 Y/N 플래그). 실측 0/9,857
- LOSI — searchTotal에선 항상 빈 값. searchView API 추가 발급 후 가능. 실측 0/2,271
