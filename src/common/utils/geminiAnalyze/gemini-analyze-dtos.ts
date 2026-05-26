export interface geminiAnalyzeRequest {
  imageBase64: string,
  metadata?: { title?: string; caption?: string },
}