# Spring 프로젝트 뉴스 DB 적재 API 명세서

> NestJS 스크래퍼 서버에서 수집된 기사 데이터를 Spring 프로젝트가 받아 CUBRID DB에 적재하기 위한 명세서

---

## 1. 호출 API

| 항목 | 내용 |
|------|------|
| **Method** | `GET` |
| **URL** | `http://{스크래퍼_서버_호스트}:3000/scraper/download/{originId}` |
| **Path Variable** | `originId` — 수집 출처 ID (숫자, 예: `12`) |
| **인증** | 없음 (내부망 호출) |

### 호출 예시
```
GET http://localhost:3000/scraper/download/12
```

---

## 2. 응답 구조

```json
{
  "success": true,
  "data": [
    {
      "title":      "기사 제목",
      "writer":     "작성자명",
      "writedate":  "20230222",
      "content":    "본문 텍스트 (HTML 태그 포함 가능)",
      "currentUrl": "https://원본사이트/article/123",
      "images": [
        "https://dmz-portal-bucket.s3.ap-northeast-2.amazonaws.com/news-crawler/articles/12/abc123/img/photo1.jpg?X-Amz-Algorithm=...&X-Amz-Expires=3600&...",
        "https://..."
      ],
      "files": [
        "https://dmz-portal-bucket.s3.ap-northeast-2.amazonaws.com/news-crawler/articles/12/abc123/files/report.pdf?X-Amz-Algorithm=...&X-Amz-Expires=3600&..."
      ]
    }
  ]
}
```

### 응답 필드 설명

| 필드 | 타입 | 설명 |
|------|------|------|
| `success` | boolean | 요청 성공 여부 |
| `data` | Array | 수집된 기사 배열 (0개 이상) |
| `data[].title` | string | 기사 제목 |
| `data[].writer` | string | 작성자명 (없으면 빈 문자열) |
| `data[].writedate` | string | 작성일 — **`yyyyMMdd` 형식** (예: `"20230222"`) |
| `data[].content` | string | 본문 내용 (HTML 포함 가능) |
| `data[].currentUrl` | string | 원본 기사 URL |
| `data[].images` | string[] | 이미지 Presigned URL 배열 (S3, 유효시간 **1시간**) |
| `data[].files` | string[] | 첨부파일 Presigned URL 배열 (S3, 유효시간 **1시간**) |

> **⚠️ Presigned URL 주의사항**
> - `images`와 `files`의 URL은 API 호출 시점으로부터 **1시간 후 만료**됨
> - API 응답 수신 즉시 파일을 다운로드하거나, URL에서 S3 키를 추출해 `file_path`로 저장해야 함
> - S3 키 추출 방법: URL에서 `?` 이전 경로에서 도메인 제거 → `/news-crawler/articles/{originId}/{hash}/img/{filename}`

---

## 3. DB 적재 대상 테이블

### 3-1. `news` 테이블

| 컬럼명 | 타입 | 값 출처 | 규칙 |
|--------|------|---------|------|
| `news_id` | NUMBER | DB 자동 생성 | PK, AUTO_INCREMENT |
| `title` | VARCHAR | `data[].title` | 필수 |
| `content_text` | CLOB | `data[].content` | 필수 |
| `origin_id` | NUMBER | URL 파라미터 `{originId}` | 예: `12` |
| `origin_nm` | VARCHAR | origin_id → 명칭 매핑 (아래 참조) | 예: `숲나들e` |
| `link_url` | VARCHAR | `data[].currentUrl` | 중복 체크 기준 컬럼 |
| `category_nm` | VARCHAR | origin_id → 카테고리 매핑 (아래 참조) | 예: `정부/공공기관` |
| `category_id` | VARCHAR | origin_id → 카테고리 ID 매핑 (아래 참조) | 예: `GOV_PUBLIC` |
| `lang_code` | VARCHAR(2) | 고정값 | `'ko'` |
| `trsl_yn` | CHAR(1) | 고정값 | `'N'` |
| `use_yn` | CHAR(1) | 고정값 | `'Y'` |
| `file_path` | VARCHAR | `data[].images[0]` → S3 키 추출 | 대표 이미지 경로, 없으면 NULL |
| `rgtr_id` | VARCHAR | 고정값 | `'SYSTEM'` |
| `reg_dt` | TIMESTAMP | `data[].writedate` 변환 | `yyyyMMdd` → `yyyy-MM-dd 00:00:00` |
| `mdfr_id` | VARCHAR | — | NULL |
| `mdfcn_dt` | TIMESTAMP | — | NULL |

### 3-2. `news_file` 테이블

| 컬럼명 | 타입 | 값 출처 | 규칙 |
|--------|------|---------|------|
| `file_id` | NUMBER | DB 자동 생성 | PK, AUTO_INCREMENT |
| `news_id` | NUMBER | `news.news_id` | FK, 위에서 INSERT한 news_id |
| `file_path` | VARCHAR | Presigned URL → S3 키 추출 | `?` 이전의 경로에서 도메인 제거 |
| `file_url` | VARCHAR | Presigned URL 원본 | 빠른 저장 시 일시적 URL (권장: NULL or S3 Base URL) |
| `file_ty` | VARCHAR | 배열 종류에 따라 | `images` 배열 → `'image'`, `files` 배열 → `'file'` |
| `sort_order` | NUMBER | 배열 인덱스 | `0`부터 시작 |
| `use_yn` | CHAR(1) | 고정값 | `'Y'` |
| `rgtr_id` | VARCHAR | 고정값 | `'SYSTEM'` |
| `reg_dt` | TIMESTAMP | 고정값 | `SYSDATE` (적재 시점) |

---

## 4. origin_id → origin_nm / 카테고리 매핑표

Spring 프로젝트에서 직접 관리해야 할 매핑값입니다.
스크래퍼 Config API(`GET /scraper/config/{id}`)로 조회하거나, 아래를 하드코딩 또는 별도 테이블로 관리하세요.

| origin_id | origin_nm | category_nm | category_id |
|-----------|-----------|-------------|-------------|
| 1 | 두루누비 | 정부/공공기관 | GOV_PUBLIC |
| 10 | DMZ박물관 | 문화/관광 | CULTURE |
| 11 | 숲나들e | 정부/공공기관 | GOV_PUBLIC |
| 12 | 숲나들e | 정부/공공기관 | GOV_PUBLIC |
| ... | (추가 매핑 필요) | | |

> `GET /scraper/config/list?pageSize=50&pageNumber=1` 호출 시 전체 config 목록 및 `id`, `name` 확인 가능

---

## 5. S3 키 추출 방법

```
Presigned URL 예시:
https://dmz-portal-bucket.s3.ap-northeast-2.amazonaws.com/news-crawler/articles/12/154de805/img/photo.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&...

S3 키 (file_path에 저장):
/news-crawler/articles/12/154de805/img/photo.jpg

추출 방법:
1. URL에서 `?` 이전 문자열 추출
2. `https://dmz-portal-bucket.s3.ap-northeast-2.amazonaws.com` 제거
3. 남은 경로가 S3 키
```

Java 예시:
```java
String presignedUrl = "https://...s3.amazonaws.com/news-crawler/articles/12/.../photo.jpg?X-Amz-...";
String s3Key = "/" + presignedUrl.split("amazonaws.com/")[1].split("\\?")[0];
// 결과: /news-crawler/articles/12/.../img/photo.jpg
```

---

## 6. 중복 처리 규칙

- `news.link_url` 기준으로 중복 여부 확인
- 이미 존재하는 `link_url`은 **INSERT 건너뜀** (SKIP)
- 또는 업무 판단에 따라 title/content 변경 시 UPDATE 처리 가능

CUBRID 예시:
```sql
-- 중복 확인
SELECT news_id FROM news WHERE link_url = ?

-- 없을 때만 INSERT
INSERT INTO news (title, content_text, origin_id, ...) VALUES (?, ?, ?, ...)
```

---

## 7. 전체 적재 흐름

```
[Spring 배치/스케줄러]
        ↓
GET /scraper/download/{originId}
        ↓
data[] 순회
        ↓
link_url 중복 체크 → 존재하면 SKIP
        ↓
INSERT INTO news (title, content_text, origin_id, ...)
        ↓
images[] 순회 → INSERT INTO news_file (file_ty='image', sort_order=0,1,2...)
        ↓
files[] 순회 → INSERT INTO news_file (file_ty='file', sort_order=0,1,2...)
```

---

## 8. 호출 타이밍 권장

스크래퍼 서버는 JSON 설정의 `scheduleTime` 시각에 수집을 실행하고, 결과를 S3에 저장합니다.
Spring 프로젝트는 수집 완료 후 이 API를 호출해야 하므로:

- **방법 A (권장)**: 스크래퍼 수집 스케줄보다 **1~2시간 뒤** Spring 적재 배치 실행
- **방법 B**: NestJS 쪽에서 수집 완료 시 Spring 웹훅 호출 (추후 구현 필요)

> Presigned URL 유효시간이 **1시간**이므로, API 호출 후 즉시 처리하거나  
> `file_path`(S3 키)만 저장하고 파일은 나중에 필요할 때 서버 측에서 재생성

---

## 9. 오류 처리

| 상황 | 대응 |
|------|------|
| `success: false` | 전체 배치 실패로 처리, 재시도 |
| `data: []` | 해당 originId의 수집 결과 없음, 정상 종료 |
| Presigned URL 다운로드 실패 (403/expired) | 해당 파일 skip, 나머지는 정상 처리 |
| `writedate` 형식 오류 | `reg_dt`를 `SYSDATE`로 fallback |
| `content`가 HTML 태그 포함 | 그대로 저장 (HTML 제거 여부는 업무 판단) |
