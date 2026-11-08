// author: kodeholic (powered by Claude)
// ★실측 탐침 — 학습 문서(oxlens-sfu docs/learn)의 콜 플로우 재료를 장마다 한 번에 거둔다. 판정하지 않는다.
//   이름 = 학습 문서의 장 번호(context guide/learn · 20261109 다섯 부 구성) — TOUR-02 · 02P · 02T · 06 · 07 · 08 · 09 · 10 · 11 · 13.
//   거두는 것: 브라우저 WS 프레임(보냄 · 받음) · SDP 두 벌(setLocal · setRemote) · ICE · DC 상태와 DC 바이트 · SDK 전이 · 서버 표면(/admin).
//   서버 로그는 정리(LEAVE)까지 본 뒤 이 회차의 시각 창으로 자른다(개발 형상 로그 위치 /tmp/oxlens/<node>/ox.log.<날짜> · stat 줄 뺌).
//   산출: <저장소>/.archive/tour/tour-<시각>/<장>.json(TOUR_OUT 으로 바꾼다).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, connect as tcpConnect, Server, Socket } from 'node:net'
import { join } from 'node:path'
import { Browser, BrowserContext, Page, test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../../fixtures/scope.js'
import { HUB, ROOT, placementOf, roomFor, sfuIds } from '../../fixtures/env.js'

/** 신호만 끊는 TCP 중계 — 페이지의 WS · HTTP 를 hub 로 그대로 잇고, cut() 이면 열린 연결을 끊고 잠시 받지 않는다(미디어 UDP 는 안 지난다). */
class Relay {
  private readonly socks = new Set<Socket>()
  private server: Server | null = null
  private open = true
  constructor(readonly port: number) {}
  async start(): Promise<void> {
    const [host, port] = HUB.split(':') as [string, string]
    this.server = createServer((c) => {
      if (!this.open) { c.destroy(); return }
      const up = tcpConnect(Number(port), host)
      this.socks.add(c); this.socks.add(up)
      c.pipe(up); up.pipe(c)
      const drop = () => { c.destroy(); up.destroy(); this.socks.delete(c); this.socks.delete(up) }
      c.on('error', drop); up.on('error', drop); c.on('close', drop); up.on('close', drop)
    })
    await new Promise<void>((r) => this.server!.listen(this.port, '127.0.0.1', () => r()))
  }
  cut(): void { this.open = false; for (const s of this.socks) s.destroy(); this.socks.clear() }
  restore(): void { this.open = true }
  async stop(): Promise<void> { this.cut(); await new Promise<void>((r) => this.server?.close(() => r()) ?? r()) }
}

const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString()
const STAMP = local(new Date()).replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const OUT = process.env.TOUR_OUT ?? join('..', '..', '.archive', 'tour', `tour-${STAMP}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 개발 형상 로그 — 로컬 날짜의 파일에서 [from, to] 창 · stat 줄을 뺀다. */
function serverLog(node: string, from: Date, to: Date): string[] {
  const f = `/tmp/oxlens/${node}/ox.log.${local(from).slice(0, 10)}`
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter((l) => {
    if (!l.startsWith('ts=') || l.includes(' kind=stat ')) return false
    const at = new Date(l.slice(3, l.indexOf(' ')))
    return at >= from && at <= to
  })
}

/** 브라우저 안 — RTCPeerConnection 을 감싸 SDP · ICE · DC 상태 · DC 바이트를 시각과 함께 남긴다. */
function hookPc(): void {
  const log: unknown[] = []
  ;(window as unknown as { __tour: unknown[] }).__tour = log
  const Orig = window.RTCPeerConnection
  let n = 0
  const b64 = (d: unknown): string => {
    if (typeof d === 'string') return d
    const u = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(0)
    let s = ''
    for (const x of u) s += String.fromCharCode(x)
    return `b64:${btoa(s)}`
  }
  class Hooked extends Orig {
    constructor(cfg?: RTCConfiguration) {
      super(cfg)
      const pc = n++
      const put = (ev: string, body: unknown) => log.push({ at: new Date().toISOString(), pc, ev, body })
      const watch = (ch: RTCDataChannel) => {
        ch.addEventListener('open', () => put('dc-open', ch.label))
        ch.addEventListener('close', () => put('dc-close', ch.label))
        ch.addEventListener('message', (e) => put('dc-recv', b64(e.data)))
        const send = ch.send.bind(ch)
        ch.send = ((d: string & ArrayBuffer) => { put('dc-send', b64(d)); send(d) }) as typeof ch.send
      }
      put('new', null)
      this.addEventListener('iceconnectionstatechange', () => put('ice', this.iceConnectionState))
      this.addEventListener('connectionstatechange', () => put('conn', this.connectionState))
      this.addEventListener('datachannel', (e) => { put('dc-remote', e.channel.label); watch(e.channel) })
      this.addEventListener('track', (e) => put('track', { kind: e.track.kind, mid: e.transceiver.mid, streams: e.streams.map((s) => s.id) }))
      const sl = this.setLocalDescription.bind(this)
      const sr = this.setRemoteDescription.bind(this)
      this.setLocalDescription = async (d?: RTCLocalSessionDescriptionInit) => {
        await sl(d as RTCSessionDescriptionInit)
        put('local', { type: this.localDescription?.type, sdp: this.localDescription?.sdp })
      }
      this.setRemoteDescription = async (d: RTCSessionDescriptionInit) => {
        put('remote', { type: d.type, sdp: d.sdp })
        await sr(d)
      }
      const cdc = this.createDataChannel.bind(this)
      this.createDataChannel = (label: string, opts?: RTCDataChannelInit) => {
        const ch = cdc(label, opts)
        put('dc-local', { label, opts: opts ?? null })
        watch(ch)
        return ch
      }
    }
  }
  window.RTCPeerConnection = Hooked as typeof RTCPeerConnection
}

interface Frame { at: string; who: string; dir: 'send' | 'recv'; data: string }
interface Http { at: string; who: string; data: string }
type OpenExtra = { iceTcp?: boolean; dropUdpCandidate?: boolean; adaptiveStream?: boolean; pcMode?: '1pc' | '2pc' }
interface IcePair { state: string | null; nominated: boolean | null; requestsSent: number; responsesReceived: number; bytesSent: number; localProtocol: string | null; remoteProtocol: string | null; remotePort: number | null; remoteTcpType: string | null }

/** 한 장의 회차 — 사람마다 브라우저 문맥 하나(끊김 시험이 한 사람만 끊을 수 있게). */
class Capture {
  readonly frames: Frame[] = []
  readonly http: Http[] = []
  readonly steps: { at: string; step: string }[] = []
  readonly people = new Map<string, { p: Participant; ctx: BrowserContext; userId: string }>()

  constructor(readonly S: Scope, readonly browser: Browser) {}

  mark(step: string): void { this.steps.push({ at: new Date().toISOString(), step }) }

  async open(who: string, base?: string, extra: OpenExtra = {}): Promise<Participant> {
    const ctx = await this.browser.newContext()
    await ctx.addInitScript(hookPc)
    ctx.on('page', (pg: Page) => {
      pg.on('websocket', (ws) => {
        const put = (dir: Frame['dir']) => (f: { payload: string | Buffer }) =>
          this.frames.push({ at: new Date().toISOString(), who, dir, data: typeof f.payload === 'string' ? f.payload : `b64:${f.payload.toString('base64')}` })
        ws.on('framesent', put('send'))
        ws.on('framereceived', put('recv'))
      })
      // SDK 가 부르는 HTTP(방 상세 다시 받기 등) — 메서드 · 경로 · 상태만
      pg.on('response', (r) => {
        const u = r.url()
        if (u.includes('/rooms')) this.http.push({ at: new Date().toISOString(), who, data: `${r.request().method()} ${u.replace(ROOT, '')} ${r.status()}` })
      })
    })
    this.mark(`${who}.connect`)
    const userId = this.S.user(who)
    const p = await this.S.open(ctx, { userId, ...(base ? { base } : {}), ...extra })
    this.people.set(who, { p, ctx, userId })
    return p
  }

  async finish(name: string, extra: Record<string, unknown>, nodes: string[]): Promise<void> {
    const admin = async (path: string) => {
      const res = await fetch(`${ROOT}${path}`)
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const per: Record<string, unknown> = {}
    for (const [who, { p, userId }] of this.people) {
      per[who] = {
        userId,
        pc: await p.page.evaluate(() => (window as unknown as { __tour: unknown }).__tour),
        diag: await p.call('diag'),
        rooms: await p.call('rooms'),
        events: await p.call('events'),
        stats: await p.call('trackStats'),
        local: await p.call('localTracks').catch(() => null),
        media: await admin(`/admin/users/${userId}/media`),
      }
    }
    this.mark('teardown')
    await this.S.teardown()
    for (const { ctx } of this.people.values()) await ctx.close().catch(() => {})
    await sleep(500)
    const end = new Date()
    const out = {
      chapter: name, steps: this.steps, frames: this.frames, http: this.http, people: per, ...extra,
      users: [...this.people.entries()].map(([who, x]) => ({ who, userId: x.userId })),
      log: Object.fromEntries(nodes.map((n) => [n, serverLog(n, new Date(this.steps[0]!.at), end)])),
    }
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(out, null, 2))
    process.stdout.write(`  tour → ${OUT}/${name}.json\n`)
  }
}

/** node 위에 놓이는 방 이름 — 배치 = 방 이름의 HRW(서버와 같은 함수). */
function roomOn(tag: string, node: string, ids: string[], skip = 0): string {
  let k = 0
  for (let i = 0; i < 1_000; i++) {
    const r = roomFor(tag, `p${i}`)
    if (placementOf(r, ids) === node && k++ === skip) return r
  }
  throw new Error(`${tag}: ${node} 에 놓이는 이름이 없다`)
}

async function snapshot(room: string) {
  const res = await fetch(`${ROOT}/admin/rooms/${room}/snapshot`)
  return { status: res.status, body: await res.json().catch(() => null) }
}

const videoOf = async (p: Participant) => (await p.call<{ id: string; kind: string; videoWidth?: number }[]>('trackStats'))
  .find((s) => s.kind === 'video' && !s.id.startsWith('ptt-'))
const phase = (p: Participant, room: string) => p.call<{ phase: string } | null>('ptt', room).then((s) => s?.phase ?? null)
const audioPackets = async (p: Participant) => (await p.call<{ id: string; kind: string; packets: number | null }[]>('trackStats'))
  .filter((s) => s.kind === 'audio' && !s.id.startsWith('ptt-')).reduce((a, s) => a + (s.packets ?? 0), 0)
const pairsOf = (p: Participant) => p.call<IcePair[]>('icePairs')
const slotPackets = async (p: Participant, room: string) => (await p.call<{ id: string; roomId: string; kind: string; packets: number | null }[]>('trackStats'))
  .filter((s) => s.roomId === room && s.id.startsWith('ptt-') && s.kind === 'audio').reduce((a, s) => a + (s.packets ?? 0), 0)

test.describe.configure({ mode: 'serial' })
const scopes: Scope[] = []
test.afterEach(async () => { for (const s of scopes) await s.teardown() })

const S1 = new Scope('tour')
scopes.push(S1)
test('TOUR-02 입장 → 발행 → 구독 → 영상이 보이기까지', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  const ids = await sfuIds()
  const ROOM = roomOn('tour', 'node-a', ids)
  const c = new Capture(S1, browser)
  c.mark('ensureRoom')
  await ensureRoom(ROOM)
  const a = await c.open('A')
  c.mark('A.join')
  await a.call('join', ROOM, 'talk')
  const b = await c.open('B')
  c.mark('B.join')
  await b.call('join', ROOM, 'talk')
  c.mark('B.enableMic')
  await b.call('enableMic')
  c.mark('B.enableCamera')
  await b.call('enableCamera')
  await expect.poll(() => videoOf(a).then((v) => v?.videoWidth ?? 0), { timeout: 20_000 }).toBeGreaterThan(0)
  c.mark('A.videoDecoded')
  await sleep(2_500)
  c.mark('collect')
  await c.finish('02', { room: ROOM, node: 'node-a', sfus: ids, server: { room: await snapshot(ROOM), encodings: await b.call('encodings') } }, ids)
})

const S2P = new Scope('tour2pc')
scopes.push(S2P)
test('TOUR-02P 같은 길을 2pc 로 — 연결 둘(발행 · 구독)', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  const ids = await sfuIds()
  const ROOM = roomOn('tour2pc', 'node-a', ids)
  const c = new Capture(S2P, browser)
  c.mark('ensureRoom')
  await ensureRoom(ROOM)
  const a = await c.open('A', undefined, { pcMode: '2pc' })
  c.mark('A.join')
  await a.call('join', ROOM, 'talk')
  const b = await c.open('B', undefined, { pcMode: '2pc' })
  c.mark('B.join')
  await b.call('join', ROOM, 'talk')
  c.mark('B.enableMic')
  await b.call('enableMic')
  c.mark('B.enableCamera')
  await b.call('enableCamera')
  await expect.poll(() => videoOf(a).then((v) => v?.videoWidth ?? 0), { timeout: 20_000 }).toBeGreaterThan(0)
  c.mark('A.videoDecoded')
  await sleep(2_500)
  c.mark('collect')
  await c.finish('02P', { room: ROOM, node: 'node-a', sfus: ids, server: { room: await snapshot(ROOM) } }, ids)
})

const S9 = new Scope('touridle')
scopes.push(S9)
test('TOUR-09 무전 상시 대기 비용 — 1pc 와 2pc 를 같은 방에서 60초', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  test.setTimeout(150_000)
  const ids = await sfuIds()
  const ROOM = roomOn('touridle', 'node-a', ids)
  const c = new Capture(S9, browser)
  c.mark('ensureRoom')
  await ensureRoom(ROOM)
  const one = await c.open('ONE', undefined, { pcMode: '1pc' })
  const two = await c.open('TWO', undefined, { pcMode: '2pc' })
  c.mark('join')
  await one.call('join', ROOM, 'listen')
  await two.call('join', ROOM, 'listen')
  await sleep(5_000)
  const t0 = Date.now()
  c.mark('idle.start')
  const before = { ONE: await pairsOf(one), TWO: await pairsOf(two) }
  await sleep(60_000)
  const after = { ONE: await pairsOf(one), TWO: await pairsOf(two) }
  c.mark('idle.end')
  await c.finish('09', { room: ROOM, node: 'node-a', sfus: ids, idle: { ms: Date.now() - t0, before, after } }, ids)
})

const S3 = new Scope('tourptt')
scopes.push(S3)
test('TOUR-07 무전 — 누름 · 허가 · 줄 · 놓음 · 넘겨받음', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  const ids = await sfuIds()
  const ROOM = roomOn('tourptt', 'node-a', ids)
  const c = new Capture(S3, browser)
  c.mark('ensureRoom')
  await ensureRoom(ROOM)
  const a = await c.open('A')
  c.mark('A.join')
  await a.call('join', ROOM, 'talk')
  const b = await c.open('B')
  c.mark('B.join')
  await b.call('join', ROOM, 'talk')
  const l = await c.open('L')
  c.mark('L.join')
  await l.call('join', ROOM, 'listen')
  await expect.poll(() => l.call<{ trusted: boolean }>('ptt', ROOM).then((s) => s.trusted)).toBe(true)
  c.mark('A.press')
  await a.call('press', ROOM)
  await expect.poll(() => phase(a, ROOM)).toBe('has_permission')
  c.mark('A.granted')
  await expect.poll(() => slotPackets(l, ROOM), { timeout: 10_000 }).toBeGreaterThan(0)
  c.mark('L.slotFlowing')
  await sleep(1_000)
  c.mark('B.press')
  await b.call('press', ROOM)
  await sleep(1_000)
  c.mark('B.afterPress')
  c.mark('A.release')
  await a.call('release', ROOM)
  await sleep(2_500)
  c.mark('B.afterRelease')
  c.mark('B.release')
  await b.call('release', ROOM).catch(() => {})
  await sleep(1_500)
  c.mark('collect')
  await c.finish('07', { room: ROOM, node: 'node-a', sfus: ids, server: { room: await snapshot(ROOM) } }, ids)
})

const S4 = new Scope('tourmulti')
scopes.push(S4)
test('TOUR-08 다방 청취 · 발언 방 바꾸기', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  const ids = await sfuIds()
  const R1 = roomOn('tourmulti', 'node-a', ids, 0)
  const R2 = roomOn('tourmulti', 'node-a', ids, 1)
  const c = new Capture(S4, browser)
  c.mark('ensureRoom')
  await ensureRoom(R1)
  await ensureRoom(R2)
  const a = await c.open('A')
  c.mark('A.join.R1.talk')
  await a.call('join', R1, 'talk')
  c.mark('A.join.R2.listen')
  await a.call('join', R2, 'listen')
  const b = await c.open('B')
  c.mark('B.join.R1.talk')
  await b.call('join', R1, 'talk')
  const d = await c.open('C')
  c.mark('C.join.R2.talk')
  await d.call('join', R2, 'talk')
  c.mark('B.press.R1')
  await b.call('press', R1)
  await expect.poll(() => slotPackets(a, R1), { timeout: 10_000 }).toBeGreaterThan(0)
  c.mark('A.hears.R1')
  await b.call('release', R1)
  c.mark('C.press.R2')
  await d.call('press', R2)
  await expect.poll(() => slotPackets(a, R2), { timeout: 10_000 }).toBeGreaterThan(0)
  c.mark('A.hears.R2')
  await d.call('release', R2)
  await sleep(500)
  c.mark('A.setSpeakingRoom.R2')
  await a.call('setSpeakingRoom', R2)
  await expect.poll(() => a.call<string | null>('speakingRoom')).toBe(R2)
  c.mark('A.press.R2')
  await a.call('press', R2)
  await expect.poll(() => phase(a, R2)).toBe('has_permission')
  await expect.poll(() => slotPackets(d, R2), { timeout: 10_000 }).toBeGreaterThan(0)
  c.mark('C.hears.A')
  await a.call('release', R2)
  await sleep(1_000)
  c.mark('collect')
  await c.finish('08', { rooms: [R1, R2], node: 'node-a', sfus: ids, server: { r1: await snapshot(R1), r2: await snapshot(R2) } }, ids)
})

const S5 = new Scope('tourcut')
scopes.push(S5)
test('TOUR-10 신호 연결이 끊겼다 돌아온다 — RESUME', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  const ids = await sfuIds()
  const ROOM = roomOn('tourcut', 'node-a', ids)
  const relay = new Relay(19_740)
  await relay.start()
  try {
    const c = new Capture(S5, browser)
    c.mark('ensureRoom')
    await ensureRoom(ROOM)
    const a = await c.open('A', 'http://127.0.0.1:19740/media')
    c.mark('A.join')
    await a.call('join', ROOM, 'talk')
    const b = await c.open('B')
    c.mark('B.join')
    await b.call('join', ROOM, 'talk')
    c.mark('B.enableMic')
    await b.call('enableMic')
    await sleep(1_500)
    c.mark('A.cut')
    relay.cut()
    await expect.poll(() => a.call<{ state: string; recovering: boolean }>('session').then((s) => s.recovering), { timeout: 10_000 }).toBe(true)
    c.mark('A.recovering')
    await sleep(3_000)
    c.mark('A.restore')
    relay.restore()
    await expect.poll(() => a.call<{ state: string; recovering: boolean }>('session').then((s) => `${s.state}/${s.recovering}`), { timeout: 30_000 }).toBe('active/false')
    c.mark('A.recovered')
    await sleep(2_500)
    c.mark('collect')
    await c.finish('10', { room: ROOM, node: 'node-a', sfus: ids, server: { room: await snapshot(ROOM) } }, ids)
  } finally {
    await relay.stop()
  }
})

const S6 = new Scope('tournode')
scopes.push(S6)
test('TOUR-13 다른 node 의 방 — hub 사이 oxmesh', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  const ids = await sfuIds()
  const ROOM = roomOn('tournode', 'node-b', ids)
  const c = new Capture(S6, browser)
  c.mark('ensureRoom')
  await ensureRoom(ROOM)
  const a = await c.open('A')
  c.mark('A.join')
  await a.call('join', ROOM, 'talk')
  const b = await c.open('B')
  c.mark('B.join')
  await b.call('join', ROOM, 'talk')
  c.mark('B.enableMic')
  await b.call('enableMic')
  await expect.poll(async () => (await a.call<{ kind: string; id: string; packets: number | null }[]>('trackStats'))
    .filter((s) => s.kind === 'audio' && !s.id.startsWith('ptt-')).reduce((x, s) => x + (s.packets ?? 0), 0), { timeout: 15_000 }).toBeGreaterThan(0)
  c.mark('A.hearsB')
  await sleep(1_500)
  c.mark('collect')
  await c.finish('13', { room: ROOM, node: 'node-b', sfus: ids, server: { room: await snapshot(ROOM) } }, ids)
})

const S1T = new Scope('tourtcp')
scopes.push(S1T)
test('TOUR-02T 길이 둘일 때 — UDP 와 TCP 후보를 함께 내면 · TCP 만 남기면', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  const ids = await sfuIds()
  const ROOM = roomOn('tourtcp', 'node-a', ids)
  const c = new Capture(S1T, browser)
  c.mark('ensureRoom')
  await ensureRoom(ROOM)
  // A — QA 스위치로 서버 TCP 후보를 함께 낸다(상용 웹은 UDP 한 줄 · 연:RULE-LINK-SDP-COMMON)
  const a = await c.open('A', undefined, { iceTcp: true })
  c.mark('A.join')
  await a.call('join', ROOM, 'talk')
  c.mark('A.enableMic')
  await a.call('enableMic')
  await expect.poll(() => pairsOf(a).then((ps) => ps.filter((p) => p.nominated === true).length), { timeout: 15_000 }).toBeGreaterThan(0)
  c.mark('A.nominated')
  // B — UDP 후보를 걷어 TCP 만 남긴다(UDP 가 막힌 망의 형상)
  const b = await c.open('B', undefined, { iceTcp: true, dropUdpCandidate: true })
  c.mark('B.join')
  await b.call('join', ROOM, 'talk')
  c.mark('B.enableMic')
  await b.call('enableMic')
  await expect.poll(() => pairsOf(b).then((ps) => ps.filter((p) => p.nominated === true && p.remoteProtocol === 'tcp').length), { timeout: 20_000 }).toBeGreaterThan(0)
  c.mark('B.tcpNominated')
  await expect.poll(() => audioPackets(a), { timeout: 15_000 }).toBeGreaterThan(0)
  c.mark('A.hearsB')
  await sleep(12_500)
  c.mark('A.after12s')
  const ice = async (p: Participant) => ({ candidates: await p.call<string[]>('remoteCandidateLines'), pairs: await pairsOf(p) })
  await c.finish('02T', { room: ROOM, node: 'node-a', sfus: ids, ice: { A: await ice(a), B: await ice(b) }, server: { room: await snapshot(ROOM) } }, ids)
})

const S10 = new Scope('tourstall')
scopes.push(S10)
test('TOUR-11 전달 정체 — 발행자 장치가 죽으면 서버가 알리고 SDK 가 방을 다시 받는다', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  const ids = await sfuIds()
  const ROOM = roomOn('tourstall', 'node-a', ids)
  const c = new Capture(S10, browser)
  c.mark('ensureRoom')
  await ensureRoom(ROOM)
  const b = await c.open('B')
  c.mark('B.join.listen')
  await b.call('join', ROOM, 'listen')
  const a = await c.open('A')
  c.mark('A.join')
  await a.call('join', ROOM, 'talk')
  c.mark('A.enableMic')
  await a.call('enableMic')
  await expect.poll(() => audioPackets(b), { timeout: 15_000 }).toBeGreaterThan(0)
  c.mark('B.hearsA')
  await sleep(2_000)
  c.mark('A.killSource')
  await a.call('killSource')
  await expect.poll(() => b.call<unknown[]>('events', 'resync').then((e) => e.length), { timeout: 30_000 }).toBeGreaterThan(0)
  c.mark('B.resynced')
  await sleep(1_500)
  c.mark('collect')
  await c.finish('11', { room: ROOM, node: 'node-a', sfus: ids, server: { room: await snapshot(ROOM) } }, ids)
})

const S11 = new Scope('tourattr')
scopes.push(S11)
test('TOUR-06 트랙 속성을 산 채로 — 음소거 · 영상 멈춤 · 회의↔무전 · 마이크 전원', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  test.setTimeout(240_000) // cold 30초 둘 + keepWarm 32초
  const ids = await sfuIds()
  const R1 = roomOn('tourattr', 'node-a', ids, 0)
  const R2 = roomOn('tourattr', 'node-a', ids, 1)
  const c = new Capture(S11, browser)
  c.mark('ensureRoom')
  await ensureRoom(R1)
  await ensureRoom(R2)
  const a = await c.open('A')
  c.mark('A.join')
  await a.call('join', R1, 'talk')
  // B 는 adaptiveStream 을 끈다 — 타일 크기로 SDK 가 스스로 멈춤을 내지 않게(이 장은 손으로 멈춘다)
  const b = await c.open('B', undefined, { adaptiveStream: false })
  c.mark('B.join')
  await b.call('join', R1, 'talk')
  c.mark('A.enableMic')
  const mic = await a.call<{ id: string }>('enableMic')
  c.mark('A.enableCamera')
  const cam = await a.call<{ id: string }>('enableCamera', { simulcast: false })
  await expect.poll(() => videoOf(b).then((v) => v?.videoWidth ?? 0), { timeout: 20_000 }).toBeGreaterThan(0)
  c.mark('B.videoDecoded')
  await sleep(1_500)
  const muted = (want: boolean) => b.call<{ detail: { id: string; muted: boolean } }[]>('events', 'remoteMuted').then((e) => e.filter((x) => x.detail.id === mic.id && x.detail.muted === want).length)
  const active = (want: boolean) => b.call<{ detail: { id: string; active: boolean } }[]>('events', 'remoteActive').then((e) => e.filter((x) => x.detail.id === cam.id && x.detail.active === want).length)
  c.mark('A.mute')
  await a.call('setLocalMuted', mic.id, true)
  await expect.poll(() => muted(true), { timeout: 5_000 }).toBeGreaterThan(0)
  c.mark('B.sawMuted')
  await sleep(1_000)
  c.mark('A.unmute')
  await a.call('setLocalMuted', mic.id, false)
  await expect.poll(() => muted(false), { timeout: 5_000 }).toBeGreaterThan(0)
  c.mark('B.sawUnmuted')
  await sleep(1_000)
  c.mark('B.pauseVideo')
  await b.call('setLayer', cam.id, { paused: true })
  await sleep(2_500)
  c.mark('B.resumeVideo')
  await b.call('setLayer', cam.id, { paused: false })
  await sleep(2_500)
  c.mark('A.toHalf')
  await a.call('setLocalDuplex', cam.id, 'half')
  await expect.poll(() => active(false), { timeout: 5_000 }).toBeGreaterThan(0)
  c.mark('B.sawResting')
  await sleep(1_500)
  c.mark('A.toFull')
  await a.call('setLocalDuplex', cam.id, 'full')
  await expect.poll(() => active(true), { timeout: 5_000 }).toBeGreaterThan(0)
  c.mark('B.sawActive')
  await sleep(2_000)
  // 마이크 전원 — 무전 방 R2 에서 P 가 누르고 놓고 30초 쉬면 cold · 다시 누르면 재획득 · keepWarm 이면 안 내려간다
  const p = await c.open('P')
  c.mark('P.join')
  await p.call('join', R2, 'talk')
  const l = await c.open('L')
  c.mark('L.join')
  await l.call('join', R2, 'listen')
  await expect.poll(() => l.call<{ trusted: boolean }>('ptt', R2).then((s) => s.trusted)).toBe(true)
  const micOf = () => p.call<{ mic: string } | null>('ptt', R2).then((s) => s?.mic ?? null)
  let last: string | null = await micOf()
  c.mark(`P.mic=${last}`)
  const watch = setInterval(() => { void micOf().then((m) => { if (m !== last) { last = m; c.mark(`P.mic=${m}`) } }) }, 250)
  try {
    c.mark('P.press')
    await p.call('press', R2)
    await expect.poll(() => phase(p, R2)).toBe('has_permission')
    c.mark('P.granted')
    await expect.poll(() => slotPackets(l, R2), { timeout: 10_000 }).toBeGreaterThan(0)
    c.mark('L.slotFlowing')
    await sleep(1_000)
    c.mark('P.release')
    await p.call('release', R2)
    await expect.poll(() => micOf(), { timeout: 45_000, intervals: [500] }).toBe('cold')
    c.mark('P.cold')
    await sleep(1_000)
    c.mark('P.press.cold')
    await p.call('press', R2)
    await expect.poll(() => phase(p, R2)).toBe('has_permission')
    c.mark('P.granted.cold')
    const before = await slotPackets(l, R2)
    await expect.poll(() => slotPackets(l, R2), { timeout: 10_000 }).toBeGreaterThan(before)
    c.mark('L.slotFlowing.cold')
    await sleep(1_000)
    c.mark('P.release.cold')
    await p.call('release', R2)
    await expect.poll(() => micOf(), { timeout: 5_000 }).toBe('hot_standby')
    c.mark('P.keepWarm')
    await p.call('keepWarm', R2, 120_000)
    await sleep(32_000)
    c.mark(`P.after32s.mic=${await micOf()}`)
  } finally {
    clearInterval(watch)
  }
  c.mark('collect')
  await c.finish('06', { rooms: [R1, R2], node: 'node-a', sfus: ids, tracks: { mic: mic.id, cam: cam.id }, server: { r1: await snapshot(R1), r2: await snapshot(R2) } }, ids)
})
