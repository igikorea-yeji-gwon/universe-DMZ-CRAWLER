import { IsOptional, Min, IsString, IsInt, IsISO8601 } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pageNumber?: number;
}

export class DateRangeDto {
  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;
}

export class ScraperListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  userId?: string;
}

// export class ScrapedDataDto extends PaginationQueryDto {
//   @IsOptional()
//   @Type(() => Number)
//   @IsInt()
//   configId?: number;
// }

export class ScrapedDataTransformDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  configId?: number;
}

export class ListConfigDto {
  @IsInt() @Type(() => Number) @Min(1) pageSize: number;
  @IsInt() @Type(() => Number) @Min(1) pageNumber: number;
  @IsOptional() @IsString() searchType?: string;
  @IsOptional() @IsString() searchKeyword?: string;
  @IsOptional() @IsString() startDate?: string;
  @IsOptional() @IsString() endDate?: string;
}

export class ListLogDto {
  @IsInt() @Type(() => Number) @Min(1) pageSize: number;
  @IsInt() @Type(() => Number) @Min(1) pageNumber: number;
  @IsOptional() @IsString() searchType?: string; // 예: 'configName' or 'message'
  @IsOptional() @IsString() searchKeyword?: string; // 키워드
  @IsOptional() @IsString() startDate?: string; // ISO 날짜
  @IsOptional() @IsString() endDate?: string;
}

export class ScrapedDataDto {
  @IsOptional()
  @Type(() => Number)
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  pageSize?: number = 10;

  @IsOptional()
  @Type(() => Number)
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  pageNumber?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  configId?: number;

  @IsOptional()
  @IsString()
  searchType?: 'title' | 'author' | 'content';

  @IsOptional()
  @IsString()
  searchKeyword?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  // @IsOptional()
  // @Type(() => Number)
  // @IsInt()
  // id?: number;
}
