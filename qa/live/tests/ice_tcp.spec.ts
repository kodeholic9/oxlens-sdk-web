// author: kodeholic (powered by Claude)
// ★3층의 몫 — libwebrtc 상태머신. T1·T2(경로가 서는가)는 2층이 이미 쟀다(20260913h §8-2).
// 여기서 재는 것은 ★**UDP 와 TCP 가 둘 다 있을 때 브라우저가 무엇을 하는가**다.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'

interface IcePair {
  state: string | null
  nominated: boolean | null
  requestsSent: number
  responsesReceived: number
  bytesSent: number
  localProtocol: string | null
  localType: string | null
  remoteProtocol: string | null
  remotePort: number | null
  remoteTcpType: string | null
}

type Part = { call: <T>(fn: string, ...a: unknown[]) => Promise<T> }

const S = new Scope('ice_tcp')
const ROOM = S.room()

test.afterEach(async () => { await S.teardown() })

const pairsOf = (p: Part): Promise<IcePair[]> => p.call<IcePair[]>('icePairs')
const tcpOf = async (p: Part): Promise<IcePair[]> =>
  (await pairsOf(p)).filter((x) => x.remoteProtocol === 'tcp')

test('ICETCP-01 스위치가 꺼져 있으면 TCP 후보가 SDP 에 아예 없다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('U01') })
  await a.call('join', ROOM, 'talk')
  await a.call('enableMic')

  const lines = await a.call<string[]>('remoteCandidateLines')
  expect(lines.length, '후보 줄이 있어야 잰다').toBeGreaterThan(0)
  expect(lines.every((l) => l.includes(' udp ')),
    `★상용 웹은 UDP 한 줄이 계약이다: ${JSON.stringify(lines)}`).toBe(true)
})

test('ICETCP-02 스위치를 켜면 서버 TCP 후보가 SDP 에 실린다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('U02'), iceTcp: true })
  await a.call('join', ROOM, 'talk')
  await a.call('enableMic')

  const lines = await a.call<string[]>('remoteCandidateLines')
  expect(lines.some((l) => l.includes('tcptype passive')),
    `★RFC 6544 — 서버가 passive 다: ${JSON.stringify(lines)}`).toBe(true)
  expect(lines.some((l) => l.includes(' udp ')), 'UDP 도 함께 선다').toBe(true)
})

/**
 * ★★**구멍 A — 20260913 실측.** 페이블 분석(`20260913f` §3)이 소스로 예측한 것을
 * 브라우저에서 관측했고, ★**예측보다 강하다** — prune 이 아니라 **쌍을 만들지도 않는다.**
 *
 * 이것이 설계 `20260913e` 의 전제를 깬다. *"둘 다 열어두고 서버가 고른다"* 는
 * ★**브라우저에서 성립하지 않는다** — 서버가 판정해도 보낼 길이 없다.
 */
test('ICETCP-03 ★UDP 가 함께 있으면 브라우저는 TCP 를 시도조차 않는다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('U03'), iceTcp: true })
  await a.call('join', ROOM, 'talk')
  await a.call('enableMic')

  await expect.poll(() => pairsOf(a).then((ps) => ps.length), {
    message: '쌍이 서야 잰다',
  }).toBeGreaterThan(0)
  // ★UDP 가 강해지고 kMinConnectionLifetime(10s) 이 지날 시간을 준다.
  await (a as unknown as { page: { waitForTimeout(ms: number): Promise<void> } }).page
    .waitForTimeout(12_000)

  const tcp = await tcpOf(a)
  process.stdout.write(`  [ICETCP-03] tcp pairs = ${tcp.length}\n`)
  expect(tcp.length,
    '★TCP 쌍이 서면 이 실측이 뒤집힌 것이다 — 그때는 설계를 되돌린다').toBe(0)
})

/**
 * ★**가르는 실험** — TCP 후보만 두면 붙는가. 붙으면 문제는 **능력이 아니라 경쟁**이다.
 * `dropUdpCandidate` 는 QA 전용 손잡이다(`build.ts __qaSetUdpCandidate`).
 */
test('ICETCP-04 ★TCP 만 두면 브라우저가 붙고 미디어가 흐른다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('U04'), iceTcp: true, dropUdpCandidate: true })
  await a.call('join', ROOM, 'talk')
  await a.call('enableMic')

  await expect.poll(() => tcpOf(a).then((ps) => ps.filter((p) => p.nominated === true).length), {
    message: '★Chrome 은 ICE-TCP 를 할 수 있다 — active(포트 9)로 서버 passive 에 건다',
  }).toBeGreaterThan(0)

  const tcp = await tcpOf(a)
  const won = tcp.find((p) => p.nominated === true)!
  expect(won, '★고른 쌍이 TCP 다').toBeDefined()
  expect(won.remoteTcpType).toBe('passive')
  expect(won.responsesReceived, '★STUN 이 왕복했다').toBeGreaterThan(0)
  expect(won.bytesSent, '★DTLS·SRTP 가 그 길로 흘렀다').toBeGreaterThan(1000)
})
