// author: kodeholic (powered by Claude)
// 3층 — 실 인코더·실 디코딩. 정적 서버는 자체 기동한다(라이브 리로드가 붙으면 실행 맥락이 죽는다).
import { defineConfig } from '@playwright/test'

const PORT = 5599

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  // ★갈래B 는 정규 게이트와 섞지 않는다 — "의도된 빨강" 과 "회귀 빨강" 이 같은 색이 된다.
  projects: [
    { name: 'chromium', testIgnore: /fault\//, use: { browserName: 'chromium' } },
    { name: 'chromium-fault', testMatch: /fault\//, use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: `npx --yes http-server ../.. -p ${PORT} -c-1 --silent`,
    port: PORT,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
