import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsbnBookInfoDto } from './dto/isbn.dto';
import { IsbnService } from './isbn.service';

@ApiTags('Isbn')
@Controller('isbn')
export class IsbnController {
  constructor(private readonly isbnService: IsbnService) {}

  @Post('book-info')
  @ApiOperation({
    summary: 'ISBN으로 표지 URL·서지정보 조회 (국립중앙도서관 SEOJI)',
  })
  @ApiBody({
    schema: {
      example: {
        isbn: '9791190626187',
      },
    },
  })
  async getBookInfo(@Body() dto: IsbnBookInfoDto) {
    return this.isbnService.getBookInfo(dto.isbn);
  }
}
