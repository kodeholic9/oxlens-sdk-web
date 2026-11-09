// author: kodeholic (powered by Claude)
// ★3층의 몫 — 서버사이드 SDK(oxpeer) 녹화기의 HLS 결과물(fMP4 · SDK:RULE-PLAT-REC-HLS · context 202611/20261110b)을 ★브라우저 재생기가 실제로 재생 · 디코드한다.
//   PEER-MIX-03 브라우저(크로미움 실 인코더 H264 + Opus)가 발행 → 녹화기 `--hls` → 크로미움 기본 HLS 재생기가 끝까지(ENDLIST) 재생.
//   PEER-MIX-04 해상도가 바뀌는 진짜 H264(ffmpeg 640x360 → 320x180) + Opus 를 공개 결과물 HlsSink 로 지은 목록(실측 `scripts/media_check.sh`)을 ★끊김 · init 교체를 건너 재생.
//     ★ffmpeg HLS 읽개는 재생 목록 중간의 EXT-X-MAP 교체를 따라가지 않아 실패했다(20261110) — 실제 재생기가 판정한다.
//   와이어 · 조각 구조 · 디코드 시각은 2층(peer_hls_streams)이 본다 — 여기는 재생기가 판정을 바꾸는 것만.
import { test, type Page } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'
import { PEER_REPO, buildPeer, runPeer } from '../fixtures/oxpeer.js'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'

const S = new Scope('peer_hls')
/** 정적 서버 뿌리(playwright.config webServer — `oxlens-sdk-web`) 아래에 둬야 같은 출처로 재생한다 */
const ROOT = resolve('..', '..')
const OUT = resolve('test-results', 'peer-hls')

test.beforeAll(() => { buildPeer() })
test.afterEach(async () => { await S.teardown() })

interface Played {
  ended: boolean
  error: number | null
  duration: number
  currentTime: number
  width: number
  widths: string[]
  frames: number
  dropped: number
  audioBytes: number
}

/** 그 목록을 기본 재생기로 끝까지(2배속) 재생하고 수치를 잰다 — 폭 차례는 재생 중 0.25초마다 */
async function play(page: Page, playlist: string, timeoutMs: number): Promise<Played> {
  await page.goto('/qa/page.html')
  const url = '/' + relative(ROOT, playlist).split('\\').join('/')
  return page.evaluate(async ({ url, timeoutMs }) => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    document.body.appendChild(v)
    const widths: string[] = []
    const tick = setInterval(() => {
      const w = `${v.videoWidth}x${v.videoHeight}`
      if (v.videoWidth && widths[widths.length - 1] !== w) widths.push(w)
    }, 250)
    v.src = url
    await new Promise<void>((res) => {
      const t = setTimeout(res, timeoutMs)
      v.addEventListener('ended', () => { clearTimeout(t); res() })
      v.addEventListener('error', () => { clearTimeout(t); res() })
      v.addEventListener('loadedmetadata', () => { v.playbackRate = 2; void v.play() })
    })
    clearInterval(tick)
    const q = v.getVideoPlaybackQuality()
    const ext = v as unknown as { webkitAudioDecodedByteCount?: number }
    return {
      ended: v.ended, error: v.error?.code ?? null, duration: v.duration, currentTime: v.currentTime, width: v.videoWidth, widths,
      frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, audioBytes: ext.webkitAudioDecodedByteCount ?? -1,
    }
  }, { url, timeoutMs })
}

test('PEER-MIX-03 브라우저 발행을 oxpeer 녹화기가 HLS 로 쓰고 기본 재생기가 끝까지 재생한다', { annotation: { type: 'spec', description: 'SDK:RULE-PLAT-REC-HLS · SDK:RULE-PLAT-SERVER' } }, async ({ browser }) => {
  test.setTimeout(120_000)
  const ROOM = S.room('rec')
  await ensureRoom(ROOM)
  const ctx = await browser.newContext()
  const a = await S.open(ctx, { userId: S.user('U01') })
  await a.call('join', ROOM, 'talk')
  await a.call('enableMic')
  await a.call('enableCamera')
  const out = join(OUT, 'mix03')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const rec = runPeer('recorder', ['--room', ROOM, '--out', out, '--secs', '14', '--user', S.user('REC'), '--hls'])
  await rec.joined
  const summary = await rec.done
  const streams = (summary.hls as Array<{ owner?: string; refused?: string | null; event: string; segments: unknown[]; keyframe_requests: number; over_target: number }>) ?? []
  const mine = streams.find((s) => s.owner === S.user('U01'))
  expect(mine, '브라우저 사람의 HLS 묶음이 있다 — 없으면 받지도 못했다').toBeTruthy()
  expect(mine!.refused ?? null, '방 코덱 H264 — 거절이 아니다').toBeNull()
  expect(mine!.segments.length, '14초 녹화 · 목표 4초 — 조각 셋 이상').toBeGreaterThanOrEqual(3)
  expect(mine!.over_target, '브라우저는 주기 키프레임이 없다 — 요청한 키가 와서 TARGETDURATION 안에 잘렸다(M4)').toBe(0)
  expect(mine!.keyframe_requests, '조각 경계마다 키프레임을 요청했다').toBeGreaterThanOrEqual(mine!.segments.length - 1)
  const p = await (await browser.newContext()).newPage()
  const r = await play(p, mine!.event, 30_000)
  console.log('[PEER-MIX-03]', JSON.stringify(r))
  expect(r.error, '재생기 오류 — fMP4 · 목록을 재생기가 거부했다').toBeNull()
  expect(r.ended, 'ENDLIST 까지 재생했다').toBe(true)
  expect(r.width, '폭이 0 이면 검은 화면이다').toBeGreaterThan(0)
  expect(r.frames, '디코드한 영상 프레임(초당 10 이상)').toBeGreaterThan(r.duration * 10)
  expect(r.dropped, '버린 프레임이 디코드한 것의 10% 를 넘지 않는다').toBeLessThan(r.frames / 10)
  expect(r.audioBytes, 'Opus 음성을 디코드했다').toBeGreaterThan(0)
})

test('PEER-MIX-04 해상도가 바뀐 HLS(끊김 · init 교체)를 기본 재생기가 건너 재생한다', { annotation: { type: 'spec', description: 'SDK:RULE-PLAT-REC-HLS' } }, async ({ browser }) => {
  test.setTimeout(240_000)
  execFileSync('bash', ['scripts/media_check.sh'], { cwd: PEER_REPO, stdio: 'pipe' })
  const out = join(OUT, 'mix04')
  rmSync(out, { recursive: true, force: true })
  cpSync(join(PEER_REPO, 'target', 'media-check', 'hls', 'mkvcheck-u'), out, { recursive: true })
  const p = await (await browser.newContext()).newPage()
  const r = await play(p, join(out, 'event.m3u8'), 30_000)
  console.log('[PEER-MIX-04]', JSON.stringify(r))
  expect(r.error, '재생기 오류 — 끊김 뒤 새 init 을 재생기가 거부했다').toBeNull()
  expect(r.ended, 'ENDLIST 까지 — 끊김에서 멎지 않았다').toBe(true)
  expect(r.widths, '화면 크기가 640x360 → 320x180 으로 바뀐다(새 init 의 SPS)').toEqual(['640x360', '320x180'])
  expect(r.frames, '디코드한 영상 프레임(표본 120)').toBeGreaterThanOrEqual(110)
  expect(r.audioBytes, 'Opus 음성을 디코드했다').toBeGreaterThan(0)
})
