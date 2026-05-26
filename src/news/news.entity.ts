export interface imgInterface {
  imgurl: string;
  imgString: string | null;
  s3Path?: string;
  caption?: string;
  url?: string;
}

export interface fileInterface {
  fileurl: string;
  filePath: string;
  s3Path?: string;
}

export interface DetailScrapedData {
  title?: string;
  writer?: string;
  writedate?: string;
  content?: string;
  img?: imgInterface[];
  file?: fileInterface[];
  currentUrl?: string;
  [key: string]: any;
}

export class Article {
  title: string = '';
  writer: string = '';
  writedate: string = '';
  cururl: string = '';
  content: string = '';
  cdatetime: string = '';
  images?: string[] = [];
  imgurl: string[] = [];
  imgCaptions?: string[] = [];
  pdfFiles?: string[] = [];
  pdfPath: string = '';
}

export interface WorkflowResult {
  configId: any;
  data: any[];
}
