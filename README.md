# DMZ Scraper

NestJS 기반의 웹 스크래핑 엔진으로, Config 기반 스크래핑 → S3 저장 파이프라인을 담당합니다.

---

## Swagger UI

서버 실행 후 아래 URL에서 전체 API를 확인하고 직접 테스트할 수 있습니다.

```
http://localhost:3000/api
```

---

## 아키텍처 개요

```
Config 등록 (REST API / scrape-configs/*.json)
    ↓
CronJob 스케줄 등록 (SchedulerRegistry)
    ↓
ScraperService.runWorkflow()
    ├─ PageNavigationService  → 목록 페이지에서 상세 URL 추출 / 페이지네이션
    ├─ HtmlParsingService     → CSS 셀렉터로 텍스트/데이터 추출 (cheerio)
    └─ MediaDownloadService   → 이미지/파일 다운로드 → S3 업로드
    ↓
Gemini 영문 번역 (title_en, content_text_en)
    ↓
JSON 반환 / S3 meta.json 저장 (DB 저장 없음)
    ↓
TaskTrackerService.complete() → 실행 로그 S3 저장
```

---

## 핵심 파일 구조

```
src/
├── scraper/
│   ├── scraper.service.ts           # 메인 워크플로우 (runWorkflow, scrapeUrl, scrapeOne)
│   ├── scraper.config.service.ts    # Config CRUD + CronJob 등록/관리
│   ├── scraper.config.controller.ts # REST API (/scraper/*)
│   ├── json-config.service.ts       # JSON 파일 기반 Config 관리 (인메모리 캐시)
│   ├── html-parsing.service.ts      # DOM 파싱 (cheerio)
│   ├── page-navigation.service.ts   # 페이지네이션, URL 추출
│   ├── media-download.service.ts    # 이미지/파일 다운로드 + S3 업로드
│   ├── types/scraper.type.ts        # TypeScript 인터페이스
│   ├── dto/scraperDtos.ts
│   └── scraper.module.ts
│
├── translation/
│   ├── translation.controller.ts   # CMS/외부용 번역 API
│   ├── translation.service.ts      # Gemini 번역 + 긴 본문 분할
│   └── dto/translation.dto.ts
│
├── aws/s3/
│   └── s3.service.ts                # S3 업로드/다운로드
│
├── news/
│   └── news.entity.ts               # Article, imgInterface, fileInterface 등
│
└── common/
    ├── log/schedule/
    │   └── taskTracker.service.ts   # 실행 로그 S3 저장
    ├── utils/
    │   ├── scrapProcess/process.service.ts  # 날짜/필드 데이터 가공
    │   └── geminiAnalyze/                   # Gemini AI (날짜 파싱용)
    └── webhook/google-chat.service.ts       # Google Chat 오류 알림

scrape-configs/          # Config JSON 파일 저장 폴더 (id별 파일)
    ├── 1.json
    ├── 2.json
    └── ...
```

---

## S3 저장 구조

```
버킷명/
  └── news-crawler/
        ├── file/
        │     └── {configId}/
        │           └── YYYY-MM-DD/
        │                 ├── img/   → 스크랩 이미지
        │                 └── file/  → PDF 등 첨부파일
        └── log/
              └── {configId}/
                    └── YYYY-MM-DD/
                          └── HHmmss_uuid.json  → 실행 로그
```

**로그 파일 형식**
```json
{
  "id": 1,
  "configId": 1,
  "startedAt": "2026-05-26T09:00:00.000Z",
  "endedAt": "2026-05-26T09:00:15.000Z",
  "itemCount": 5,
  "success": true,
  "message": "스크랩 완료"
}
```

---

## Config steps 구조

스크래핑 동작은 `steps` JSON 배열로 정의됩니다.

상세 페이지가 목록 페이지에서 받은 세션/쿠키를 요구하는 사이트는 config 최상위에 `"useListSession": true`를 추가합니다. 값이 없거나 `false`이면 기존처럼 상세 페이지별 새 context를 사용합니다.

```json
[
  { "id": "step-001", "type": "detailLinks", "params": { "selector": "a.article", "attribute": "href" } },
  { "id": "step-002", "type": "scrapDetail", "params": { "targets": [
      { "name": "title",     "type": "uniqueText",     "selector": "h1" },
      { "name": "writedate", "type": "uniqueText",     "selector": ".date" },
      { "name": "content",   "type": "duplicatedText", "selector": ".body" },
      { "name": "img",       "type": "images",         "selector": "img" }
  ]}},
  { "id": "step-003", "type": "paging", "params": { "selector": "div.pager" } }
]
```

- `detailLinks` — 목록 페이지에서 상세 URL 추출
- `scrapDetail` — 상세 페이지에서 필드 수집
- `paging` — 다음 페이지로 이동

> 상세 작성 방법은 [ScrapeConfig_Steps_작성가이드.md](./docs/ScrapeConfig_Steps_작성가이드.md) 참고

---

## 주요 기술 스택

| 역할 | 라이브러리 |
|---|---|
| 프레임워크 | NestJS + @nestjs/schedule |
| 브라우저 자동화 | Playwright (chromium headless) |
| HTML 파싱 | cheerio |
| Config 관리 | JSON 파일 (scrape-configs/*.json) |
| 파일 저장 | AWS S3 |
| 실행 로그 | AWS S3 (news-crawler/log/) |
| AI 분석 | Google Gemini (날짜 파싱) |
| 동시성 제어 | p-limit (최대 2 concurrent) |
| API 문서 | Swagger (@nestjs/swagger) |

---

## 환경변수 (.env)

| 변수 | 필수 | 설명 |
|---|---|---|
| `AWS_REGION` | ✅ | S3 리전 (기본: ap-northeast-2) |
| `AWS_BUCKET_NAME` | ✅ | S3 버킷 이름 |
| `AWS_ACCESS_KEY_ID` | ✅ | AWS 자격증명 |
| `AWS_SECRET_ACCESS_KEY` | ✅ | AWS 자격증명 |
| `GEMINI_API_KEY` | ❌ | Gemini AI (날짜 파싱/영문 번역, 없으면 번역 API 비활성화) |
| `GEMINI_TRANSLATION_MODEL` | ❌ | 번역 모델 (기본: `gemini-2.5-flash-lite`) |
| `GEMINI_TRANSLATION_MAX_CHARS` | ❌ | 번역 요청당 최대 글자 수 (기본: `6000`) |
| `GEMINI_TRANSLATION_CONCURRENCY` | ❌ | 동시 번역 요청 수 (기본: `2`) |
| `OPENAI_API_KEY` | ❌ | Config 자동 생성 기능 (`POST /scraper/config/init`) |
| `GOOGLE_WEB_HOOK` | ❌ | Google Chat 에러 알림 웹훅 URL |
| `GOOGLE_WEB_HOOK_TIMEOUT` | ❌ | 타임아웃용 대체 웹훅 URL |

---

## 프로젝트 셋업

```bash
npm install

# Playwright 브라우저 설치 (최초 1회)
npx playwright install chromium
```

## 실행

```bash
# 개발 모드
npm run start:dev

# 일반 실행
npm run start
```

## 번역 API

- `POST /translation/text` - 단일 문자열 번역
- `POST /translation/fields` - CMS에서 전달한 임의 필드 객체 번역
- `POST /translation/article` - `title_en`, `writer_en`, `content_en` 형식으로 번역

크롤러는 S3 `meta.json` 저장 전에 뉴스 기본 필드를 자동 번역합니다. 번역에
실패해도 원문 수집과 저장은 계속됩니다.

## Swagger 접속

```
http://localhost:3000/api
```

## 관련 문서

- [ScrapeConfig_Steps_작성가이드.md](./docs/ScrapeConfig_Steps_작성가이드.md) — `steps` 작성법 (detailLinks, scrapDetail, paging 등)
- [Spring_뉴스적재_API명세서.md](./docs/Spring_뉴스적재_API명세서.md) — Spring 프로젝트의 뉴스 DB 적재 API 명세서
- [ScrapeConfig_생성가이드.md](./docs/ScrapeConfig_생성가이드.md) — `scrape-configs/N.json` 생성 가이드
