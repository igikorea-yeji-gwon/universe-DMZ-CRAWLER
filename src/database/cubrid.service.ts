import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CUBRID = require('node-cubrid');

/**
 * node-cubrid 커넥션 팩토리.
 * CUBRID는 커넥션당 요청을 순차 처리하므로 요청 단위로 클라이언트를 생성해 쓰고 닫는다.
 */
@Injectable()
export class CubridService {
  constructor(private readonly configService: ConfigService) {}

  createClient(): any {
    return CUBRID.createConnection({
      host: this.configService.get<string>('CUBRID_HOST'),
      port: Number(this.configService.get('CUBRID_PORT') ?? 33000),
      user: this.configService.get<string>('CUBRID_USER'),
      password: this.configService.get<string>('CUBRID_PASSWORD') ?? '',
      database: this.configService.get<string>('CUBRID_DATABASE'),
      connectionTimeout: 10_000,
    });
  }
}
