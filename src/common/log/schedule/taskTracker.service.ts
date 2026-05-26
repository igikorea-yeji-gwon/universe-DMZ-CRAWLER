import { Injectable } from '@nestjs/common';
import { S3Service } from 'src/aws/s3/s3.service';

@Injectable()
export class TaskTrackerService {
  private logs = new Map<number, Record<string, any>>();
  private nextId = 1;

  constructor(private readonly s3Service: S3Service) {}

  async create(configId: number): Promise<number> {
    const id = this.nextId++;
    this.logs.set(id, {
      id,
      configId,
      startedAt: new Date().toISOString(),
      success: false,
      message: '진행중...',
    });
    return id;
  }

  async complete(id: number, itemCount: number): Promise<void> {
    const log = this.logs.get(id);
    if (!log) return;
    const updated = {
      ...log,
      endedAt: new Date().toISOString(),
      itemCount,
      success: true,
      message: '스크랩 완료',
    };
    this.logs.set(id, updated);
    await this.s3Service.saveLogToS3(log.configId, updated).catch(() => {});
    this.logs.delete(id);
  }

  async fail(id: number, _step: string, error: any): Promise<void> {
    const log = this.logs.get(id);
    if (!log) return;
    const updated = {
      ...log,
      endedAt: new Date().toISOString(),
      success: false,
      message: `실패: ${error?.message ?? 'Unknown error'}`,
    };
    this.logs.set(id, updated);
    await this.s3Service.saveLogToS3(log.configId, updated).catch(() => {});
    this.logs.delete(id);
  }
}
