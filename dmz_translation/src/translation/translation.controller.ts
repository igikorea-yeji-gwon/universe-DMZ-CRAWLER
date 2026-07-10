import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  TranslateArticleDto,
  TranslateFieldsDto,
  TranslateTextDto,
} from './dto/translation.dto';
import { TranslationService } from './translation.service';

@ApiTags('Translation')
@Controller('translation')
export class TranslationController {
  constructor(private readonly translationService: TranslationService) {}

  @Post('text')
  @ApiOperation({ summary: '단일 텍스트 번역' })
  @ApiBody({
    schema: {
      example: {
        text: '비무장지대 생태 관광 프로그램이 시작됩니다.',
        sourceLanguage: 'Korean',
        targetLanguage: 'English',
      },
    },
  })
  async translateText(@Body() dto: TranslateTextDto) {
    return {
      translatedText: await this.translationService.translateText(
        dto.text,
        dto,
      ),
    };
  }

  @Post('fields')
  @ApiOperation({ summary: 'CMS 게시물의 여러 필드를 한 번에 번역' })
  @ApiBody({
    schema: {
      example: {
        fields: {
          title: 'DMZ 평화의 길 운영 안내',
          content: '비무장지대 생태 관광 프로그램이 시작됩니다.',
        },
        sourceLanguage: 'Korean',
        targetLanguage: 'English',
      },
    },
  })
  async translateFields(@Body() dto: TranslateFieldsDto) {
    return this.translationService.translateFields(dto.fields, dto);
  }

  @Post('article')
  @ApiOperation({ summary: '뉴스 기본 필드를 영문 컬럼명으로 번역' })
  @ApiBody({
    schema: {
      example: {
        title: 'DMZ 평화의 길 운영 안내',
        writer: '홍길동 기자',
        content: '비무장지대 생태 관광 프로그램이 시작됩니다.',
      },
    },
  })
  async translateArticle(@Body() dto: TranslateArticleDto) {
    return this.translationService.translateArticle(dto, dto.options);
  }
}
