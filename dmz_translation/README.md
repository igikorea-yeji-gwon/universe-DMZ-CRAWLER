# dmz-translation

DMZ 뉴스 **영문번역 전용** API 서버. Gemini(`@google/genai`) 기반이며, 수집 앱(dmz-scraper)이 HTTP로 호출한다.

## 실행

```bash
npm install
npm run start:dev   # 개발 (기본 포트 3100)
npm run build && npm run start:prod
```

## 환경변수 (.env)

| 키 | 필수 | 설명 |
| --- | --- | --- |
| `GEMINI_API_KEY` | O | 없으면 부팅은 되지만 번역 요청 시 503 |
| `PORT` | X | 기본 3100 |
| `GEMINI_TRANSLATION_MODEL` | X | 기본 `gemini-3.1-flash-lite` |
| `GEMINI_TRANSLATION_CONCURRENCY` | X | 기본 2 |
| `GEMINI_TRANSLATION_MAX_CHARS` | X | 청크 최대 글자수, 기본 6000 |

## API (Swagger: `/api`)

- `POST /translation/text` — 단일 텍스트 번역
- `POST /translation/fields` — 여러 필드 일괄 번역 `{ fields: { title, content } }`
- `POST /translation/article` — 뉴스 기사 번역 `{ title, writer, content }` → `{ title_en, writer_en, content_en }`

모든 응답은 전역 인터셉터가 `{ success, data, timestamp }` 로 감싼다.
수집 앱 쪽 클라이언트는 `src/scraper/translation-client.service.ts` (환경변수 `TRANSLATION_API_URL`).
