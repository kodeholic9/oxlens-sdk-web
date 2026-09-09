// author: kodeholic (powered by Claude)
// 3층 — 실 인코더·실 디코딩. 정적 서버는 자체 기동한다(라이브 리로드가 붙으면 실행 맥락이 죽는다).
import { defineConfig } from '@playwright/test'

const PORT = 5599

/** 가짜 장치·자동재생 — 브라우저마다 손잡이가 다르다. */
const CHROMIUM_MEDIA = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  // ★화면공유(getDisplayMedia)도 물어보지 않고 고르게 한다 — 연§9-10-3 2② 의 셋째 자리 축.
  '--auto-select-desktop-capture-source=Entire screen',
  '--allow-http-screen-capture',
]
const FIREFOX_MEDIA = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
  'media.autoplay.default': 0,
  'media.autoplay.blocking_policy': 0,
}

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  // ★갈래B 는 정규 게이트와 섞지 않는다 — "의도된 빨강" 과 "회귀 빨강" 이 같은 색이 된다.
  projects: [
    { name: 'chromium', testIgnore: /fault\//, use: { browserName: 'chromium', launchOptions: { args: CHROMIUM_MEDIA } } },
    { name: 'chromium-fault', testMatch: /fault\//, use: { browserName: 'chromium', launchOptions: { args: CHROMIUM_MEDIA } } },
    // ★능력표(SDK§12-3) 실측용. 정규 게이트에 섞지 않는다 — 표가 채워지기 전이라
    //   빨강이 "회귀" 가 아니라 "그 브라우저에서 아직 안 선다" 를 뜻한다.
    { name: 'firefox-probe', testIgnore: /fault\//, use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: FIREFOX_MEDIA } } },
  ],
  webServer: {
    command: `npx --yes http-server ../.. -p ${PORT} -c-1 --silent`,
    port: PORT,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
