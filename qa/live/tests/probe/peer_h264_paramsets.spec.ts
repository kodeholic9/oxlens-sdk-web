// author: kodeholic (powered by Claude)
// ★실측(probe) M4(context 202611/20261109b §12 · 20261110b) — H264 SPS · PPS 가 ★따로 오는가 · 프레임 안(in-band)에만 실리나 · 키프레임마다 오나.
//   HLS init 세그먼트(avcC)를 무엇으로 짓는지가 여기서 정해진다. 두 인코더를 같은 길로 본다:
//   ① 브라우저(크로미움 가짜 장치 — 실 인코더)가 H264 방에 발행 ② oxpeer 에이전트가 ffmpeg(x264 baseline · GOP 30)가 지은 표본을 발행.
//   녹화기(oxrec)가 원시 파트로 받아 적고 · `rawtool nals` 가 조립한 프레임마다 NAL 종류를 낸다(파이프라인 — SDK:RULE-PLAT-REC-PIPE).
//   판정이 아니라 수치다 — 정규 게이트 밖(chromium-probe). 결과는 `test-results/probe/m4_paramsets.json`.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../../fixtures/scope.js'
import { buildPeer, makeSamples, rawtool, runPeer } from '../../fixtures/oxpeer.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const S = new Scope('peer_m4')

test.beforeAll(() => { buildPeer() })
test.afterEach(async () => { await S.teardown() })

type Nal = [number, number, boolean, number[]]

/** 프레임 목록 → 키프레임 수 · SPS(7) · PPS(8) 가 든 키프레임 수 · 키프레임 밖 SPS/PPS · 프레임에 든 NAL 종류 집합 */
function tally(frames: Nal[]): Record<string, unknown> {
  const key = frames.filter((f) => f[2])
  const has = (f: Nal, t: number): boolean => f[3].includes(t)
  return {
    frames: frames.length,
    keyframes: key.length,
    key_with_sps: key.filter((f) => has(f, 7)).length,
    key_with_pps: key.filter((f) => has(f, 8)).length,
    nonkey_with_sps_or_pps: frames.filter((f) => !f[2] && (has(f, 7) || has(f, 8))).length,
    alone_sps_or_pps: frames.filter((f) => f[3].length > 0 && f[3].every((t) => t === 7 || t === 8)).length,
    nal_types: [...new Set(frames.flatMap((f) => f[3]))].sort((a, b) => a - b),
    first_key_nals: key[0]?.[3] ?? null,
  }
}

async function recordH264(room: string, label: string, publish: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const out = mkdtempSync(join(tmpdir(), `oxpeer-m4-${label}-`))
  const user = S.user(`REC${label}`)
  const rec = runPeer('oxrec', ['--room', room, '--out', out, '--secs', '8', '--user', user, '--video', '--raw', join(out, 'raw')])
  await rec.joined
  await publish()
  await rec.done
  const r = rawtool(['nals', join(out, 'raw'), user])
  return tally((r.frames as Nal[]) ?? [])
}

test('M4 H264 SPS · PPS 위치 — 브라우저 · x264', { annotation: { type: 'spec', description: 'SDK:RULE-PLAT-REC-PIPE · SDK:RULE-PLAT-REC-MKV' } }, async ({ browser }) => {
  test.setTimeout(120_000)
  const res: Record<string, unknown> = {}

  const R1 = S.room('browser')
  await ensureRoom(R1)
  const ctx = await browser.newContext()
  res.browser = await recordH264(R1, 'B', async () => {
    const a = await S.open(ctx, { userId: S.user('U01') })
    await a.call('join', R1, 'talk')
    await a.call('enableCamera')
  })

  const R2 = S.room('x264')
  await ensureRoom(R2)
  const sm = makeSamples(3)
  res.x264 = await recordH264(R2, 'X', async () => {
    const ag = runPeer('agent_echo', ['--room', R2, '--secs', '7', '--user', S.user('AGENT'), '--mode', 'file', '--opus', sm.opus, '--h264', sm.h264])
    await ag.joined
  })

  mkdirSync('test-results/probe', { recursive: true })
  writeFileSync('test-results/probe/m4_paramsets.json', JSON.stringify(res, null, 1))
  console.log('[M4]', JSON.stringify(res))
  expect((res.browser as { keyframes: number }).keyframes, '브라우저 H264 키프레임을 하나도 못 받으면 잴 수 없다').toBeGreaterThan(0)
  expect((res.x264 as { keyframes: number }).keyframes, 'x264 표본 키프레임을 하나도 못 받으면 잴 수 없다').toBeGreaterThan(0)
})
