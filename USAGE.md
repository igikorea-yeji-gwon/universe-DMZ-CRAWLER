# DMZ 수집기 사용법

DMZ·접경지역 뉴스 수집 시스템. **두 개의 독립 애플리케이션**으로 구성됩니다.

| 앱 | 레포/폴더 | 포트 | 역할 |
| --- | --- | --- | --- |
| **수집기** (dmz-scraper) | `universe-DMZ-CRAWLER` | **3000** | 스크래핑·연합뉴스 수집·S3 적재. 번역이 필요하면 번역앱을 HTTP로 호출 |
| **번역앱** (dmz-translation) | `dmz_translation` (별도 레포) | **3001** | 한→영 번역 전용 (Gemini). 수집기가 호출 |

> 번역앱이 죽어 있어도 수집은 계속됩니다 — 영문 필드는 비운 채(`trsl_yn='N'`) 저장돼요.

---

## 1. 실행

### 로컬 (개발)
```bash
# 수집기
cd universe-DMZ-CRAWLER
npm install && npm run start:dev      # 3000

# 번역앱 (별도 터미널)
cd dmz_translation
npm install && npm run start:dev      # 3001
```

### EC2 (pm2)
```bash
npm install && npm run build
pm2 startOrReload ecosystem.config.js   # 각 레포에서
pm2 save                                 # 재부팅 대비 저장
pm2 list                                 # dmz-scraper / dmz-translation online 확인
```

---

## 2. 환경변수 (.env)

### 수집기
| 키 | 필수 | 설명 |
| --- | --- | --- |
| `AWS_REGION` / `AWS_BUCKET_NAME` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | O | S3 적재 |
| `GEMINI_API_KEY` | O | 이미지 분석용 (번역 아님) |
| `TRANSLATION_API_URL` | X | 번역앱 주소. 기본 `http://localhost:3001` |
| `TRANSLATION_API_TIMEOUT_MS` | X | 번역 호출 타임아웃. 기본 180000 |
| `CUBRID_HOST` / `PORT` / `DATABASE` / `USER` / `PASSWORD` | O | download2 적재용 |
| `YNA_FEED_URL` / `YNA_ORIGIN_ID` | O | 연합뉴스 수집 |
| `SEOJI_CERT_KEY` | O | ISBN 표지 조회 |
| `GOOGLE_WEB_HOOK` | X | 실패 알림(구글챗) |

### 번역앱
| 키 | 필수 | 설명 |
| --- | --- | --- |
| `GEMINI_API_KEY` | O | 없으면 부팅은 되나 번역 요청 시 503 |
| `PORT` | X | 기본 3001 |

---

## 3. API 엔드포인트

Swagger 문서: 수집기 `http://<host>:3000/api`, 번역앱 `http://<host>:3001/api`

### 수집기 (`/scraper/*`)
| Method | 경로 | 설명 |
| --- | --- | --- |
| GET | `/scraper/health` | **수집기 헬스체크** (프로세스 + Playwright 브라우저 상태) |
| GET | `/scraper/translation/connection` | **번역앱 연결체크** (번역 미유발, 도달 여부만) |
| GET | `/scraper/translation/test?mock=ko\|en` | 번역앱 실제 번역 왕복 테스트 (`ko`=Gemini 호출, `en`=연결만) |
| GET | `/scraper/config/list` | Config 목록 (페이징/검색) |
| GET | `/scraper/config/:id` | Config 단건 조회 |
| GET | `/scraper/config/schedule` | 등록된 CronJob 목록 |
| POST | `/scraper/config/init` | URL 입력 → AI가 Config 자동 생성 |
| GET | `/scraper/run/:id` | Config 즉시 실행, 결과 반환 |
| GET | `/scraper/download/:originId` | S3 수집파일 목록 (presigned URL) |
| GET | `/scraper/articles/:originId?since=` | 스프링 적재용 정규화 JSON (증분 폴링) |
| GET | `/scraper/download2/:originId` | S3 meta.json → CUBRID 적재 (임시) |
| GET | `/scraper/yna/collect` | 연합뉴스 RSS 즉시 수집 |
| GET | `/scraper/yna/backfill?month=&translate=&limit=&async=` | 연합뉴스 과거 XML 백필 |

### 번역앱
| Method | 경로 | 설명 |
| --- | --- | --- |
| GET | `/health` | **헬스체크** — 실제 번역까지 수행 (연결+기능 확인) |
| POST | `/translation/text` | 단일 텍스트 번역 |
| POST | `/translation/fields` | 여러 필드 일괄 번역 |
| POST | `/translation/article` | 기사 번역 → `title_en`/`writer_en`/`content_en` |

### ISBN
| Method | 경로 | 설명 |
| --- | --- | --- |
| POST | `/isbn/book-info` | ISBN 서지·표지 조회 |

---

## 4. 모니터링 / 헬스체크 (Postman 기본 셋팅)

운영 중 상태를 빠르게 볼 수 있게, **아래 두 요청을 Postman 컬렉션에 기본으로 넣어두세요.**
둘 다 **GET**이고 Gemini 호출이 없어 부담 없이 반복 호출해도 됩니다.

| 이름 | Method | URL | 정상 응답 |
| --- | --- | --- | --- |
| 수집기 상태 | GET | `{{baseUrl}}/scraper/health` | `data.ok=true`, `browserConnected=true` |
| 번역앱 연결 | GET | `{{baseUrl}}/scraper/translation/connection` | `data.ok=true`, `message="번역 앱 연결됨 ..."` |

**Postman 변수** (Environment 또는 Collection variable):
- `baseUrl` = `http://localhost:3000` (로컬) / `http://43.201.91.119:3000` (EC2)

**응답 예시**
```jsonc
// GET /scraper/health
{ "success": true, "data": {
  "ok": true, "browserConnected": true, "uptimeSec": 3600, "timestamp": "..."
}, "timestamp": "..." }

// GET /scraper/translation/connection
{ "success": true, "data": {
  "ok": true, "translationApiUrl": "http://localhost:3001",
  "elapsedMs": 12, "httpStatus": 404, "message": "번역 앱 연결됨 (HTTP 404)"
}, "timestamp": "..." }
```
> `httpStatus: 404`는 정상이에요 — 번역앱 루트(`/`)에는 라우트가 없지만, 응답이 온다는 것 자체가 "연결됨"을 뜻합니다. `ok:false`면 번역앱이 다운이거나 `TRANSLATION_API_URL` 포트가 틀린 거예요.

**바로 쓰는 컬렉션**: 같은 폴더의 [`postman/dmz-scraper.postman_collection.json`](postman/dmz-scraper.postman_collection.json)을 Postman에서 **Import**하면 위 두 요청 + 주요 엔드포인트가 `{{baseUrl}}` 변수와 함께 들어옵니다.

---

## 5. 배포 (CI/CD)

`deploy` 브랜치에 push하면 GitHub Actions가 EC2에 SSH로 자동 배포합니다
([.github/workflows/deploy.yml](.github/workflows/deploy.yml)):
`git pull origin deploy` → `npm install` → `npm run build` → `pm2 startOrReload ecosystem.config.js`

> 번역앱(dmz-translation)은 별도 레포라 이 파이프라인에 포함되지 않습니다 — 수동 배포하거나 별도 파이프라인이 필요해요.
