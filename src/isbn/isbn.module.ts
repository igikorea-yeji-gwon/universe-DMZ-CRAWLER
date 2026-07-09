import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IsbnController } from './isbn.controller';
import { IsbnService } from './isbn.service';

@Module({
  imports: [ConfigModule],
  controllers: [IsbnController],
  providers: [IsbnService],
  exports: [IsbnService],
})
export class IsbnModule {}
