import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class IsbnBookInfoDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^(?:\d{9}[\dXx]|\d{13})$/, {
    message: 'isbn은 하이픈이 제거된 ISBN-10 또는 ISBN-13이어야 합니다.',
  })
  isbn: string;
}
