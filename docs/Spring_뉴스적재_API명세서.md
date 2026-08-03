# Spring 프로젝트 뉴스 DB 적재 API 명세서

> NestJS 스크래퍼 서버(dmz_scraper)에서 수집된 기사 데이터를 Spring 프로젝트가 받아 CUBRID DB(news / news_file)에 적재하기 위한 명세서
>
> 개정 2026-07-13: 적재 전용 API `GET /scraper/articles/{originId}` 기준으로 전면 개정.
> 구버전이 안내하던 `GET /scraper/download/{originId}`(presigned URL 반환)는 화면/다운로드용이며 **적재 연동에 사용하지 않는다** (URL 1시간 만료, 적재용 필드 누락).

---

## 1. 역할 분담

| 구분 | 담당 | 설명 |
|---|---|---|
| 수집 (HTML 스크래핑 + 연합뉴스 RSS) | dmz_scraper (Node) | 수집 → 번역 → 이미지/파일 S3 업로드 → `meta.json` 저장 |
| DB 적재 (news / news_file) | **Spring** | 아래 API를 주기 호출 → 중복 검사 → INSERT |

- 연합뉴스(yna)도 같은 API·같은 스키마로 내려간다. yna의 origin_id만 환경설정 값(YNA_ORIGIN_ID)으로 공유받으면 됨.
- 단, **yna origin으로 호출하면 조회 전에 RSS 피드 수집을 먼저 실행**해 최신분까지 이번 응답에 포함시킨다 (기사가 있으면 번역 포함 수십 초 걸릴 수 있으므로 **읽기 타임아웃 3분 이상** 권장). 수집 결과는 응답의 `collect` 필드(yna 호출에만 존재)로 내려간다 — `collect.ok=false`면 수집 실패(피드 차단 등)이며, 그 경우에도 기존 S3 누적분은 정상 반환되므로 적재는 그대로 진행하면 된다. 알 수 없는 필드를 무시하도록 파싱할 것.
- dmz_scraper의 기존 DB 적재(download2)는 전환 검증 후 제거 예정.

---

## 2. 호출 API

```
GET {스크래퍼_서버_호스트}:3000/scraper/articles/{originId}?since={YYYY-MM-DD HH:mm:ss}
```

| 파라미터 | 위치 | 필수 | 설명 |
|---|---|---|---|
| originId | path | O | news_origin.origin_id |
| since | query | X | 이 시각(KST) **이후에 수집 완료된** 기사만 반환. 생략 시 해당 origin 전체 반환. `YYYY-MM-DD` 또는 `YYYY-MM-DD HH:mm:ss` |

- 인증: 없음 (내부망 호출)
- since 형식 오류 시 HTTP 400

### 호출 예시

```
GET http://localhost:3000/scraper/articles/16?since=2026-07-13 00:00:00
```

---

## 3. 응답 구조

전역 인터셉터가 모든 응답을 `{ "success": true, "data": ..., "timestamp": "..." }`로 감싼다.
아래 본문은 **`data` 안에 들어가는 내용**이다. yna origin 호출 시에만 `data.collect`(선행 수집 결과: `{ ok, summary | error }`)가 추가되며, 알 수 없는 필드는 무시하고 파싱할 것.

```json
{
  "originId": 16,
  "since": "2026-07-13 00:00:00",
  "total": 2,
  "articles": [
    {
      "originId": 16,
      "title": "기사 제목",
      "contentText": "본문 첫 문단<br>둘째 문단",
      "linkUrl": "https://example.com/article/123",
      "writer": "홍길동",
      "regDt": "2026-07-12 00:00:00",
      "regDtParsed": true,
      "langCode": "ko",
      "trslYn": "Y",
      "titleEn": "Article title",
      "contentTextEn": "Body...",
      "collectedAt": "2026-07-13 09:05:12",
      "files": [
        {
          "filePath": "/news-crawler/file/16/2026-07-12/img/abc.jpg",
          "fileUrl": "https://example.com/img/abc.jpg",
          "fileTy": "image",
          "sortOrder": 0,
          "fileName": "abc.jpg",
          "mimeType": "image/jpeg",
          "downloadUrl": "/scraper/media?path=%2Fnews-crawler%2Ffile%2F16%2F2026-07-12%2Fimg%2Fabc.jpg"
        }
      ],
      "skippedFiles": 0
    }
  ]
}
```

값은 전부 **DB에 바로 넣을 수 있게 정규화되어** 내려간다 (날짜 파싱, 파일 경로 변환, 번역 여부 판정 완료). Spring 쪽에서 재가공하지 말 것. Presigned URL이 아니므로 만료 개념이 없고, S3 키 추출 같은 후처리도 필요 없다.

### 응답 필드 설명

| 필드 | 타입 | 설명 |
|------|------|------|
| `total` | number | articles 건수 |
| `articles[].title` | string | 기사 제목 |
| `articles[].contentText` | string | 본문. 줄바꿈은 `<br>` |
| `articles[].linkUrl` | string | 원본 기사 URL |
| `articles[].writer` | string | 작성자명 (없으면 빈 문자열) |
| `articles[].regDt` | string | 기사 작성일시 `yyyy-MM-dd HH:mm:ss`. 시각 정보가 없는 원문은 `00:00:00` |
| `articles[].regDtParsed` | boolean | `false`면 작성일 파싱 실패 → regDt에 sentinel `1970-01-01 00:00:00`이 들어있음. **그대로 적재** (나중에 `reg_dt < '2000-01-01'`로 추려 보정 가능. SYSDATE fallback 금지 — 재조회마다 값이 달라져 중복 검사가 깨짐) |
| `articles[].trslYn` | 'Y'/'N' | 영문 번역 성공 여부 |
| `articles[].titleEn` / `contentTextEn` | string | 영문 번역 (실패 시 빈 값/NULL) |
| `articles[].collectedAt` | string | 수집 완료 시각(KST). 다음 폴링의 since 기준으로 사용 가능 |
| `articles[].files[].filePath` | string | S3 객체 키 (버킷 제외, `/`로 시작). news_file.file_path에 **그대로 저장** |
| `articles[].files[].fileUrl` | string | 원 사이트의 파일 URL |
| `articles[].files[].fileTy` | string | `image` 또는 `file` (확장자 기준 분류 완료. 허용 외 확장자는 이미 제외됨 → skippedFiles) |
| `articles[].files[].sortOrder` | number | 0부터 시작 |
| `articles[].files[].fileName` | string | 원본 파일명 (다운로드 저장 시 사용) |
| `articles[].files[].mimeType` | string | 확장자 기반 MIME 타입 (예: `image/jpeg`, `application/pdf`) |
| `articles[].files[].downloadUrl` | string | **미디어 프록시 다운로드 상대경로.** 폴링과 같은 수집서버 호스트에 이 경로를 붙여 GET 하면 바이너리가 스트리밍됨 (아래 3-1 참고) |

### 3-1. 미디어(이미지/파일) 다운로드 — `GET /scraper/media`

내부망은 S3로 직접 나갈 수 없으므로(화이트리스트: 수집서버 EC2만 허용), **수집서버가 S3 → 내부망 다운로드 관문 역할**을 한다. Spring은 기사 JSON을 받은 뒤 각 `files[].downloadUrl`을 같은 호스트로 GET 해서 바이너리를 받고, 내부 스토리지에 저장 후 자기 경로로 치환해 적재하면 된다.

```
GET {수집서버}/scraper/media?path={files[].filePath URL인코딩}
```

- `downloadUrl` 값이 이미 인코딩까지 끝난 완성형이므로 **그대로 붙여 쓰면 된다** (직접 조립 불필요).
- 응답은 인터셉터 래핑 없는 **순수 바이너리 스트림**이며 다음 헤더를 포함한다:
  - `Content-Type` — MIME 타입
  - `Content-Length` — 파일 크기(byte). 수신 후 크기 검증에 사용 가능
  - `ETag` — S3 체크섬 (단일 업로드 객체는 MD5와 일치). 무결성 검증에 사용 가능
  - `Content-Disposition` — `attachment; filename*=UTF-8''{원본파일명}`
- 오류: `400` = 허용되지 않는 path (`/news-crawler/` 하위만 허용), `404` = S3에 없는 파일. 이때는 바이너리가 아닌 `{ success: false, ... }` JSON이 내려온다.
- 파일 단위 재시도 가능 — 일부 파일 다운로드 실패 시 기사 재조회 없이 해당 URL만 다시 GET 하면 된다.

---

## 4. DB 적재 규칙

### 4-1. `news` 컬럼 매핑

| news 컬럼 | 값 |
|---|---|
| news_id | `MAX(news_id)+1` **수동 채번** (자동증가 아님) |
| title / content_text / link_url | 응답의 title / contentText / linkUrl |
| origin_id | 응답의 originId |
| origin_nm / origin_nm_en | `news_origin` 테이블에서 origin_id로 조회 (하드코딩 매핑표 불필요) |
| category_id | `news_origin.category_code` |
| category_nm / category_nm_en | `news_category` 테이블에서 category_code로 조회 |
| lang_code | `'ko'` |
| trsl_yn | 응답의 trslYn |
| use_yn | `'Y'` |
| file_path | `NULL` |
| rgtr_id / mdfr_id | `'admin'` |
| reg_dt | 응답의 regDt |
| mdfcn_dt / crawl_dt | 적재 시각 (now) |
| title_en / content_text_en | 응답의 titleEn / contentTextEn |

### 4-2. `news_file` 컬럼 매핑 (기사당 files[] 반복)

| news_file 컬럼 | 값 |
|---|---|
| file_id | `MAX(file_id)+1` **수동 채번** |
| news_id | 위에서 채번한 news_id |
| file_path / file_url / file_ty / sort_order | files[]의 filePath / fileUrl / fileTy / sortOrder |
| use_yn | `'Y'` |
| rgtr_id | `'admin'` |
| reg_dt | 적재 시각 (now) |
| lang_code | `'ko'` |

### 4-3. 중복 판정 (필수)

```sql
SELECT news_id FROM news
WHERE origin_id = ? AND title = ? AND CAST(reg_dt AS DATE) = CAST(? AS DATE)
LIMIT 1
```

- 존재하면 해당 기사 SKIP.
- **link_url을 중복 키로 쓰지 말 것** — 같은 기사가 URL 파라미터(page=, searchKeyword= 등)만 다른 채로 여러 번 수집될 수 있음. (구버전 명세의 link_url 기준은 폐기)
- 이 규칙 덕에 since 없이 전체 재조회해도, 전환 병행 기간에 양쪽이 적재해도 이중 적재는 발생하지 않음 (멱등).

### 4-4. 트랜잭션

news 1건 + 그 files[] INSERT를 한 트랜잭션으로 묶고, 실패 시 해당 기사만 롤백 후 다음 기사 진행 권장.

---

## 5. 전체 적재 흐름

```
[Spring 배치/스케줄러]
        ↓
origin 목록(news_origin) 순회
        ↓
GET /scraper/articles/{originId}?since=...
        ↓
articles[] 순회
        ↓
중복 체크 (origin_id + title + 일자) → 존재하면 SKIP
        ↓
news_id = MAX+1 채번 → INSERT INTO news
        ↓
files[] 순회 → GET {수집서버}{downloadUrl} 로 바이너리 다운로드
        → 내부 스토리지 저장, file_path를 내부 경로로 치환
        → file_id = MAX+1 채번 → INSERT INTO news_file
        ↓
커밋 (기사 단위)
```

> 파일 다운로드 실패 시: 해당 파일만 재시도하거나, 기사 자체를 다음 회차로 미루는 것 중 정책 선택. (미디어 프록시는 파일 단위 GET이므로 부분 재시도 가능)

---

## 6. 호출 타이밍 권장

- 수집 주기: 연합뉴스는 **5분마다**, 일반 스크래퍼는 config별 크론(대체로 일 단위).
- 권장 폴링: origin 목록 순회하며 **10~30분 간격** 호출. (presigned URL 만료 개념이 없으므로 수집 직후에 맞춰 호출할 필요 없음)
- since는 "마지막 성공 폴링 시각 − 여유분(예: 1시간)" 권장. 중복 판정이 있으므로 겹쳐 조회해도 안전. 유실이 의심되면 since 생략(전체 조회)으로 복구.

---

## 7. 오류 처리

| 상황 | 대응 |
|------|------|
| HTTP 400 | since 형식 오류 — 요청 파라미터 수정 |
| HTTP 5xx | 전체 배치 실패로 처리, 다음 회차 재시도 (멱등이므로 안전) |
| `total: 0, articles: []` | 해당 originId의 신규 수집 결과 없음, 정상 종료 |
| `knownOrigin: false` (+ `total: 0`) | 스크래퍼에 등록되지 않은 origin_id — 수집 대상이 아니므로 폴링 목록에서 제외 권장 |
| `regDtParsed: false` | regDt(sentinel 1970-01-01)를 그대로 적재. SYSDATE로 바꾸지 말 것 |
