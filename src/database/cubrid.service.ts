import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as CubridClient from 'node-cubrid';

@Injectable()
export class CubridService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CubridService.name);
  private connection: any;
  private connected = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    try {
      await this.connect();
    } catch (err) {
      this.logger.error(`초기 Cubrid 연결 실패 (쿼리 시점에 재시도): ${err.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.connection) {
      await new Promise<void>((resolve) => {
        this.connection.close(() => resolve());
      });
    }
  }

  private parseJdbcUrl(url: string): { host: string; port: number; dbname: string } {
    const cleaned = url.replace(/^jdbc:cubrid:/i, '').replace(/^cubrid:\/\//i, '');
    const parts = cleaned.split(':');
    return {
      host: parts[0] || 'localhost',
      port: parseInt(parts[1], 10) || 33000,
      dbname: parts[2] || 'demodb',
    };
  }

  private async connect(): Promise<void> {
    const rawUrl   = this.configService.get<string>('DB_Url') ?? '';
    const user     = this.configService.get<string>('DB_UserName') ?? 'dba';
    const password = this.configService.get<string>('DB_Password') ?? '';

    const { host, port, dbname } = this.parseJdbcUrl(rawUrl);
    this.connection = CubridClient.createCUBRIDConnection(host, port, user, password, dbname);
    this.connected  = false;

    await new Promise<void>((resolve, reject) => {
      this.connection.connect((err: Error | null) => {
        if (err) {
          this.logger.error(`Cubrid 연결 실패: ${err.message}`);
          reject(err);
        } else {
          this.connected = true;
          this.logger.log(`Cubrid 연결 성공 (${host}:${port}/${dbname})`);
          resolve();
        }
      });
    });
  }

  private async ensureConnection(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  async execute(sql: string, params: any[] = []): Promise<void> {
    await this.ensureConnection();
    return new Promise((resolve, reject) => {
      this.connection.execute(sql, params, (err: Error | null) => {
        if (err) {
          if (err.message?.includes('ECONNRESET') || err.message?.includes('ECONNREFUSED') || err.message?.includes('ETIMEDOUT')) {
            this.connected = false;
          }
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async queryAll(sql: string): Promise<any[]> {
    await this.ensureConnection();
    return new Promise((resolve, reject) => {
      this.connection.queryAllAsObjects(sql, (err: Error | null, result: any) => {
        if (err) {
          if (err.message?.includes('ECONNRESET') || err.message?.includes('ECONNREFUSED') || err.message?.includes('ETIMEDOUT')) {
            this.connected = false;
          }
          reject(err);
        } else {
          resolve(Array.isArray(result) ? result : []);
        }
      });
    });
  }
}
