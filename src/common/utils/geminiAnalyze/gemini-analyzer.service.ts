import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as path from 'path';
import * as fs from 'fs';
import { Article } from 'src/news/news.entity';
import { geminiAnalyzeRequest } from './gemini-analyze-dtos';

// 분석 결과 인터페이스
export interface ImageAnalysisResult {
  isVisualContent: string;
  confidenceScore: number;
}

export interface ArticleAnalysisResult {
  imageIndex: number;
  filename: string;
  isVisualContent: boolean;
  confidenceScore: number;
  error?: string;
}

@Injectable()
export class GeminiAnalyzerService {
  private readonly logger = new Logger(GeminiAnalyzerService.name);
  private readonly genAI: GoogleGenerativeAI;
  private readonly model: any;
  private readonly PROMPT: string;


  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY not configured — image analysis disabled');
      return;
    }
    const promptPath = path.join(process.cwd(), 'prompts/image-analysis.txt');
    this.PROMPT = fs.existsSync(promptPath)
      ? fs.readFileSync(promptPath, 'utf-8')
      : '';
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
  }

  /**
   * 단일 이미지 분석 (base64)
   */
  async analyzeImage(geminiAnalyzeRequest: geminiAnalyzeRequest): Promise<ImageAnalysisResult> {
    try {
      const imageBase64 = geminiAnalyzeRequest.imageBase64;
      const metadata = geminiAnalyzeRequest.metadata;

      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

      let fullPrompt = this.PROMPT;
      if (metadata?.title || metadata?.caption) {
        fullPrompt += `\n\n[참고 메타정보]\n`;
        if (metadata.title) fullPrompt += `- 기사 제목: ${metadata.title}\n`;
        if (metadata.caption) fullPrompt += `- 이미지 캡션: ${metadata.caption}\n`;
      }

      const imagePart = {
        inlineData: {
          data: base64Data,
          mimeType: 'image/jpeg',
        },
      };

      const response = await this.model.generateContent([fullPrompt, imagePart]);
      const text = response.response.text();

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('유효한 JSON 응답이 없습니다');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        isVisualContent: String(parsed.isVisualContent),
        confidenceScore: Number(parsed.confidenceScore) || 0,
      };
    } catch (error) {
      this.logger.error(`이미지 분석 실패: ${error.message}`);
      throw error;
    }
  }

  /**
   * Article 객체의 모든 이미지 분석
   */
  async analyzeArticle(article: Article, source: string = ""): Promise<Article> {

    if (!article.images || article.images.length === 0) {
      console.log('Article에 이미지가 없습니다. 분석을 건너뜁니다.');
      return article;
    }

    for (let i = 0; i < article.images.length; i++) {
      const imageBase64 = article.images[i];
      const caption = article.imgCaptions?.[i] || '';

      const geminiAnalyzeRequest: geminiAnalyzeRequest = {
        imageBase64: imageBase64,
        metadata: {
          title: article.title,
          caption: caption,
        },
      };

      try {
        const analysisResult = await this.analyzeImage(geminiAnalyzeRequest);

        if (!article.isNkImage) {
          article.isNkImage = [];
        }
        
        //이미지 분석 결과 저장
        article.isNkImage.push(
          analysisResult.isVisualContent
        );

        this.logger.log(
          `✅ 이미지 ${i + 1}/${article.images.length} 분석 완료: ` +
            `isVisual=${analysisResult.isVisualContent}, confidence=${analysisResult.confidenceScore}`,
        );

      } catch (error) {
        article.isNkImage.push(
          'false' //분석 실패
        );
        this.logger.error(`❌ 이미지 ${i + 1} 분석 실패: ${error.message}`);
      }

      // API 속도 제한 대응 (1초 딜레이)
      await this.sleep(1000);
    }
    if(source === 'yna'){
      article.images = [];
    }
    return article;
  }

  /**
   * 텍스트 질문에 대한 응답 반환
   */
  async askQuestion(prompt: string): Promise<string> {
    if (!this.model) return '';
    try {
      const response = await this.model.generateContent(prompt);
      return response.response.text().trim();
    } catch (error) {
      this.logger.error(`Gemini 텍스트 요청 실패: ${error.message}`);
      throw error;
    }
  }

  /**
   * 비동기 딜레이
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}