import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class TranslationOptionsDto {
  @IsOptional()
  @IsString()
  sourceLanguage?: string = 'Korean';

  @IsOptional()
  @IsString()
  targetLanguage?: string = 'English';
}

export class TranslateTextDto extends TranslationOptionsDto {
  @IsString()
  @IsNotEmpty()
  text: string;
}

export class TranslateFieldsDto extends TranslationOptionsDto {
  @IsObject()
  fields: Record<string, string>;
}

export class TranslateArticleDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  writer?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TranslationOptionsDto)
  options?: TranslationOptionsDto;
}
