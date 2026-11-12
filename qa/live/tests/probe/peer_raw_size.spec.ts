// author: kodeholic (powered by Claude)
// ★실측(probe) M7(context 202611/20261109b §12 · 김대리 검토 #15) — 실 인코더 영상 한 사람의 시간당 원시 파트 크기.
//   1단계 M7 은 합성 페이로드였다. 여기서는 브라우저(크로미움 가짜 장치 — 실 인코더 H264 · Opus)가 발행하고 녹화기(oxrec)가 원시 파트로 받아 적는다.
//   원시 크기 = 파트 파일 합(MCAP 머리 · 색인 포함) · 시간 = 조립한 영상 프레임의 RTP 시각 폭 · 종류마다 페이로드 합은 `rawtool frames`.
//   판정이 아니라 수치다 — 정규 게이트 밖(chromium-probe). 결과는 `test-results/probe/m7_raw_size.json`.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../../fixtures/scope.js'
import { buildPeer, rawtool, runPeer } from '../../fixtures/oxpeer.js'
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const S = new Scope('peer_m7')

test.beforeAll(() => { buildPeer() })
test.afterEach(async () => { await S.teardown() })

type Frame = [number, number, boolean, number, number, number, number, string]
type Enc = { bytesSent: number | null; frameWidth: number | null; rid: string | null }

const SECS = 30

test('M7 실 인코더 영상 한 사람 — 시간당 원시 파트 크기', { annotation: { type: 'spec', description: 'SDK:RULE-PLAT-REC-PART · SDK:RULE-PLAT-REC-TAP' } }, async ({ browser }) => {
  test.setTimeout(180_000)
  const room = S.room('m7')
  await ensureRoom(room)
  const out = mkdtempSync(join(tmpdir(), 'oxpeer-m7-'))
  const raw = join(out, 'raw')
  const user = S.user('REC')
  const rec = runPeer('oxrec', ['--room', room, '--out', out, '--secs', String(SECS), '--user', user, '--video', '--raw', raw])
  await rec.joined
  const a = await S.open(await browser.newContext(), { userId: S.user('U01') })
  await a.call('join', room, 'talk')
  await a.call('enableMic')
  await a.call('enableCamera')
  const t0 = Date.now()
  const e0 = await a.call<Enc[]>('encodings')
  await rec.done
  const e1 = await a.call<Enc[]>('encodings')
  const pubSecs = (Date.now() - t0) / 1000

  const parts = readdirSync(raw).filter((f) => f.endsWith('.mcap'))
  const rawBytes = parts.reduce((s, f) => s + statSync(join(raw, f)).size, 0)
  const frames = (rawtool(['frames', raw, user]).frames as Frame[]) ?? []
  const video = frames.filter((f) => f[7] === 'v')
  const audio = frames.filter((f) => f[7] === 'a')
  const span = video.length > 1 ? ((video[video.length - 1][1] - video[0][1]) >>> 0) / 90_000 : 0
  const sent = (e: Enc[]): number => e.reduce((s, x) => s + (x.bytesSent ?? 0), 0)
  const perHour = (b: number): number => (span > 0 ? Math.round((b / span) * 3600) : 0)
  const vPayload = video.reduce((s, f) => s + f[3], 0)
  const aPayload = audio.reduce((s, f) => s + f[3], 0)
  const res = {
    secs_recorded: SECS,
    video_span_s: Number(span.toFixed(2)),
    parts: parts.length,
    raw_bytes: rawBytes,
    raw_bytes_per_hour: perHour(rawBytes),
    raw_mib_per_hour: Number((perHour(rawBytes) / 2 ** 20).toFixed(1)),
    video_frames: video.length,
    video_payload_bytes: vPayload,
    audio_frames: audio.length,
    audio_payload_bytes: aPayload,
    overhead_ratio: rawBytes > 0 ? Number(((rawBytes - vPayload - aPayload) / rawBytes).toFixed(3)) : null,
    browser_video_kbps: Number((((sent(e1) - sent(e0)) * 8) / pubSecs / 1000).toFixed(0)),
    browser_frame_width: e1.map((x) => x.frameWidth),
    hours_to_1gib: perHour(rawBytes) > 0 ? Number((2 ** 30 / perHour(rawBytes)).toFixed(2)) : null,
  }
  mkdirSync('test-results/probe', { recursive: true })
  writeFileSync('test-results/probe/m7_raw_size.json', JSON.stringify(res, null, 1))
  console.log('[M7]', JSON.stringify(res))
  expect(video.length, '실 인코더 영상 프레임을 못 받으면 잴 수 없다').toBeGreaterThan(SECS * 10)
  expect(span, '영상 시간 폭이 녹화 시간의 절반은 넘어야 시간당 환산이 선다').toBeGreaterThan(SECS / 2)
})
