import { defineConfig } from 'vitest/config';
import * as path from 'path';

// tsconfig baseUrl('./') 기반의 'src/...' 절대 임포트를 vitest에서도 해석하게 한다
export default defineConfig({
  resolve: {
    alias: {
      src: path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    // 기존 스펙(app.controller.spec.ts)이 Jest 전역 스타일(describe/it)을 쓰므로 전역 주입
    globals: true,
  },
});
