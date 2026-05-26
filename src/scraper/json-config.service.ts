import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { scrapConfig, ScrapConfigAllData } from './types/scraper.type';

// SCRAPE_CONFIG_DIR 환경변수로 경로 변경 가능, 기본값은 프로젝트 루트의 scrape-configs/
const CONFIG_DIR =
  process.env.SCRAPE_CONFIG_DIR ??
  path.join(process.cwd(), 'scrape-configs');

@Injectable()
export class JsonConfigService implements OnModuleInit {
  private readonly logger = new Logger(JsonConfigService.name);

  /** 인메모리 캐시: id → config */
  private cache = new Map<number, ScrapConfigAllData>();

  onModuleInit() {
    this.loadAll();
  }

  // ---------------------------------------------------------------------------
  // 내부 유틸
  // ---------------------------------------------------------------------------

  private filePath(id: number): string {
    return path.join(CONFIG_DIR, `${id}.json`);
  }

  private loadAll(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      this.logger.warn(`⚠️ ${CONFIG_DIR} 폴더가 없어 새로 생성했습니다.`);
    }

    const files = fs.readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.json'));
    this.cache.clear();

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(CONFIG_DIR, file), 'utf-8');
        const config = JSON.parse(raw) as ScrapConfigAllData;
        this.cache.set(config.id, config);
      } catch (e) {
        this.logger.error(`❌ ${file} 파싱 실패: ${e.message}`);
      }
    }

    this.logger.log(`✅ scrape-configs 로드 완료 (${this.cache.size}개)`);
  }

  private writeFile(config: ScrapConfigAllData): void {
    fs.writeFileSync(
      this.filePath(config.id),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
  }

  // ---------------------------------------------------------------------------
  // 조회
  // ---------------------------------------------------------------------------

  findAll(): ScrapConfigAllData[] {
    return [...this.cache.values()];
  }

  findById(id: number): ScrapConfigAllData | undefined {
    return this.cache.get(id);
  }

  findByScheduleTimeAndEnabled(scheduleTime: string): ScrapConfigAllData[] {
    return this.findAll().filter(
      (c) => c.enabled && c.scheduleTime.includes(scheduleTime),
    );
  }

  countByScheduleTimeAndEnabled(scheduleTime: string): number {
    return this.findByScheduleTimeAndEnabled(scheduleTime).length;
  }

  findMany(opts: {
    pageSize: number;
    pageNumber: number;
    searchType?: string;
    searchKeyword?: string;
    startDate?: string;
    endDate?: string;
  }): { total: number; data: ScrapConfigAllData[] } {
    let list = this.findAll();

    // 텍스트 필터
    if (opts.searchType && opts.searchKeyword) {
      const kw = opts.searchKeyword.toLowerCase();
      list = list.filter((c) =>
        String(c[opts.searchType] ?? '').toLowerCase().includes(kw),
      );
    }

    // 날짜 범위 필터 (createdAt 기준)
    if (opts.startDate && opts.endDate) {
      const gte = new Date(opts.startDate).getTime();
      const lte = new Date(opts.endDate).getTime();
      list = list.filter((c) => {
        const t = new Date(c.createdAt).getTime();
        return t >= gte && t <= lte;
      });
    }

    const total = list.length;
    const sorted = list.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const data = sorted.slice(
      (opts.pageNumber - 1) * opts.pageSize,
      opts.pageNumber * opts.pageSize,
    );

    return { total, data };
  }

  // ---------------------------------------------------------------------------
  // 변경
  // ---------------------------------------------------------------------------

  create(config: scrapConfig): ScrapConfigAllData {
    const maxId = this.cache.size
      ? Math.max(...this.cache.keys())
      : 0;
    const now = new Date().toISOString();
    const newConfig: ScrapConfigAllData = {
      ...config,
      id: maxId + 1,
      createdAt: now as any,
      updatedAt: now as any,
    };
    this.cache.set(newConfig.id, newConfig);
    this.writeFile(newConfig);
    this.logger.log(`✅ config 생성: id=${newConfig.id} (${newConfig.name})`);
    return newConfig;
  }

  update(config: scrapConfig): ScrapConfigAllData {
    const existing = this.cache.get(config.id);
    if (!existing) throw new Error(`Config id=${config.id} not found`);

    const updated: ScrapConfigAllData = {
      ...existing,
      ...config,
      updatedAt: new Date().toISOString() as any,
    };
    this.cache.set(updated.id, updated);
    this.writeFile(updated);
    this.logger.log(`✅ config 수정: id=${updated.id}`);
    return updated;
  }

  delete(id: number): ScrapConfigAllData {
    const existing = this.cache.get(id);
    if (!existing) throw new Error(`Config id=${id} not found`);

    this.cache.delete(id);
    const file = this.filePath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.logger.log(`✅ config 삭제: id=${id}`);
    return existing;
  }

  updateLastExecutedAt(id: number): void {
    const existing = this.cache.get(id);
    if (!existing) return;

    const updated: ScrapConfigAllData = {
      ...existing,
      lastExecutedAt: new Date().toISOString() as any,
      updatedAt: new Date().toISOString() as any,
    };
    this.cache.set(id, updated);
    this.writeFile(updated);
  }
}
