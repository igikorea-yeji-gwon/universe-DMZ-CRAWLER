/**
 * 자료마당(archive 테이블) 수집 공통 타입.
 * RISS/KCI/NTIS 컬렉터가 만드는 정규화 아이템과 S3 meta.json, 스프링 폴링 응답 스키마.
 * 뉴스(news) 파이프라인과는 별개 — S3 프리픽스도 archive-crawler/ 로 분리한다.
 */

export type ArchiveMenuId = 'PUBLICATIONS' | 'PAPERS' | 'BOOKS';
export type ArchiveSource =
  | 'riss'
  | 'kci'
  | 'ntis'
  | 'losi'
  | 'kisti'
  | 'encykorea';
export type ArchiveMaterialType = 'article' | 'thesis' | 'book' | 'report';

/** 컬렉터가 API 응답을 정규화해 IngestService에 넘기는 아이템 */
export interface ArchiveItem {
  source: ArchiveSource;
  /** 소스별 안정 고유ID — KCI article-id(ART…), RISS link id(A…/T…/U…), NTIS 보고서등록번호(TRKO…) */
  sourceId: string;
  title: string;
  /** 발행기관 원문 (기관 분류기의 입력) */
  publisher: string;
  /** 복수 저자는 ', ' join */
  author: string;
  /** 'YYYY' (없으면 '') */
  publishYear: string;
  /** 소스 주제분류 (없으면 null → 적재 시 '접경지역' 기본값은 스프링 몫) */
  category: string | null;
  /** 수록 학술지명·권호, 키워드 등 보조 분류 */
  subCategory: string | null;
  /** 초록 (RISS는 미제공 → null) */
  summary: string | null;
  /** 원문/상세 페이지 URL → archive.link_url */
  detailUrl: string | null;
  isbn: string | null;
  materialType: ArchiveMaterialType;
  matchedKeyword: string;
  /** API가 영문을 직접 제공하는 경우(KCI/NTIS) — 있으면 번역앱 호출 생략 */
  titleEn?: string | null;
  summaryEn?: string | null;
  authorEn?: string | null;
}

/** 기관 분류 결과 */
export interface InstitutionVerdict {
  verdict: 'GOV' | 'PRIVATE';
  by: 'dict' | 'pattern' | 'llm' | 'llm-lowconf' | 'default' | 'cache';
}

/** S3 archive-crawler/items/{originId}/{itemHash}/meta.json — 수집 완료 마커 */
export interface ArchiveMeta {
  source: ArchiveSource;
  sourceId: string;
  menuId: ArchiveMenuId;
  title: string;
  titleEn: string | null;
  publisher: string;
  publisherEn: string | null;
  author: string;
  authorEn: string | null;
  publishYear: string;
  category: string | null;
  categoryEn: string | null;
  subCategory: string | null;
  subCategoryEn: string | null;
  summary: string | null;
  summaryEn: string | null;
  linkUrl: string | null;
  isbn: string | null;
  coverUrl: string | null;
  /** `${SOURCE}:${sourceId}` — 스프링 중복검사 키 (archive.register_no) */
  registerNo: string;
  remark: string | null;
  matchedKeywords: string[];
  classification: InstitutionVerdict;
  /** 수집 시각 (KST, 참고용 — 증분 폴링 기준은 S3 LastModified) */
  collectedAt: string;
}

/** 수집 실행 옵션 (수동 엔드포인트 쿼리 파라미터와 1:1) */
export interface ArchiveCollectOptions {
  /** 지정 시 해당 키워드만 (테스트용). 미지정 시 KEYWORDS 14개 전체 */
  keyword?: string;
  /** 키워드당 최대 페이지 수 (미지정 시 전체 페이지 순회 = 백필) */
  maxPages?: number;
  /** 페이지당 건수 (기본 ARCHIVE_PAGE_SIZE, KCI는 10/20/50/100만 유효) */
  pageSize?: number;
  /** 영문 번역 수행 여부 (기본 true) */
  translate: boolean;
  /** true면 S3 저장·표지조회 없이 파싱/분류 결과만 반환 (외부 API 검증용) */
  dryRun: boolean;
  /** 크론 증분 수집 모드 — 소스별 날짜 필터 적용 (KCI regDateFrom 등) */
  incremental?: boolean;
}

export interface ArchiveIngestSummary {
  originId: number;
  source: ArchiveSource;
  fetched: number;
  deduped: number; // 키워드 간 중복 제거 후 아이템 수
  skippedExisting: number; // S3 완료 마커 존재로 스킵
  droppedIrrelevant: number; // DMZ 무관 판정으로 저장 제외
  droppedNonAcademic: number; // 학술자료 발행처가 아님(언론사·의원실·사무처)으로 저장 제외
  droppedUnclassifiable: number; // 발행기관 판정불가(publisher 없음)로 저장 제외
  classified: Record<ArchiveMenuId, number>;
  translated: number;
  coverFetched: number;
  saved: number;
  dryRun: boolean;
  errors: { sourceId: string; message: string }[];
  /** dryRun일 때 파싱/분류 결과 미리보기 (최대 20건) */
  preview?: ArchiveMeta[];
}

/** GET /scraper/archives/:originId 응답 아이템 — 스프링이 archive 테이블에 그대로 INSERT */
export interface ExportedArchiveItem {
  originId: number;
  source: ArchiveSource;
  /** = registerNo. 스프링 중복검사 키 */
  dedupKey: string;
  menuId: ArchiveMenuId;
  title: string | null;
  titleEn: string | null;
  publisher: string | null;
  publisherEn: string | null;
  publishYear: string | null;
  author: string;
  authorEn: string | null;
  category: string | null;
  categoryEn: string | null;
  subCategory: string | null;
  subCategoryEn: string | null;
  viewLocation: null;
  hasFile: 'X';
  summary: string | null;
  summaryEn: string | null;
  linkUrl: string | null;
  registerNo: string;
  callNo: null;
  filePath: null;
  remark: string | null;
  isbn: string | null;
  coverUrl: string | null;
  useYn: 'Y';
  rgtrId: 'admin';
  trslYn: 'Y' | 'N';
  /** meta.json S3 저장 시각 (KST) — since 증분 폴링 기준 */
  collectedAt: string | null;
}

// ─── 분류 규칙 ────────────────────────────────────────────────────────────────

/**
 * 발행기관 판정(GOV/PRIVATE) + 자료유형 → menu_id 결정 (DMZ 포털 자료마당 분류규칙).
 *
 *                        | 논문류(article/thesis/report) | 단행본(book)
 *   GOV(정부·지자체·국책연)  |          발간자료             |    발간자료
 *   PRIVATE(학회·대학·민간) |            논문               |    단행본
 *
 * 즉 발행기관이 GOV면 자료유형 무관하게 발간자료, PRIVATE면 단행본은 단행본·나머지는 논문.
 * (북한자료센터 소장목록은 무조건 단행본이지만 RISS/KCI/NTIS 수집분에는 없음 — 수동 적재분 규칙)
 */
export function decideArchiveMenu(
  materialType: ArchiveMaterialType,
  verdict: 'GOV' | 'PRIVATE',
): ArchiveMenuId {
  if (verdict === 'GOV') return 'PUBLICATIONS';
  return materialType === 'book' ? 'BOOKS' : 'PAPERS';
}

// ─── 공통 유틸 ────────────────────────────────────────────────────────────────

/** xml2js(explicitArray:false)가 1건이면 객체로 주는 것을 배열로 정규화 */
export function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * XML 본문의 이스케이프 안 된 & 를 &amp; 로 치환 (유효한 엔티티는 유지).
 * NTIS가 '국가R&D' 같은 원문을 이스케이프 없이 반환해 엄격한 파서가 깨지는 것 대응.
 */
export function sanitizeXmlAmp(xml: string): string {
  return String(xml ?? '').replace(
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g,
    '&amp;',
  );
}

/**
 * NTIS 응답은 검색어 하이라이트를 이스케이프 안 된 raw XML(<span class="search_word">…</span>)로 반환한다.
 * 이대로 파싱하면 xml2js가 <Korean> 같은 텍스트 노드를 자식 요소가 있는 '객체'로 만들어
 * String(node) → "[object Object]"가 된다. 파싱 전에 span 래퍼만 벗겨 안쪽 텍스트를 인라인으로 남긴다.
 */
export function stripHighlightSpans(xml: string): string {
  return String(xml ?? '')
    .replace(/<span\b[^>]*>/gi, '')
    .replace(/<\/span>/gi, '');
}

/** xml2js 노드(문자열·객체·배열)에서 텍스트만 재귀 추출 (혼합콘텐츠가 객체로 파싱돼도 방어). 속성($) 제외 */
export function xmlNodeText(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(xmlNodeText).join('');
  if (typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>)
      .filter(([k]) => k !== '$')
      .map(([, v]) => xmlNodeText(v))
      .join('');
  }
  return String(node);
}

/** NTIS 검색어 하이라이트(<span class="search_word">…</span>) 등 태그 제거 + 공백 정리 */
export function stripTags(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** HTML 엔티티(&#183; &amp; 등) 디코딩 — LOSI 등 JSON 응답 텍스트에 엔티티가 섞여 옴 */
export function decodeHtmlEntities(value: unknown): string {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCharCode(parseInt(n, 16)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // amp는 이중 디코딩 방지 위해 마지막
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 일시적 오류(타임아웃·stream aborted·일시 5xx) 대비 재시도.
 * attempts회 모두 실패하면 마지막 오류를 그대로 throw. 재시도 간격은 baseDelayMs × 시도횟수.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  onRetry: (attempt: number, error: Error, delayMs: number) => void,
  attempts = 3,
  baseDelayMs = 2000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        const delayMs = baseDelayMs * attempt;
        onRetry(attempt, e as Error, delayMs);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

/**
 * S3 폴더명에 붙일 제목 접미어 — `{hash}_{제목}` 형태로 저장해 콘솔에서 바로 식별 가능하게.
 * S3 키에 문제되는 문자(/ 등)와 공백을 '_'로 치환하고 길이를 제한한다.
 */
export function titleToS3Suffix(title: string, maxLen = 40): string {
  return String(title ?? '')
    .replace(/[\/\\:*?"'<>|#%&{}\[\]`^~\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen)
    .replace(/_+$/g, '');
}
