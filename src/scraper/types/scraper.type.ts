export interface PagedResult<T> {
  data: T[];
  total: number;
  pageSize: number;
  pageNumber: number;
}

export interface AddScraperRequest {
  targetScraperConfig: ScrapeConfig;
  // ScrapeConfigs : ScrapeConfig
}

export interface initScraperRequest {
  searchUrl: string;
  detailsUrl: string;
}

interface SrcReplace {
  old: string;
  new: string;
}

interface CustomTransform {
  type?: 'regex';
  pattern?: string;
  output?: string;
}

// interface FieldDef {
//   selector: string;
//   attribute: string;
//   customTransform?: CustomTransform;
// }

export interface SearchField {
  fieldType: 'list' | 'paging' | 'pageNext';
  selector: string;
  attribute?: string;
  customTransform?: CustomTransform;
}

interface DetailField {
  fieldType:
    | 'title'
    | 'author'
    | 'writedate'
    | 'content'
    | 'thumbnail'
    | 'img'
    | 'imgCaption'
    | 'file';
  selector: string;
  srcReplace?: SrcReplace;
  attribute?: string;
  customTransform?: CustomTransform;
}

export interface TargetScraperConfig {
  id?: number;
  name: string;
  scheduleTime: string[];
  baseUrl: string;
  searchUrl: string[];
  detailUrl: string;
  useBrowser: boolean;
  searchUrlKey: string;
  searchFields: SearchField[];
  detailFields: DetailField[];
  createdAt?: Date;
  updatedAt?: Date;
  // userId: number;
  description?: string;
  enabled?: boolean;
  useListSession?: boolean;
  lastExecutedAt?: Date;
  // 분류 추가?
}

export interface FindScrapDataRequest {
  pageSize: number;
  pageNumber: number;
  id: number;
}

export interface PromptParams {
  exampleJson: string;
  url: string;
  html: string;
}

export interface ScrapeConfig {
  id?: number;
  origin_id?: number;
  name: string;
  scheduleTime: string[];
  baseUrl: string;
  startUrl: string[];
  steps: Record<string, any>[];
  createdAt?: Date;
  updatedAt?: Date;
  description?: string;
  enabled?: boolean;
  lastExecutedAt?: Date;
}

export interface AddScrapConfigRequest {
  targetScraperConfig: scrapConfig;
  // ScrapeConfigs : ScrapeConfig
}

export interface scrapConfig {
  id?: number;
  origin_id?: number;
  name: string;
  scheduleTime: string[];
  baseUrl: string;
  startUrl: string[];
  steps: Record<string, any>[];
  description?: string;
  enabled?: boolean;
  useListSession?: boolean;
}

export interface ScrapConfigAllData extends scrapConfig {
  createdAt: Date;
  updatedAt: Date;
  lastExecutedAt?: Date;
}
