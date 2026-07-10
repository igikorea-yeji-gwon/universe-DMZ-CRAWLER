import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import pLimit from 'p-limit';

export interface TranslationOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
}

// 고정 번역이 필요한 전문 용어 (Gemini가 매번 다르게 번역하는 것 방지)
const TERM_DICTIONARY: Record<string, string> = {
  'DMZ·접경지역': 'DMZ and Border Area',
};

// DMZ 인접 행정구역명 → 정부 표준 로마자 표기 (의미 번역이 아닌 음역 고정)
const PLACE_NAME_DICTIONARY: Record<string, string> = {
  인천광역시: 'Incheon',
  강화군: 'Ganghwa-gun',
  옹진군: 'Ongjin-gun',
  경기도: 'Gyeonggi-do',
  김포시: 'Gimpo-si',
  파주시: 'Paju-si',
  연천군: 'Yeoncheon-gun',
  동두천시: 'Dongducheon-si',
  포천시: 'Pocheon-si',
  강원도: 'Gangwon-do',
  철원군: 'Cheorwon-gun',
  화천군: 'Hwacheon-gun',
  양구군: 'Yanggu-gun',
  인제군: 'Inje-gun',
  고성군: 'Goseong-gun',
};

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);
  private readonly ai: GoogleGenAI | null = null;
  private readonly modelName: string;
  private readonly maxChunkLength: number;
  private readonly limit: ReturnType<typeof pLimit>;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    this.modelName =
      this.configService.get<string>('GEMINI_TRANSLATION_MODEL') ??
      'gemini-3.1-flash-lite';
    const concurrency = this.readPositiveNumber(
      'GEMINI_TRANSLATION_CONCURRENCY',
      2,
    );

    this.maxChunkLength = this.readPositiveNumber(
      'GEMINI_TRANSLATION_MAX_CHARS',
      6000,
    );
    this.limit = pLimit(concurrency);

    if (!apiKey) {
      this.logger.warn(
        'GEMINI_API_KEY가 없어 영문 번역 기능이 비활성화되었습니다.',
      );
      return;
    }

    this.ai = new GoogleGenAI({ apiKey });
  }

  async translateText(
    text: string,
    options: TranslationOptions = {},
  ): Promise<string> {
    const normalizedText = this.validateText(text);
    if (!normalizedText) return '';

    const sourceLanguage = options.sourceLanguage ?? 'Korean';
    const targetLanguage = options.targetLanguage ?? 'English';

    if (
      sourceLanguage.toLowerCase() === 'korean' &&
      targetLanguage.toLowerCase() === 'english' &&
      !this.containsKorean(normalizedText)
    ) {
      this.logger.log(`번역 스킵 (한국어 없음): "${normalizedText.slice(0, 50)}"`);
      return normalizedText;
    }

    if (!this.ai) {
      throw new ServiceUnavailableException(
        '번역 서비스가 설정되지 않았습니다. GEMINI_API_KEY를 확인해주세요.',
      );
    }

    const { text: termedText, placeholders: termPlaceholders } =
      this.maskTerms(normalizedText);

    const { text: maskedText, placeholders } = this.maskPlaceNames(
      termedText,
      sourceLanguage,
      targetLanguage,
    );

    const chunks = this.splitText(maskedText);
    this.logger.log(`번역 요청: ${chunks.length}청크, 총 ${maskedText.length}자`);
    const translatedChunks: string[] = [];

    for (const chunk of chunks) {
      translatedChunks.push(
        await this.limit(() =>
          this.requestTranslation(chunk, sourceLanguage, targetLanguage),
        ),
      );
    }

    const result = this.unmaskTerms(
      this.unmaskPlaceNames(translatedChunks.join('\n\n'), placeholders),
      termPlaceholders,
    );
    this.logger.log(`번역 완료: ${result.length}자 → "${result.slice(0, 80)}..."`);
    return result;
  }

  private maskTerms(text: string): { text: string; placeholders: Map<string, string> } {
    const placeholders = new Map<string, string>();
    let masked = text;
    let index = 0;

    for (const [korean, english] of Object.entries(TERM_DICTIONARY).sort(
      ([a], [b]) => b.length - a.length,
    )) {
      if (!masked.includes(korean)) continue;
      const token = `@@TERM${index}@@`;
      placeholders.set(token, english);
      masked = masked.split(korean).join(token);
      index += 1;
    }

    return { text: masked, placeholders };
  }

  private unmaskTerms(text: string, placeholders: Map<string, string>): string {
    let result = text;
    for (const [token, english] of placeholders) {
      result = result.split(token).join(english);
    }
    return result;
  }

  // 행정구역명을 Gemini가 의미 번역하지 못하도록 플레이스홀더로 치환
  private maskPlaceNames(
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): { text: string; placeholders: Map<string, string> } {
    const placeholders = new Map<string, string>();

    if (
      sourceLanguage.toLowerCase() !== 'korean' ||
      targetLanguage.toLowerCase() !== 'english'
    ) {
      return { text, placeholders };
    }

    let masked = text;
    let index = 0;

    for (const korean of Object.keys(PLACE_NAME_DICTIONARY).sort(
      (a, b) => b.length - a.length,
    )) {
      if (!masked.includes(korean)) continue;
      const token = `@@PLACE${index}@@`;
      placeholders.set(token, PLACE_NAME_DICTIONARY[korean]);
      masked = masked.split(korean).join(token);
      index += 1;
    }

    return { text: masked, placeholders };
  }

  private unmaskPlaceNames(
    text: string,
    placeholders: Map<string, string>,
  ): string {
    let result = text;
    for (const [token, english] of placeholders) {
      result = result.split(token).join(english);
    }
    return result;
  }

  async translateFields(
    fields: Record<string, string>,
    options: TranslationOptions = {},
  ): Promise<Record<string, string>> {
    if (!fields || Array.isArray(fields) || typeof fields !== 'object') {
      throw new BadRequestException(
        'fields는 문자열 값을 가진 객체여야 합니다.',
      );
    }

    const entries = Object.entries(fields);
    if (entries.length === 0) {
      throw new BadRequestException('번역할 fields가 비어 있습니다.');
    }

    const invalidField = entries.find(([, value]) => typeof value !== 'string');
    if (invalidField) {
      throw new BadRequestException(
        `fields.${invalidField[0]} 값은 문자열이어야 합니다.`,
      );
    }

    const translatedEntries = await Promise.all(
      entries.map(async ([key, value]) => [
        key,
        await this.translateText(value, options),
      ]),
    );

    return Object.fromEntries(translatedEntries);
  }

  async translateArticle(
    article: Record<string, any>,
    options: TranslationOptions = {},
  ): Promise<Record<string, string>> {
    const fields = {
      title: String(article.title ?? ''),
      writer: String(article.writer ?? article.author ?? ''),
      content: String(article.content ?? ''),
    };
    const translated = await this.translateFields(fields, options);

    return {
      title_en: translated.title,
      writer_en: translated.writer,
      content_en: translated.content,
    };
  }

  private async requestTranslation(
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<string> {
    const prompt = [
      `Translate the following ${sourceLanguage} news text into ${targetLanguage}.`,
      'Return only the translated text without commentary, labels, or Markdown fences.',
      'Preserve paragraph breaks, URLs, numbers, proper nouns, and the original meaning.',
      'Use a natural, factual news-writing style. Do not summarize or omit content.',
      'If the source contains HTML tags (e.g., <p>, <br>, <a>, <strong>, <ul>, <li>), preserve every tag, attribute, and the overall HTML structure exactly as-is — translate only the human-readable text inside the tags, and do not add, remove, or reorder tags.',
      'Tokens of the form @@PLACEn@@ or @@TERMn@@ are placeholders — copy them to the output exactly as written, without translating, modifying, or removing them.',
      'For any Korean administrative place names that are NOT wrapped in a @@PLACEn@@ placeholder (e.g., 시/도/군/구/읍/면/동/리), romanize them using the Revised Romanization of Korean and keep the administrative unit as a hyphenated suffix (e.g., 옹진군 → Ongjin-gun, 파주시 → Paju-si) instead of translating the suffix into words like "County" or "City".',
      'The "=== TEXT START ===" and "=== TEXT END ===" markers below only delimit the input — they are not part of the content. Do not include them, or any similar marker, in your output.',
      '',
      '=== TEXT START ===',
      text,
      '=== TEXT END ===',
    ].join('\n');

    this.logger.log(`Gemini 번역 API 호출 (${text.length}자, 모델: ${this.modelName})`);
    try {
      const response = await this.ai!.models.generateContent({
        model: this.modelName,
        contents: prompt,
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
        },
      });

      const translated = response.text?.trim() ?? '';
      if (!translated) {
        throw new Error('Gemini가 빈 번역 결과를 반환했습니다.');
      }
      this.logger.log(`Gemini 응답 수신: ${translated.length}자`);
      return translated;
    } catch (error) {
      // "fetch failed"는 껍데기 메시지일 뿐 — 진짜 원인은 error.cause에 들어있다.
      // (예: ECONNRESET / ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT 등 저수준 네트워크 코드)
      const cause: any = (error as any)?.cause;
      const detail = {
        모델: this.modelName,
        글자수: text.length,
        message: (error as Error)?.message,
        name: (error as Error)?.name,
        status: (error as any)?.status ?? (error as any)?.statusCode,
        code: (error as any)?.code ?? cause?.code,
        causeMessage: cause?.message,
        errno: cause?.errno,
        syscall: cause?.syscall,
        address: cause?.address,
        port: cause?.port,
      };
      this.logger.error(
        `Gemini 번역 실패 → ${JSON.stringify(detail, null, 2)}`,
      );
      // 스택까지 콘솔에 그대로 출력 (원인 객체 포함)
      console.error('[TranslationService] Gemini 번역 원본 에러:', error);
      if (cause) {
        console.error('[TranslationService] error.cause:', cause);
      }
      throw new BadGatewayException('Gemini 번역 요청에 실패했습니다.');
    }
  }

  private validateText(text: string): string {
    if (typeof text !== 'string') {
      throw new BadRequestException('text는 문자열이어야 합니다.');
    }
    return text.trim();
  }

  private containsKorean(text: string): boolean {
    return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(text);
  }

  private splitText(text: string): string[] {
    if (text.length <= this.maxChunkLength) return [text];
    if (/<[a-z][\s\S]*?>/i.test(text)) return this.splitHtml(text);

    const paragraphs = text.split(/\n{2,}/);
    const chunks: string[] = [];
    let current = '';

    for (const paragraph of paragraphs) {
      if (paragraph.length > this.maxChunkLength) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        chunks.push(...this.splitLongParagraph(paragraph));
        continue;
      }

      const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
      if (candidate.length > this.maxChunkLength) {
        chunks.push(current);
        current = paragraph;
      } else {
        current = candidate;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  // HTML 콘텐츠를 테이블 바깥의 블록 요소 경계에서만 분할
  // 테이블 내부의 </p>, </tr> 등에서 자르면 Gemini가 구조를 망가뜨리므로 절대 하지 않음
  private splitHtml(text: string): string[] {
    const topBreaks: number[] = [];
    let tableDepth = 0;

    const tokenRegex = /<(\/?)(?:table|ul|ol|div|section|article|p|br)\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(text)) !== null) {
      const isClosing = match[1] === '/';
      const tagName = match[0].replace(/<\/?([a-z]+).*/i, '$1').toLowerCase();

      if (tagName === 'br') {
        if (tableDepth === 0) topBreaks.push(match.index + match[0].length);
      } else if (tagName === 'table') {
        if (isClosing) {
          tableDepth = Math.max(0, tableDepth - 1);
          if (tableDepth === 0) topBreaks.push(match.index + match[0].length);
        } else {
          tableDepth++;
        }
      } else if (tableDepth === 0 && isClosing) {
        topBreaks.push(match.index + match[0].length);
      }
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = start + this.maxChunkLength;
      if (end >= text.length) {
        chunks.push(text.slice(start));
        break;
      }

      // 한계 내에서 자를 수 있는 가장 뒤쪽 경계 탐색
      const lastBreak = topBreaks.filter(pos => pos > start && pos <= end).pop();
      if (lastBreak) {
        chunks.push(text.slice(start, lastBreak));
        start = lastBreak;
      } else {
        // 한계 내에 경계가 없으면 다음 경계까지 늘림 (테이블 파손 방지)
        const nextBreak = topBreaks.find(pos => pos > end);
        if (nextBreak) {
          chunks.push(text.slice(start, nextBreak));
          start = nextBreak;
        } else {
          chunks.push(text.slice(start));
          break;
        }
      }
    }

    return chunks.filter(c => c.trim().length > 0);
  }

  private splitLongParagraph(paragraph: string): string[] {
    const chunks: string[] = [];
    let remaining = paragraph;

    while (remaining.length > this.maxChunkLength) {
      const searchArea = remaining.slice(0, this.maxChunkLength + 1);
      const sentenceBreak = Math.max(
        searchArea.lastIndexOf('. '),
        searchArea.lastIndexOf('다. '),
        searchArea.lastIndexOf('요. '),
        searchArea.lastIndexOf('! '),
        searchArea.lastIndexOf('? '),
      );
      const whitespaceBreak = searchArea.lastIndexOf(' ');
      const splitAt =
        sentenceBreak > this.maxChunkLength * 0.5
          ? sentenceBreak + 1
          : whitespaceBreak > this.maxChunkLength * 0.5
            ? whitespaceBreak
            : this.maxChunkLength;

      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
  }

  private readPositiveNumber(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }
}
