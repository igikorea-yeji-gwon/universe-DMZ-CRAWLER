import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class GoogleChatService {
  private readonly logger = new Logger(GoogleChatService.name);
  private readonly webhookUrl = process.env.GOOGLE_WEB_HOOK ?? '';

  async sendAlert(title: string, details: Record<string, string>, webhook = true, webhookType: 'default' | 'timeout' = 'default') {
    if (!webhook) return;
    const lines = Object.entries(details)
      .map(([key, val]) => `*${key}:* ${val}`)
      .join('\n');

    const text = `🚨 *${title}*\n${lines}`;

    const isTimeout = webhookType === 'timeout'
      || title.includes('타임아웃')
      || Object.values(details).some((v) => v.includes('Timeout'));

    const url = isTimeout
      ? (process.env.GOOGLE_WEB_HOOK_TIMEOUT ?? this.webhookUrl)
      : this.webhookUrl;

    try {
      await axios.post(url, { text });
    } catch (e) {
      this.logger.warn(`Google Chat 알림 전송 실패: ${(e as Error).message}`);
    }
  }
}
