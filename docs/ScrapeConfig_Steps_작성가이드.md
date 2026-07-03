# ScrapeConfig Steps 작성 가이드

## 목차

1. [전체 구조](#1-전체-구조)
   - [1-1. formSubmit — POST 검색 폼 제출](#1-1-formsubmit--post-검색-폼-제출)
2. [detailLinks — 상세 URL 수집 방식](#2-detaillinks--상세-url-수집-방식)
   - [2-1. data-* 속성 + customTransform으로 URL 조합](#2-1-data--속성--customtransform으로-url-조합)
   - [2-1-1. data-* 속성이 여러 개인데 일부가 고정값인 경우](#2-1-1-data--속성이-여러-개인데-일부가-고정값인-경우)
   - [2-2. href 링크 직접 사용](#2-2-href-링크-직접-사용)
   - [2-3. onclick 실행](#2-3-onclick-실행)
   - [2-4. javascript: href 실행](#2-4-javascript-href-실행)
   - [2-5. JS 이벤트 리스너로 동작하는 요소 클릭 (role="link" div 등)](#2-5-js-이벤트-리스너로-동작하는-요소-클릭-rolelink-div-등)
3. [scrapDetail — 데이터 추출](#3-scrapdetail--데이터-추출) (name / type 기준, 콤마로 다중 셀렉터 지정 가능)
   - [3-1. 목록에서 미리 추출하기 (writer-list / writedate-list)](#3-1-목록에서-미리-추출하기-writer-list--writedate-list)
   - [3-2. selector에 콤마(,)로 여러 셀렉터 지정](#3-2-selector에-콤마로-여러-셀렉터-지정)
4. [paging — 다음 페이지 이동](#4-paging--다음-페이지-이동)
5. [customTransform — 속성값 → URL 변환](#5-customtransform--속성값--url-변환)
6. [file 첨부파일 다운로드 URL 추출](#6-file-첨부파일-다운로드-url-추출)
   - [6-1. href에 파일 경로가 있는 경우](#6-1-href에-파일-경로가-있는-경우)
   - [6-2. javascript:location.href='...' 방식](#6-2-javascriptlocationhref-방식)
   - [6-3. onclick 함수 호출 방식](#6-3-onclick-함수-호출-방식)
7. [selector 작성 팁 (CSS 속성 선택자)](#7-selector-작성-팁--css-속성-선택자로-대상-좁히기)
8. [attribute 선택 기준 한눈에 보기](#8-attribute-선택-기준-한눈에-보기)
9. [완전한 예시 — 실제 사이트(koreadmz): 목록 HTML + 상세 HTML → 전체 config](#9-완전한-예시--실제-사이트koreadmz-목록-html--상세-html--전체-config)

---

## 1. 전체 구조

`steps` 배열은 순서대로 실행된다.

```
detailLinks → scrapDetail → (paging → detailLinks → scrapDetail → ...)
```

- **detailLinks** : 목록 페이지에서 각 게시물의 상세 URL 수집
- **scrapDetail** : 수집된 URL에서 실제 데이터 추출
- **paging** : 다음 페이지로 이동 후 detailLinks → scrapDetail 반복

> ✅ **작성 준비물: 목록 페이지 HTML + 상세 페이지 HTML 둘 다 확보하고 시작한다.**
> 하나의 config는 두 페이지에 걸쳐 있다. URL만으로는 셀렉터를 못 잡으니 두 페이지의 실제 태그를 모두 열어두고 작성한다.
>
> | 셀렉터가 사는 페이지 | 대상 |
> |---|---|
> | **목록 페이지** | `detailLinks`(상세 URL), `paging`(다음 버튼), `writer-list`·`writedate-list`(상세에 없고 목록에만 있는 작성자·날짜) |
> | **상세 페이지** | `scrapDetail`의 `title`·`content`·`writer`·`writedate`·`img`·`file` |
>
> 한 사이트를 두 페이지로 관통하는 전체 예시는 [9. 완전한 예시](#9-완전한-예시--실제-사이트koreadmz-목록-html--상세-html--전체-config) 참조.

**최상위 필드 (steps 바깥):**

| 필드 | 타입 | 설명 |
|---|---|---|
| `name` | string | 수집 대상 이름(사이트·게시판·검색조건). 웹훅/저장에 노출되므로 startUrl 검색조건과 일치시킬 것 |
| `description` | string | 부가 설명 |
| `baseUrl` | string | 상대경로 URL을 절대경로로 변환할 기준 도메인 |
| `startUrl` | string[] | 수집 시작 URL 배열(검색 파라미터 포함) |
| `steps` | object[] | 실행할 스텝 배열(아래 참조) |
| `scheduleTime` | string[] | 실행 시각(`"09:00"` 등) |
| `enabled` | boolean | 스케줄 활성화 여부 |
| `webhook` | boolean | 결과 웹훅 전송 여부(기본값 true) |
| `origin_id` | number | 원본(사이트) 식별자 |
| `useListSession` | boolean | 목록 세션 공유(아래 참고) |

**최상위 옵션:**

- `useListSession: boolean`
  - 기본값은 false와 동일하게 동작한다.
  - true면 목록 페이지를 연 브라우저 context의 세션/쿠키를 상세 페이지 수집에도 공유한다.
  - 상세 URL을 직접 열면 에러 페이지가 나오고, 목록을 거친 뒤에만 상세가 열리는 게시판에서 사용한다.

> ※ paging이 없으면 첫 번째 페이지만 수집하고 종료된다.

**최소 구성 예시:**

```js
const minimalExample = [
  { id: "step-001", type: "detailLinks", params: { selector: "...", attribute: "href" } },
  { id: "step-002", type: "scrapDetail", params: { targets: [ /* ... */ ] } },
  { id: "step-003", type: "paging",      params: { selector: "..." } }
];
```

### 1-1. formSubmit — POST 검색 폼 제출

검색 결과가 GET URL 파라미터로 반환되지 않고, 폼 POST로만 처리되는 사이트에서 사용한다.

**언제 필요한가?**
브라우저 네트워크 탭에서 검색 결과 URL을 복사해 직접 접근했을 때 결과가 나오지 않고 기본 목록만 보이는 경우 → POST 처리 사이트

**동작 순서**

1. startUrl 페이지를 먼저 로드 (검색 폼이 있는 목록 페이지)
2. formSubmit 스텝: 지정한 필드에 값 입력 → 제출 버튼 클릭 → 결과 페이지 대기
3. 이후 detailLinks, scrapDetail, paging 스텝이 결과 페이지에서 정상 동작

**주의사항**

- formSubmit은 첫 번째 페이지에서만 실행된다 (페이지네이션 반복 시 재실행 방지).
- 결과 URL에 page/pageIndex 등 파라미터가 포함되면 paging 스텝이 정상 동작한다.
- AJAX 방식(페이지 이동 없이 결과만 갱신)은 지원하지 않는다.

**params:**

- `fields` : 입력할 폼 필드 배열. selector + value 쌍으로 지정. input 태그 → `fill(value)`, select 태그 → `selectOption(value)` 자동 처리.
- `submitSelector` : 제출 버튼의 CSS 셀렉터. 클릭 후 navigation 대기.

**HTML 패턴 예시:**

```html
<input id="searchKeyword" name="searchKeyword" type="text">
<select name="searchCondition">
  <option value="SUBJECT">제목</option>
  <option value="CONTENT">내용</option>
</select>
<button class="btn_search">검색</button>
```

```js
const formSubmitExample = {
  id: "step-001",
  type: "formSubmit",
  params: {
    fields: [
      { selector: "input#searchKeyword",        value: "dmz"     },  // 텍스트 입력
      { selector: "select[name='searchCondition']", value: "SUBJECT" }  // 드롭다운 선택
    ],
    submitSelector: "button.btn_search"   // 클릭할 제출 버튼
  }
};
```

**전체 Config 예시 (POST 검색 사이트):**

```js
const formSubmitFullExample = [
  {
    id: "step-001",
    type: "formSubmit",
    params: {
      fields: [
        { selector: "input#searchKeyword", value: "dmz" }
      ],
      submitSelector: "a.search, button[type='submit']"
    }
  },
  {
    id: "step-002",
    type: "detailLinks",
    params: { selector: "table.board tbody tr td.title a", attribute: "href" }
  },
  {
    id: "step-003",
    type: "scrapDetail",
    params: {
      targets: [
        { name: "title",     type: "uniqueText",     selector: "h2.view-title" },
        { name: "writedate", type: "uniqueText",     selector: "span.date" },
        { name: "content",   type: "duplicatedText", selector: "div.content" }
      ]
    }
  },
  {
    id: "step-004",
    type: "paging",
    params: { selector: "div.pager" }
  }
];
```

---

## 2. detailLinks — 상세 URL 수집 방식

### 2-1. data-* 속성 + customTransform으로 URL 조합

href가 `#;`처럼 쓸 수 없고, data-* 속성값으로 URL을 직접 만들어야 하는 경우.

**HTML 패턴:**

```html
<ul id="tbody">
  <li data-idno="fT5BkMoy">
    <div class="infoArea"><a href="#;" class="infoLink">제목</a></div>
  </li>
</ul>
```

> ※ data-* 속성명 확인 방법: 브라우저 개발자도구(F12) → Elements 탭에서 목록 li 태그를 클릭하면 `data-idno`, `data-seq` 등 `data-`로 시작하는 속성이 보인다. 그 속성명을 그대로 attribute에 입력하면 된다. (예: `data-idno="fT5BkMoy"` → `attribute: "data-idno"`)

```js
const case1_detailLinks = {
  id: "step-001",
  type: "detailLinks",
  params: {
    selector: "#tbody li[data-idno]",
    attribute: "data-idno",
    customTransform: {
      type: "regex",
      pattern: "(.+)",
      output: "/cms/board/boardView.do?MENU_CD=nFSy219D&CONTENTS_CD=vqNUjDNc&BBS_CD=${1}&pageNo=1"
    }
  }
};
```

### 2-1-1. data-* 속성이 여러 개인데 일부가 고정값인 경우

href가 `javascript:void(0);`이고, 상세 URL이 여러 data-* 속성의 조합으로 구성되는 경우.
단, 한 번에 읽을 수 있는 속성은 하나뿐이므로 나머지 값이 목록 전체에서 고정일 때만 사용 가능.

**HTML 패턴:**

```html
<a href="javascript:void(0);"
   data-url="/main/pt/pst/selectPstInfo.do"
   data-sn="501699"
   data-id="1003"
   class="inner pstInfoBtn">제목</a>
```

> ⚠️ **반드시 실제 상세 링크를 직접 클릭해서 이동된 URL을 확인한 뒤 output을 작성할 것!**
>
> 확인 방법: 개발자도구(F12) → Network 탭 열어두고 → 목록에서 항목 클릭 → 이동된 브라우저 주소창 URL 또는 Network 탭의 최초 document 요청 URL 확인

**실제 확인 사례 (대한적십자사):**
`data-sn="501861"`, `data-id="1003"` 인 항목의 실제 상세 URL:
`https://www.redcross.or.kr/main/pt/pst/selectPstInfo.do?mi=1045&bbsId=1003&pstSn=501861`

비교:

| data-* 속성 | 실제 URL 파라미터명 | 비고 |
|---|---|---|
| `data-sn` | `pstSn` | 이름 다름 |
| `data-id` | `bbsId` | 이름 다름 |
| (없음) | `mi=1045` | data-* 어디에도 없는 추가 고정 파라미터 |

→ data-* 속성명과 실제 URL 파라미터명이 다르고, 예상 못한 파라미터가 있을 수 있으므로 **절대 data-* 속성명으로 파라미터명을 유추하지 말고 실제 URL을 직접 확인할 것.**

고정값이 아닌 경우(항목마다 다른 경우)는 현재 config로 처리 불가.
고정값인 경우 → 변하는 값(`data-sn`)만 읽고, 나머지는 output 템플릿에 하드코딩.

```js
const case1_1_detailLinks = {
  id: "step-001",
  type: "detailLinks",
  params: {
    selector: "tbody tr td.bbs_tit a.inner.pstInfoBtn",
    attribute: "data-sn",                             // 항목마다 변하는 값만 읽기
    customTransform: {
      type: "regex",
      pattern: "(.+)",
      // 실제 URL 직접 확인 후 작성: mi, bbsId는 고정, pstSn만 ${1}로 치환
      output: "/main/pt/pst/selectPstInfo.do?mi=1045&bbsId=1003&pstSn=${1}"
    }
  }
};
```

### 2-2. href 링크 직접 사용

href에 바로 URL이 있는 가장 단순한 케이스.
상대경로(`/board/view.do?seq=1234`)는 baseUrl 기준 절대경로로 자동 변환된다.

**HTML 패턴:**

```html
<ul class="list">
  <li><a href="/board/view.do?seq=1234" class="item-link">제목</a></li>
</ul>
```

```js
const case2_detailLinks = {
  id: "step-001",
  type: "detailLinks",
  params: {
    selector: "ul.list li a.item-link",
    attribute: "href"
  }
};
```

### 2-3. onclick 실행

> ⚠️ 실제 브라우저에서 JS를 실행하기 때문에 목록 N개만큼 [이동 → 뒤로가기]를 반복해 속도가 느리다.

**HTML 패턴:**

```html
<a onclick="goView('1234', 'NOTICE')">제목</a>
```

**동작 방식:** onclick 속성값을 파싱 → `window.goView('1234', 'NOTICE')` 실행 → 이동된 URL 저장 → 목록으로 뒤로가기 → 다음 항목 반복

```js
const case3_onclick_detailLinks = {
  id: "step-001",
  type: "detailLinks",
  params: {
    selector: "ul.list li a",
    attribute: "onclick"
  }
};
```

### 2-4. javascript: href 실행

> ⚠️ 위 2-3과 동일하게 속도가 느리다.

**HTML 패턴:**

```html
<a href="javascript:fn_detailSearch(103, 110387, 1);">제목</a>
```

**동작 방식:** href에서 `javascript:` 제거 → `page.evaluate()`로 코드 실행 → 이동된 URL 저장 → 목록으로 뒤로가기 → 다음 항목 반복

> ※ attribute는 `"javascript"` 고정값으로 입력 (href에서 코드를 꺼내오는 플래그)

```js
const case3_javascript_detailLinks = {
  id: "step-001",
  type: "detailLinks",
  params: {
    selector: "ul.list li a",
    attribute: "javascript"   // "javascript:" href 실행 플래그 — 고정값
  }
};
```

### 2-5. JS 이벤트 리스너로 동작하는 요소 클릭 (role="link" div 등)

onclick 속성이 HTML에 없고, JavaScript `addEventListener`로 클릭 이벤트가 붙어있는 경우.
`attribute: "onclick"`은 속성값을 읽어서 실행하므로 이 경우엔 사용 불가.

> ⚠️ 2-3(onclick)과 동일하게 목록 N개만큼 [클릭 → 뒤로가기]를 반복해 속도가 느리다.

**HTML 패턴:**

```html
<div class="result-wrapper" role="link" tabindex="0">제목</div>
<!-- onclick 속성 없음, JS가 addEventListener로 클릭 이벤트 처리 -->
```

```js
const case5_click_detailLinks = {
  id: "step-001",
  type: "detailLinks",
  params: {
    selector: "div.result-meta-grid-wrapper[role='link']",
    attribute: "click"   // 요소를 직접 클릭 → 이동된 URL 캡처
  }
};
```

---

## 3. scrapDetail — 데이터 추출

케이스와 무관하게 구조는 동일하다.

**name 예약어:**

| name | 의미 |
|---|---|
| `title` | 제목 |
| `writedate` | 작성일 (이름에 `date`가 포함되면 날짜 파싱 + Gemini 변환 적용) |
| `content` | 본문 |
| `writer` | 작성자 (이 이름만 다운스트림 저장 필드와 매핑됨. `author`는 매핑 안 되니 쓰지 말 것) |
| `thumbnail` | 대표 이미지 (`type: "images"`) |
| `img` | 본문 이미지 (`type: "images"`) |
| `file` | 첨부파일 (`type: "file"`) |

**type 선택 기준:**

| type | 용도 | 반환값 |
|---|---|---|
| `uniqueText` | 요소가 하나 (제목·날짜·작성자 등) | 문자열 |
| `duplicatedText` | 요소가 여러 개 (본문 `<p>` 여러 개 등) | 문자열(연결) |
| `images` | 이미지 수집 (`img`, `thumbnail`) | 이미지 배열 |
| `file` | 첨부파일 수집 (`file`) | 파일 배열 |

> ※ 이미지/썸네일은 `type: "images"`, 첨부파일은 `type: "file"`을 쓴다 (섹션 6 참조). `fieldType`은 steps 방식에서 사용하지 않는다.

### 3-1. 목록에서 미리 추출하기 (writer-list / writedate-list)

상세 페이지에 날짜나 작성자 정보가 없고 목록 페이지에만 있는 경우 사용한다.
name 끝에 `-list`를 붙이면 목록 페이지에서 값을 추출하고, 상세 페이지 진입 시 해당 필드는 다시 수집하지 않고 목록 값을 그대로 사용한다.

**지원 이름:**

- `writer-list` : 작성자를 목록에서 추출 → `writer` 필드로 저장
- `writedate-list` : 날짜를 목록에서 추출 → `writedate` 필드로 저장 (날짜 파싱 + Gemini 변환 적용)

> ※ `-list` 접미사를 붙인 이름은 targets 안에 함께 정의한다. 상세 페이지에서 동일 필드(writer, date)를 별도로 정의하지 않아도 된다.

**동작 순서:**

1. 목록 페이지에서 `-list` 타겟의 selector로 모든 요소를 한 번에 추출
2. i번째 상세 URL ↔ i번째 값으로 매핑 (순서 기반)
3. 각 상세 페이지 진입 후 해당 값을 그대로 적용 (재수집 없음)

> ⚠️ 목록의 항목 순서와 상세 URL 순서가 일치해야 한다. 목록에 N개 항목이 있으면 selector도 정확히 N개 요소를 반환해야 한다.

```js
const listFieldExample = {
  id: "step-002",
  type: "scrapDetail",
  params: {
    targets: [
      { name: "title",       type: "uniqueText",     selector: "h2.view-title" },
      { name: "content",     type: "duplicatedText", selector: "div.view-content p" },
      // 목록에서 미리 추출 — 상세 페이지에 없는 경우
      { name: "writer-list",    type: "uniqueText", selector: "ul.list li span.author" },
      { name: "writedate-list", type: "uniqueText", selector: "ul.list li span.date" }
    ]
  }
};
```

### 3-2. selector에 콤마(,)로 여러 셀렉터 지정

게시물마다 제목 태그가 다를 때 콤마로 여러 셀렉터를 동시에 지정할 수 있다.
브라우저 표준 CSS 다중 선택자를 그대로 지원한다.

```
selector: "h1.title, h2.view-title, div.detail-tit span"
→ 세 셀렉터 중 페이지에 존재하는 요소를 모두 선택
```

> ⚠️ 주의: 우선순위가 아니라 매칭되는 요소를 전부 선택하는 방식. uniqueText의 경우 매칭된 요소 텍스트를 모두 `join(' ')`으로 합쳐서 저장하므로 여러 개가 동시에 매칭되면 텍스트가 붙어서 나온다. → 각 셀렉터가 해당 페이지에서 최대 1개만 존재하도록 구체적으로 잡을 것.

```js
const multiSelectorExample = {
  name: "title",
  type: "uniqueText",
  selector: "h1.title, h2.view-title, div.detail-tit span"  // 게시물마다 태그가 다를 때
};

const scrapDetailExample = {
  id: "step-002",
  next: [],
  type: "scrapDetail",
  params: {
    targets: [
      { name: "title",     type: "uniqueText",     selector: "h2.view-title" },
      { name: "writedate", type: "uniqueText",     selector: "span.date" },
      { name: "content",   type: "duplicatedText", selector: "div.view-content p" }
    ]
  }
};
```

---

## 4. paging — 다음 페이지 이동

페이지네이션 버튼/링크를 selector로 지정한다.
클릭 가능한 요소면 button, a 태그 모두 사용 가능.

```js
const pagingExample = {
  id: "step-003",
  type: "paging",
  params: {
    selector: "div.numberPagination ul.paging li button"
  }
};
```

---

## 5. customTransform — 속성값 → URL 변환

attribute로 읽은 raw 값을 그대로 URL로 쓸 수 없을 때 정규식으로 가공한다.

**필요 여부 판단 기준**

불필요 — 속성값을 그대로 쓰거나, JS 실행 결과로 URL을 얻을 수 있는 경우:

- `<a href="/view?id=1">` → 값 자체가 URL
- `<a onclick="goView('1')">` → JS 실행 → 브라우저 이동 → URL 캡처
- `<a href="javascript:fn(1);">` → JS 실행 → 브라우저 이동 → URL 캡처

필요 — 속성값을 파싱해서 URL을 직접 만들어야 하는 경우:

- `<li data-idno="fT5BkMoy">` → 값이 ID뿐, URL 조합 필요
- `<a href="javascript:location.href='/attach/...'">` → JS 실행하면 안 되고, 내부 경로만 추출
- `<a onclick="fileDown1('abc')">` → JS 실행하면 다운로드 시작, ID만 뽑아서 URL 조합

**구조:**

```js
customTransform: {
  type: "regex",          // 현재 "regex" 고정
  pattern: "(정규식)",    // 캡처 그룹 ()으로 추출할 부분 지정
  output: "URL 템플릿"    // ${1}, ${2}... 으로 캡처 그룹 참조
}
```

**동작 순서:**

1. attribute로 읽은 raw 값에 pattern 적용
2. `()`에 매칭된 값이 순서대로 `${1}`, `${2}`...에 매핑
3. output의 `${N}`을 치환해 최종 URL 생성
4. 상대경로면 baseUrl을 자동으로 붙여 절대경로로 변환

> ※ 자바스크립트 정규식 문법 사용. 특수문자(`. ( ) [ ]` 등)는 `\\`로 이스케이프.

**예시 1 — 값 전체를 URL에 끼워넣기:**

```
raw     = "fT5BkMoy"
pattern = "(.+)"                       → ${1} = "fT5BkMoy"
output  = "/board?id=${1}"
결과    = "https://baseUrl/board?id=fT5BkMoy"
```

**예시 2 — 여러 값 분리해서 조합:**

```
raw     = "notice_1234"
pattern = "([a-z]+)_(\\d+)"            → ${1} = "notice", ${2} = "1234"
output  = "/board/${1}/view?seq=${2}"
결과    = "https://baseUrl/board/notice/view?seq=1234"
```

**예시 3 — javascript: 코드에서 경로 추출:**

```
raw     = "javascript:location.href='/attach/down/abc123'"
pattern = "location\\.href='([^']+)'"  → ${1} = "/attach/down/abc123"
output  = "${1}"
결과    = "https://baseUrl/attach/down/abc123"
```

**예시 4 — onclick 함수에서 ID 추출 후 URL 조합:**

```
raw     = "fileDown1('abc123def')"
pattern = "fileDown1\\('([\\w\\d]+)'\\)"  → ${1} = "abc123def"
output  = "https://example.com/download.do?id=${1}"
결과    = "https://example.com/download.do?id=abc123def"
```

---

## 6. file 첨부파일 다운로드 URL 추출

scrapDetail의 targets 안에서 `name: "file"` + `type: "file"`로 사용한다. (`fieldType`은 steps 방식에서 참조되지 않으므로 넣지 않는다.)

### 6-1. href에 파일 경로가 있는 경우

**HTML 패턴:**

```html
<a href="/attach/files/report.pdf">보고서.pdf</a>
```

attribute 생략 시 href를 기본값으로 읽는다. 상대경로면 baseUrl 기준 절대경로로 자동 변환.

```js
const case4_file_href = {
  name: "file",
  type: "file",
  selector: "div.detail-info ul li.info-down p a"
  // attribute 생략 → href 기본값
};
```

### 6-2. javascript:location.href='...' 방식

**HTML 패턴:**

```html
<a href="javascript:location.href='/attach/down/095a2dda.../report.pdf'">보고서.pdf</a>
```

```js
const case4_file_javascript_location = {
  name: "file",
  type: "file",
  selector: "div.detail-info ul li.info-down p a",
  attribute: "href",
  customTransform: {
    type: "regex",
    pattern: "location\\.href='([^']+)'",   // 작은따옴표 사이 경로 캡처
    output: "${1}"
  }
};
```

### 6-3. onclick 함수 호출 방식

**HTML 패턴:**

```html
<a onclick="fileDown1('abc123def')">첨부파일.hwp</a>
```

```js
const case4_file_onclick = {
  name: "file",
  type: "file",
  selector: ".btnDown",
  attribute: "onclick",
  customTransform: {
    type: "regex",
    pattern: "fileDown1\\('([\\w\\d]+)'\\)",  // 괄호 안 ID 캡처
    output: "https://example.com/download.do?id=${1}"
  }
};
```

---

## 7. selector 작성 팁 — CSS 속성 선택자로 대상 좁히기

같은 태그가 여러 개일 때 특정 패턴의 요소만 골라내는 방법.

| 연산자 | 의미 | 예시 |
|---|---|---|
| `^=` | 속성값이 특정 문자열로 **시작** | `a[href^='javascript:article.view']` → href가 `javascript:article.view`로 시작하는 a 태그만 매칭 |
| `$=` | 속성값이 특정 문자열로 **끝남** | `a[href$='.pdf']` → `.pdf`로 끝나는 링크만 매칭 |
| `*=` | 속성값에 특정 문자열이 **포함** | `a[href*='/attach/down/']` → `/attach/down/`이 포함된 링크만 매칭 |

**조합 예시:**

```
"ul.file-list li a[href*='/attach/']"
→ ul.file-list 안의 li > a 중 href에 /attach/가 포함된 것만
```

---

## 8. attribute 선택 기준 한눈에 보기

| HTML 패턴 | attribute | customTransform |
|---|---|---|
| `<li data-seq="123">` | `"data-seq"` | 필요 (URL 조합) |
| `<a href="/view?id=1">` | `"href"` | 불필요 |
| `<a onclick="goView('1')">` | `"onclick"` | 불필요 |
| `<a href="javascript:fn(1);">` | `"javascript"` | 불필요 |
| `<a href="javascript:location.href='...'">` | `"href"` | 필요 (경로 추출) |
| `<a onclick="fileDown1('abc')">` | `"onclick"` | 필요 (ID → URL) |

---

## 9. 완전한 예시 — 실제 사이트(koreadmz): 목록 HTML + 상세 HTML → 전체 config

> 실제로 동작 검증된 케이스([scrape-configs/1.json](../scrape-configs/1.json)). 목록·상세 두 페이지의 태그를 나란히 놓고 셀렉터를 뽑아 하나의 config로 합치는 전 과정.
> - 목록: `https://www.koreadmz.kr/geopark/pds/notice?searchCondition=TITLE&searchKeyword=dmz`
> - 상세: `https://www.koreadmz.kr/geopark/pds/notice?articleSeq=136`

### ① 목록 페이지 HTML → detailLinks + paging

```html
<!-- table.skinTb.skinTb-data-resList tbody tr (한 행 = 게시물 하나) -->
<tr>
  <td class="skinTxa-center"> 1 </td>
  <td class="skinTb-sbj">
    <!-- href에 상대경로가 이미 있음 → onclick 무시하고 href만 쓰면 됨 (case 2-2) -->
    <a href="/geopark/pds/notice?articleSeq=111" onclick="goPage(this.href); return false;">
      양구군 지질명소를 둘러볼 수 있는 "DMZ 평화의 길 투어" 오픈!
    </a>
  </td>
  <td class="skinTb-name skinTxa-center"> 관리자 </td>     <!-- 작성자 (목록에도 있음) -->
  <td class="skinTb-date skinTxa-center">2024-09-26</td>  <!-- 날짜 (목록에도 있음) -->
</tr>

<!-- 페이지네이션 -->
<div class="pager">
  <a class="pager-link pager-link-data-prev">이전</a>
  <a class="pager-link active">1</a>
  <a class="pager-link pager-link-data-next" onclick="linkPage(1);return false;">다음</a>
</div>
```

→ href에 상대경로(`/geopark/pds/notice?articleSeq=111`)가 그대로 있으므로 **attribute: "href"** 만으로 충분 (customTransform 불필요, baseUrl로 절대경로 자동 변환). 페이지네이션은 `div.pager` 컨테이너를 paging selector로 지정.

```js
// step-001
{ id: "step-001", type: "detailLinks",
  params: { selector: "table.skinTb.skinTb-data-resList.skinTb-data-bgEven tbody tr td.skinTb-sbj a", attribute: "href" } }

// step-003
{ id: "step-003", type: "paging",
  params: { selector: "#content div.contsArea.skinContainer div.pager" } }
```

> ※ 이 사이트는 작성자·날짜가 **상세 페이지에도** 있어서 아래 ②에서 뽑는다. 만약 상세에 없고 목록에만 있었다면, 위 목록의 `td.skinTb-name`·`td.skinTb-date`를 써서 `writer-list`·`writedate-list`로 뽑았을 것이다 (3-1 참조).

### ② 상세 페이지 HTML → scrapDetail

```html
<!-- div.skinTb.skinTb-data-resList.skinTb-data-bgSbj -->
<div class="skinTb-tr">
  <div class="skinTb-th">제목</div>
  <div class="skinTb-td skinTb-sbj">강원특별자치도, 「5월 지질·생태명소」 화천 &lt;양의대 하천습지&gt; 선정!</div>
</div>
<div class="skinTb-tr">
  <div class="skinTb-th">작성자</div>
  <div class="skinTb-td col2 skinTb-name">관리자</div>
  <div class="skinTb-th">등록일</div>
  <div class="skinTb-td col2 skinTb-date">2026-05-06</div>
</div>
<div class="skinTb-tr">
  <div class="skinTb-th">내용</div>
  <div class="skinTb-td skinTb-conts">
    <p><span>5월, DMZ 인근에서 만나는 </span><b>청정 자연의 보고</b></p>
    <p>굽이치는 북한강을 따라 형성된 <b>화천 &lt;양의대 하천습지&gt;</b>가 ...</p>
    <p><img src="/upload/.../photo.jpg"></p>
  </div>
</div>
```

→ 제목·작성자·날짜는 하나뿐이므로 `uniqueText`, 본문은 `<p>`가 여러 개이므로 `duplicatedText`, 이미지는 `images`.

```js
// step-002
{ id: "step-002", type: "scrapDetail", params: { targets: [
  { name: "title",     type: "uniqueText",     selector: "div.skinTb-td.skinTb-sbj" },
  { name: "writer",    type: "uniqueText",     selector: "div.skinTb-td.col2.skinTb-name" },
  { name: "writedate", type: "uniqueText",     selector: "div.skinTb-td.col2.skinTb-date" },  // 이름에 date 포함 → 날짜 파싱
  { name: "content",   type: "duplicatedText", selector: "div.skinTb-td.skinTb-conts" },
  { name: "img",       type: "images",         selector: "div.skinTb-td.skinTb-conts p img" },
] } }
```

### ③ 두 페이지의 셀렉터를 합친 최종 config

```jsonc
{
  "id": 1,
  "origin_id": 11,
  "name": "두루누비: 자료실 > 공지사항 > DMZ 검색(제목)",
  "baseUrl": "https://www.koreadmz.kr",
  "startUrl": ["https://www.koreadmz.kr/geopark/pds/notice?searchCondition=TITLE&searchKeyword=dmz"],
  "scheduleTime": ["09:00"],
  "enabled": true,
  "webhook": true,
  "steps": [
    { "id": "step-001", "type": "detailLinks",
      "params": { "selector": "table.skinTb.skinTb-data-resList.skinTb-data-bgEven tbody tr td.skinTb-sbj a", "attribute": "href" } },
    { "id": "step-002", "type": "scrapDetail",
      "params": { "targets": [
        { "name": "title",     "type": "uniqueText",     "selector": "div.skinTb-td.skinTb-sbj" },
        { "name": "writer",    "type": "uniqueText",     "selector": "div.skinTb-td.col2.skinTb-name" },
        { "name": "writedate", "type": "uniqueText",     "selector": "div.skinTb-td.col2.skinTb-date" },
        { "name": "content",   "type": "duplicatedText", "selector": "div.skinTb-td.skinTb-conts" },
        { "name": "img",       "type": "images",         "selector": "div.skinTb-td.skinTb-conts p img" }
      ] } },
    { "id": "step-003", "type": "paging",
      "params": { "selector": "#content div.contsArea.skinContainer div.pager" } }
  ]
}
```

> 실제 배포된 [1.json](../scrape-configs/1.json)은 셀렉터에 상위 경로를 더 길게 붙여 대상을 좁혔다(예: `div.contsArea.skinContainer ... div.skinTb-td.skinTb-sbj`). 위 예시는 같은 요소를 짧게 잡은 형태로, 둘 다 동작한다. 페이지에서 해당 셀렉터가 **정확히 1개**만 매칭되도록 필요한 만큼만 구체화하면 된다 (7·3-2 참조).
