import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  initScraperRequest,
  PagedResult,
  scrapConfig,
  ScrapConfigAllData,
} from './types/scraper.type';
import { omit } from 'lodash';
import { ScraperService } from './scraper.service';
import { JsonConfigService } from './json-config.service';
import { S3Service } from '../aws/s3/s3.service';
import { WorkflowResult } from 'src/news/news.entity';
import { TaskTrackerService } from 'src/common/log/schedule/taskTracker.service';
import { OpenAIService } from 'src/openai/opneai.service';
import {
  initDetailJson,
  initListJson,
} from 'src/openai/openai.entity';
import { ListConfigDto, ListLogDto, ScrapedDataDto } from './dto/scraperDtos';

@Injectable()
export class ScraperConfigService implements OnModuleInit {
  private readonly logger = new Logger(ScraperConfigService.name);

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private scraperService: ScraperService,
    private s3Service: S3Service,
    private taskTracker: TaskTrackerService,
    private openAIService: OpenAIService,
    private jsonConfigService: JsonConfigService,
  ) {}

  async fondOneScrapedDate(_id: number) {
    return [];
  }

  async findScrapData(dto: ScrapedDataDto): Promise<PagedResult<any>> {
    const { pageSize = 10, pageNumber = 1 } = dto;
    return { total: 0, pageSize, pageNumber, data: [] };
  }

  async onModuleInit() {}

  async getScraperTargets() {
    return this.jsonConfigService.findAll();
  }

  async getFindManyByUserIdScraperConfig({ pageSize, pageNumber, userId }) {
    const { data } = this.jsonConfigService.findMany({ pageSize, pageNumber });
    return data;
  }

  async getFindOneByIdScraperConfig(id: number) {
    return this.jsonConfigService.findById(id) ?? null;
  }

  private async syncCronJobs(config: scrapConfig) {
    const { scheduleTime, enabled } = config;

    // 2‑1) 먼저 모든 시간대에 대해 삭제 로직 실행
    //     deleteCronJob 내부에서 enabled=true인 경우 삭제를 건너뜀
    for (const time of config.scheduleTime) {
      await this.deleteCronJob(time);
    }

    // 2‑2) enabled가 true인 scheduleTime만 다시 등록
    if (enabled) {
      for (const time of scheduleTime) {
        this.setCronJobForTime(time);
      }
    }
  }

  async updateOneScraperConfig(newConfig: scrapConfig) {
    const updatedConfig = this.jsonConfigService.update(newConfig);

    // 2) 스케줄 동기화
    await this.syncCronJobs(newConfig);

    return updatedConfig;
  }

  async deleteOneScraperConfig(id: number) {
    try {
      const deletedConfig = this.jsonConfigService.delete(id);
      for (const time of deletedConfig.scheduleTime) {
        await this.deleteCronJob(time);
      }
      return true;
    } catch {
      return false;
    }
  }

  async getScraperSchedule() {
    const jobs = this.schedulerRegistry.getCronJobs();
    console.log('jobs', jobs);

    jobs.forEach((job, name) => {
      console.log(`Job 이름: ${name}, 다음 실행 시간: ${job.nextDate()}`);
    });
    return [...jobs.keys()];
  }

  /**
   * 신규 스크래퍼 대상을 동적으로 작업을 등록합니다.
   */
  async addNewScheduleScraperJobs(target: scrapConfig): Promise<boolean> {
    try {
      const configWithoutId = omit(target, 'id') as scrapConfig;
      const newConfig = this.jsonConfigService.create(configWithoutId);

      for (const time of newConfig.scheduleTime) {
        try {
          this.setCronJobForTime(time);
        } catch (cronErr) {
          this.logger.error(
            `⛔️ CronJob 등록 실패 (ID: ${newConfig.id})`,
            cronErr.stack || cronErr,
          );
          throw new InternalServerErrorException(`크론 잡 등록 실패 (${time})`);
        }
      }

      this.logger.log(`✅ 스케줄러 등록 완료: ${newConfig.id}`);
      return true;
    } catch (err) {
      this.logger.error(`💥 Unknown Error: ${err.message}`, err.stack);
      throw new InternalServerErrorException(
        '스케줄 등록 중 알 수 없는 오류가 발생했습니다.',
      );
    }
  }

  setCronJobForTime(time: string): void {
    // 빈 값, undefined, 유효하지 않은 시간 형식 skip
    if (!time || !/^\d{1,2}:\d{2}$/.test(time)) {
      const logger = new Logger('setCronJob');
      logger.warn(`⚠️ 유효하지 않은 스케줄 시간 무시: "${time}"`);
      return;
    }
    const jobId = `scraper-${time}`;
    const cronTime = this.getCronExpressionForTime(time);
    const logger = new Logger('setCronJob');
    let isRunning = false;

    if (this.schedulerRegistry.getCronJobs().has(jobId)) {
      logger.warn(`⚠️ 기존 Job ${jobId} 제거 후 재등록`);
      const existingJob = this.schedulerRegistry.getCronJob(jobId);
      existingJob.stop();
      this.schedulerRegistry.deleteCronJob(jobId);
    }

    // const job = new CronJob(cronTime, () => {
    //   try {
    //     this.runScraper(time); // 단일 시간 기준 실행
    //   } catch (err) {
    //     logger.error(
    //       `⛔️ runScraper 실패 (${jobId}): ${err.message}`,
    //       err.stack,
    //     );
    //   }
    // });
    const job = new CronJob(
      cronTime,
      async () => {
        if (isRunning) {
          logger.warn(`⏭️ ${jobId} 이미 실행 중, 스킵`);
          return;
        }
        isRunning = true;
        try {
          await this.runScraper(time);
        } catch (err) {
          logger.error(`⛔️ runScraper 실패 (${jobId}): ${err.message}`);
        } finally {
          isRunning = false;
        }
      },
      null,
      false,
      'Asia/Seoul',
    );

    this.schedulerRegistry.addCronJob(jobId, job);
    job.start();

    logger.log(`[등록됨] ${jobId}`);
  }

  deleteCronJob = async (scheduleTime: string): Promise<void> => {
    const jobId = `scraper-${scheduleTime}`;
    const logger = new Logger('deleteCronJob');

    // 해당 scheduleTime으로 활성화된 config가 남아있으면 삭제하지 않음
    const count = this.jsonConfigService.countByScheduleTimeAndEnabled(scheduleTime);
    if (count > 0) {
      logger.log(`✅ 활성화된 scheduleTime(${scheduleTime}) 존재. 삭제하지 않음.`);
      return;
    }

    try {
      // ✅ 스케줄러에 등록된 잡 중 해당 시간대 삭제
      if (this.schedulerRegistry.getCronJobs().has(jobId)) {
        logger.warn(`⚠️ 기존 Job ${jobId} 제거`);
        const existingJob = this.schedulerRegistry.getCronJob(jobId);
        existingJob.stop();
        this.schedulerRegistry.deleteCronJob(jobId);
      }

      logger.log(
        `[제거됨] ${jobId} → ${this.schedulerRegistry.getCronJobs().has(jobId)}`,
      );
    } catch (err) {
      logger.error(
        `⛔️ Cron 제거 실패 (jobId: ${jobId}): ${err.message}`,
        err.stack,
      );
      throw new InternalServerErrorException(`크론 작업 제거 실패: ${jobId}`);
    }
  };

  /** HH:mm → Cron 표현식 변환. 예: "14:30" → "0 30 14 * * *" */
  private getCronExpressionForTime(time: string): string {
    const [hour, minute] = time.split(':');
    return `0 ${minute} ${hour} * * *`;
  }

  async runScraper(scheduleTime): Promise<void> {
    if (!scheduleTime) scheduleTime = '14:30';
    const scheduleConfigs = this.jsonConfigService.findByScheduleTimeAndEnabled(scheduleTime);

    // 스크랩 동작
    for (const config of scheduleConfigs) {
      const taskId = await this.taskTracker.create(config.id);

      try {
        const scraperResult: WorkflowResult =
          await this.scraperService.runWorkflow(config);

        const index = scraperResult.data.filter((d) => d?.title?.trim()).length;
        this.jsonConfigService.updateLastExecutedAt(config.id);
        await this.taskTracker.complete(taskId, index);
        this.logger.log(`✅ 스크래핑 완료 (${config.name}) - ${index}건`);
      } catch (err) {
        await this.taskTracker.fail(taskId, 'scrape-or-save-step', err);
        this.logger.error(
          `💥 스크래핑 실패 (${config.name}): ${err.message}`,
          err.stack,
        );
      }

      this.logger.log('🫶😆 스크래핑 완료');
    }
  }

  async runTestScraper(id: number, testConfig?: scrapConfig) {
    let scheduleConfigs;
    if (id) {
      const found = this.jsonConfigService.findById(id);
      scheduleConfigs = found ? [found] : [];
    } else {
      scheduleConfigs = [testConfig];
    }

    let scraperResult: WorkflowResult;
    for (const config of scheduleConfigs) {
      const taskId = await this.taskTracker.create(config.id);
      try {
        scraperResult = await this.scraperService.runWorkflow(config);
        const index = scraperResult.data.filter((d) => d?.title?.trim()).length;
        this.jsonConfigService.updateLastExecutedAt(config.id);
        await this.taskTracker.complete(taskId, index);
        this.logger.log(`✅ 스크래핑 완료 (${config.name}) - ${index}건`);
      } catch (err) {
        await this.taskTracker.fail(taskId, 'scrape-or-save-step', err);
        this.logger.error(`💥 스크래핑 실패 (${config.name}): ${err.message}`, err.stack);
      }
    }
    return scraperResult?.data;
  }

  async getValidJson(prompt: string, maxAttempts = 3): Promise<any> {
    let attempts = 0;
    while (attempts < maxAttempts) {
      const response = await this.openAIService.askQuestion(prompt);

      console.log('이거보자 222', response);

      try {
        const parsed = JSON.parse(response);
        return parsed;
      } catch (error) {
        console.log('error', error);
        attempts++;
        console.warn(`JSON 파싱 실패, 재시도 ${attempts}회`);
        if (attempts >= maxAttempts) {
          throw new Error(
            '최대 재시도 횟수를 초과하였습니다. 유효한 JSON을 반환받지 못했습니다.',
          );
        }
      }
    }
    // 실제로 루프를 빠져나오지 않지만, TS 용으로 추가합니다.
    throw new Error('알 수 없는 오류');
  }

  async initTeagetScraperConfig(requestBody: initScraperRequest): Promise<any> {
    let listHtml = await this.scraperService.fetchHtml(
      false,
      requestBody.searchUrl,
    );
    listHtml = await this.scraperService.getCleanHtml(listHtml, false);
    let detailHtml = await this.scraperService.fetchHtml(
      false,
      requestBody.detailsUrl,
    );
    detailHtml = await this.scraperService.getCleanHtml(detailHtml, true);
    const listPrompt = this.openAIService.buildListPrompt({
      exampleJson: JSON.stringify(initListJson),
      url: requestBody.searchUrl,
      dUrl: requestBody.detailsUrl,
      html: listHtml,
    });

    const detailPrompt = this.openAIService.buildDetailPrompt({
      exampleJson: JSON.stringify(initDetailJson),
      url: requestBody.detailsUrl,
      html: detailHtml,
    });

    // const listJson = JSON.parse(
    //   await this.openAIService.askQuestion(listPrompt),
    // );

    // const detailJson = JSON.parse(
    //   await this.openAIService.askQuestion(detailPrompt),
    // );

    const listJson = await this.getValidJson.call(this, listPrompt);
    const detailJson = await this.getValidJson.call(this, detailPrompt);

    console.log('이거 보자', listJson);

    // // ✅ 프롬프트 파일로 저장
    // const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    // const fileName = `prompt-${timestamp}.txt`;
    // const filePath = path.join(__dirname, './prompts', fileName);

    // fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // fs.writeFileSync(filePath, prompt, 'utf8');

    // console.log('프롬프트 저장 완료:', filePath);

    return { ...listJson, ...detailJson };
  }

  async getLogById(_id: number) {
    return null;
  }

  async getLatestLogs(_limit = 20) {
    return [];
  }

  async listConfigs(
    dto: ListConfigDto,
  ): Promise<PagedResult<ScrapConfigAllData>> {
    const { pageSize, pageNumber, searchType, searchKeyword, startDate, endDate } = dto;
    const { total, data } = this.jsonConfigService.findMany({
      pageSize,
      pageNumber,
      searchType,
      searchKeyword,
      startDate,
      endDate,
    });
    return { data, total, pageSize, pageNumber };
  }

  async listLogs(dto: ListLogDto) {
    const { pageSize, pageNumber } = dto;
    return { total: 0, pageSize, pageNumber, data: [] };
  }

  async runScrep(id?) {
    const found = this.jsonConfigService.findById(Number(id) ?? 7);
    const scheduleConfigs = found ? [found] : [];

    const scraperResult: WorkflowResult = await this.scraperService.runWorkflow(
      scheduleConfigs[0],
    );

    this.jsonConfigService.updateLastExecutedAt(scraperResult.configId);
    this.logger.log(`✅ 스크래핑 완료 - ${scraperResult.data.length}건`);

    return scraperResult.data;
  }

  /**
   * 신규 스크래퍼 대상을 동적으로 작업을 등록합니다.
   */
  async addScrapeConfigAndJobs(target: scrapConfig): Promise<boolean> {
    try {
      const configWithoutId = omit(target, 'id') as scrapConfig;
      const newConfig = this.jsonConfigService.create(configWithoutId);

      // for (const time of newConfig.scheduleTime) {
      //   try {
      //     this.setCronJobForTime(time);
      //   } catch (cronErr) {
      //     this.logger.error(
      //       `⛔️ CronJob 등록 실패 (ID: ${newConfig.id})`,
      //       cronErr.stack || cronErr,
      //     );
      //     // 상황에 따라 예외 던지기 or 무시하고 진행
      //     throw new InternalServerErrorException(`크론 잡 등록 실패 (${time})`);
      //   }
      // }

      this.logger.log(`✅ 스케줄러 등록 완료: ${newConfig.id}`);
      return true;
    } catch (err) {
      this.logger.error(`💥 Unknown Error: ${err.message}`, err.stack);
      throw new InternalServerErrorException(
        '스케줄 등록 중 알 수 없는 오류가 발생했습니다.',
      );
    }
  }

  async videoTest() {
    const pageUrl =
      // 'https://munitv.unikorea.go.kr/unitv/web/vod/view.do?id=6367&aid=18';
      'https://www.rfa.org/english/video/united-nations-general-assembly-holds-session-on-human-rights-abuses-in-north-korea/';
    this.scraperService.videoScrap(pageUrl);
  }

  async getScrapData(dto: ScrapedDataDto) {
    const { pageSize = 10, pageNumber = 1 } = dto;
    return { total: 0, pageSize, pageNumber, data: [] };
  }
}
