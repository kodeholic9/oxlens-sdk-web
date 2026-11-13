// author: kodeholic (powered by Claude)
// ★실측(probe) — 서버 하향 RTX 링버퍼 1,024 칸이 몇 초를 덮나(context 202610/20261028c 남은 것 ① · 202611/20261113c).
//   링버퍼는 업링크 물리 트랙(층)마다 하나다(정:RULE-RTCP-NACK-DOWN · 서버 RtpCache `slots[seq % 1024]`) — 그 창 = 1,024 ÷ 그 층의 패킷률.
//   패킷률은 실 인코더가 정한다(프레임 하나가 패킷 여럿) — 기본 형상(SDK 층 기본값 · 서버 정책 기본값)에서 발행자 getStats 의
//   outbound-rtp `packetsSent` 를 rid 마다 두 번 읽어 차로 잰다. 판정이 아니라 수치다 — 정규 게이트 밖(chromium-probe).
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../../fixtures/scope.js'

const S = new Scope('rtx_win')
const ROOM = S.room()
const SLOTS = 1024
const SPAN_MS = 10_000

test.afterEach(async () => { await S.teardown() })

interface Enc { rid: string | null; kind?: string | null; packetsSent: number | null; bytesSent: number | null; framesEncoded: number | null; frameWidth?: number | null; framesPerSecond?: number | null }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const byRid = (es: Enc[]) => Object.fromEntries(es.map((e) => [e.rid ?? '-', e])) as Record<string, Enc>

test('RTX 링버퍼 창 — 실 인코더 층별 패킷률', { annotation: { type: 'spec', description: '정:RULE-RTCP-NACK-DOWN' } }, async ({ browser }) => {
  test.setTimeout(90_000)
  await ensureRoom(ROOM)
  const pub = await S.open(await browser.newContext(), { userId: S.user('P01') })
  await pub.call('join', ROOM, 'talk')
  const sub = await S.open(await browser.newContext(), { userId: S.user('S01'), adaptiveStream: false })
  await sub.call('join', ROOM, 'talk')
  const cam = await pub.call<{ simulcast: boolean }>('enableCamera', { simulcast: true })
  expect(cam.simulcast, '시뮬캐스트로 발행됐다').toBe(true)
  await expect.poll(async () => Object.keys(byRid(await pub.call<Enc[]>('encodings'))).filter((r) => r === 'h' || r === 'l').length,
    { timeout: 15_000 }).toBe(2)
  // 인코더 대역 추정이 오를 시간 — h 가 제 속도로 흐를 때까지
  await wait(15_000)
  const a = byRid(await pub.call<Enc[]>('encodings'))
  await wait(SPAN_MS)
  const b = byRid(await pub.call<Enc[]>('encodings'))
  const rows: Record<string, unknown>[] = []
  for (const rid of Object.keys(b)) {
    if (!a[rid]) continue
    const pps = (((b[rid]!.packetsSent ?? 0) - (a[rid]!.packetsSent ?? 0)) * 1000) / SPAN_MS
    const kbps = (((b[rid]!.bytesSent ?? 0) - (a[rid]!.bytesSent ?? 0)) * 8) / SPAN_MS
    const fps = (((b[rid]!.framesEncoded ?? 0) - (a[rid]!.framesEncoded ?? 0)) * 1000) / SPAN_MS
    rows.push({ rid, width: b[rid]!.frameWidth ?? null, fps: +fps.toFixed(1), kbps: +kbps.toFixed(0), pps: +pps.toFixed(1),
      packetsPerFrame: fps ? +(pps / fps).toFixed(2) : null, windowSec: pps ? +(SLOTS / pps).toFixed(2) : null })
  }
  process.stdout.write(`\n  [rtx_win] ${JSON.stringify(rows)}\n`)
  expect(rows.some((r) => r.rid === 'h' && (r.pps as number) > 0), 'h 층 패킷률을 못 쟀다 · 공허').toBe(true)
})
