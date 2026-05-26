
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeminiAnalyzerService } from './gemini-analyzer.service';

@Module({
  imports: [ConfigModule],
  providers: [GeminiAnalyzerService],
  exports: [GeminiAnalyzerService],
})
export class GeminiAnalyzerModule {}