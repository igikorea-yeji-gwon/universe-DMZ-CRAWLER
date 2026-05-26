export interface UploadToS3Params {
  configName: string;
  category: 'content' | 'img' | 'file' | 'scrapData';
  data: Buffer | string;
  contentType?: string;
  extension?: string; // 확장자 명시 (예: jpg, pdf)
  filenameBase?: string; // 유저가 지정하는 이름 base (예: 'image_3', 'data', 'report_2024')
}
