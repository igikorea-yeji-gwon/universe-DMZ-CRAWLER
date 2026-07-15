import { ConfigService } from '@nestjs/config';

/**
 * 전역 스케줄링(정기 수집 크론) 활성화 여부.
 * 환경변수 SCHEDULING_ENABLED 로 제어하며, 미설정 시 기본 켜짐(true).
 * 'false' | '0' | 'off' | 'no'(대소문자 무관)이면 꺼짐.
 *
 * 로컬 개발에서 앱 기동 시마다 수집이 도는 걸 막을 때 SCHEDULING_ENABLED=false 로 둔다.
 * 크론만 끌 뿐, 수동 실행 API(/scraper/run, /scraper/yna/collect 등)는 그대로 동작한다.
 */
export function isSchedulingEnabled(configService: ConfigService): boolean {
  const raw = String(configService.get('SCHEDULING_ENABLED') ?? 'true')
    .trim()
    .toLowerCase();
  return !['false', '0', 'off', 'no'].includes(raw);
}
