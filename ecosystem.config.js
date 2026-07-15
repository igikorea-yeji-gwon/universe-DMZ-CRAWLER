// pm2 배포 설정 (수집 앱)
// 실행:   pm2 start ecosystem.config.js
// 재시작: pm2 reload dmz-scraper
// 로그:   pm2 logs dmz-scraper
//
// ⚠️ cluster 모드/다중 인스턴스 금지:
//    YNA 5분 크론과 config별 CronJob이 중복 발화하고 Playwright 브라우저가 중복 생성됨.
//    반드시 fork 모드 + instances 1 로 단일 프로세스 유지.
module.exports = {
  apps: [
    {
      name: 'dmz-scraper',
      script: 'dist/main.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
