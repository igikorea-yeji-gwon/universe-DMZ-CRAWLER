export enum ScraperLogStatus {
  CREATED = 'CREATED',
  STARTED = 'STARTED',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

export interface ScraperLogEntry {
  id: string;
  scheduleTime: string;
  taskName: string;
  status: ScraperLogStatus;
  startedAt?: Date;
  endedAt?: Date;
  duration?: number;
  errorMessage?: string;
  stack?: string;
  step?: string; // 어느 단계에서 실패했는지
}
