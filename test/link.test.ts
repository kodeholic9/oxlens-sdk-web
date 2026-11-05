// author: kodeholic (powered by Claude)
// SDK:IMPL-LINK-PROJECTION — 연결(LINK) 영역 1층. 위가 지은 연결 클라 상태기 둘레의 손 결합(입구 표 · 효과 표 · 이음매 · 손잡이)을 잰다.
// ★입구는 위 결합(link_binding)의 ENTRY 를 지나는지 · 효과는 결합 plan() 이 낸 대로 SDK 가 하는지를 LINK 단위(SD-ENTRY-LINK-* · SD-EFFECT-LINK-* · K-sym-IMPL-LINK-PROJECTION-*)마다 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · ★진짜 PeerLink(internal/link/transport) 위에 가짜 RTCPeerConnection(이 파일 — platform/webrtc 가 부르는 전역).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWS, tick } from './_ws.js'
import { SA, up, joinBody, joinFrame, leaveFrame, note, mem, fakeTrack, BIND_OK, type Rig } from './_rig.js'
import { DC_OFFER } from './_fixtures.js'
import * as LINK from '../src/domain/gen/link_client.js'
import * as LB from '../src/domain/gen/link_binding.js'
import { worstIce } from '../src/internal/link/transport.js'
import { LocalCore } from '../src/domain/pub/local.js'
import { Op, type MlineEntry, type TrackEntry, type ServerConfig } from '../src/internal/wire/ws.js'
import type { LinkCore, LinkInfo } from '../src/domain/link/core.js'
import type { Room, RemoteTrack } from '../src/index.js'

test('연:RACE-LINK-STALE-SUSPECT — ICE 가 스스로 회복한 뒤 닿은 같은 세대의 suspect 는 복구를 한 번 더 시작한다(받아들인다 — 쓸데없는 ICE 재시작 한 번)', () => {
  let s = LINK.initial()
  s = LINK.iceDisc(s, false).s
  assert.equal(s.ls, 'WAIT')
  s = LINK.iceBack(s)!.s
  assert.equal(s.ls, 'OK', 'ICE 가 스스로 풀렸다 — 재시작이 없어 세대(ufrag)는 그대로다')
  const late = LINK.linkEvent(s, { ufrag: s.gen })
  assert.equal(late.label, 'LINK.C.OK.link_event', '흔들리던 때 낸 suspect 가 세대 견주기를 지난다')
  assert.deepEqual(late.out, [{ ws: 'HEARTBEAT', part: 'req' }])
  const alive = LINK.hbRes(late.s, {})
  assert.deepEqual(alive.out, [{ ws: 'ICE_RESTART', part: 'req' }], '멀쩡한 연결에 ICE 재시작 한 번')
  assert.equal(alive.s.dc, true, 'DTLS · 발언권 채널은 그대로다')
  assert.equal(alive.s.assoc, true)
  const older = LINK.linkEvent({ ...s, gen: s.gen + 1 }, { ufrag: s.gen })
  assert.equal(older.label, 'LINK.C.any.link_event_stale', 'ICE 재시작을 거친 세대의 옛 suspect 는 버린다 — 세대가 가르는 것은 이것뿐이다')
})

// ══ 가짜 RTCPeerConnection — platform/webrtc.createPeerConnection 이 부르는 전역 ════════════════

type Desc = { type: string; sdp?: string }

class FakeDC {
  /** 만든 시각(ms) — 다시 열기 시도 시각을 잰다 */
  readonly at = performance.now()
  readyState: RTCDataChannelState = 'connecting'
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  constructor(readonly label: string, readonly init: RTCDataChannelInit) {}
  open(): void { this.readyState = 'open'; this.onopen?.() }
  /** 브라우저가 채널을 닫았다 */
  drop(): void { this.readyState = 'closed'; this.onclose?.() }
  close(): void { this.readyState = 'closed' }
  send(): void { /* 보낸 것은 재지 않는다 */ }
}

class FakeSctp {
  state: RTCSctpTransportState = 'connected'
  onstatechange: (() => void) | null = null
  readonly transport = { state: 'connected' as RTCDtlsTransportState, onstatechange: null as (() => void) | null }
  set(s: RTCSctpTransportState): void { this.state = s; this.onstatechange?.() }
  dtls(s: RTCDtlsTransportState): void { this.transport.state = s; this.transport.onstatechange?.() }
}

interface FakeTr { mid: string | null; direction: string; receiver: { track: unknown; getStats(): Promise<unknown> }; sender: object }

class FakePC {
  static made: FakePC[] = []
  /** 다음 setRemoteDescription 몇 번을 깬다(협상 실패 주입) */
  static failNext = 0
  /** 걸어 두면 setRemoteDescription 이 이것을 기다린다(협상을 진행 중에 붙잡는다) */
  static gate: Promise<void> | null = null
  iceConnectionState: RTCIceConnectionState = 'new'
  signalingState: RTCSignalingState = 'stable'
  localDescription: Desc | null = null
  remoteDescription: Desc | null = null
  oniceconnectionstatechange: (() => void) | null = null
  ontrack: (() => void) | null = null
  sctp: FakeSctp | null = null
  closed = false
  readonly dcs: FakeDC[] = []
  readonly trs: FakeTr[] = []
  readonly offers: (RTCOfferOptions | undefined)[] = []
  readonly remotes: Desc[] = []
  constructor() { FakePC.made.push(this) }
  createDataChannel(label: string, init: RTCDataChannelInit): FakeDC { const d = new FakeDC(label, init); this.dcs.push(d); return d }
  addTransceiver(kind: string, init: { direction?: string }): FakeTr {
    const t: FakeTr = { mid: null, direction: init.direction ?? 'sendrecv', receiver: { track: fakeTrack(kind), getStats: async () => new Map() }, sender: {} }
    this.trs.push(t)
    return t
  }
  getTransceivers(): FakeTr[] { return this.trs }
  async createOffer(o?: RTCOfferOptions): Promise<Desc> { this.offers.push(o); return { type: 'offer', sdp: DC_OFFER } }
  async createAnswer(): Promise<Desc> { return { type: 'answer', sdp: this.remoteDescription?.sdp ?? '' } }
  async setLocalDescription(d: Desc): Promise<void> {
    if (d.type === 'rollback') { this.signalingState = 'stable'; return }
    this.localDescription = d
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(d: Desc): Promise<void> {
    if (FakePC.gate) await FakePC.gate
    if (FakePC.failNext > 0) { FakePC.failNext--; throw new Error('주입한 협상 실패') }
    this.remoteDescription = d
    this.remotes.push(d)
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'
    this.sctp ??= new FakeSctp()
    if (d.type !== 'offer') return
    // 서버 offer 의 절마다 수신 트랜시버(브라우저가 만든다)
    let kind = ''
    for (const l of (d.sdp ?? '').split('\r\n')) {
      if (l.startsWith('m=')) kind = l.slice(2).split(' ')[0]!
      const mid = l.startsWith('a=mid:') ? l.slice(6) : null
      if (mid !== null && kind !== 'application' && !this.trs.some((t) => t.mid === mid)) this.trs.push({ mid, direction: 'recvonly', receiver: { track: fakeTrack(kind), getStats: async () => new Map() }, sender: {} })
    }
  }
  async getStats(): Promise<Map<string, unknown>> { return new Map() }
  close(): void { this.closed = true; this.signalingState = 'closed' }
  ice(s: RTCIceConnectionState): void { this.iceConnectionState = s; this.oniceconnectionstatechange?.() }
}

;(globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePC

// ══ 받침 ═══════════════════════════════════════════════════════════════

/** 위 결합 ENTRY 의 입구마다 불린 인자(상태 뒤) · 돌려준 걸음 — SDK 사건이 결합 코드를 지났나 · plan() 이 무엇을 냈나를 잰다 */
function spyOn(): { calls: Record<string, unknown[][]>; steps: Record<string, (LINK.Step | null)[]>; n(k: string): number; reset(): void; restore(): void } {
  const E = LB.ENTRY as unknown as Record<string, (...a: unknown[]) => LINK.Step | null>
  const saved = { ...E }
  const calls: Record<string, unknown[][]> = {}
  const steps: Record<string, (LINK.Step | null)[]> = {}
  const reset = (): void => { for (const k of Object.keys(saved)) { calls[k] = []; steps[k] = [] } }
  reset()
  for (const k of Object.keys(saved)) {
    E[k] = (...a: unknown[]) => { calls[k]!.push(a.slice(1)); const s = saved[k]!(...a); steps[k]!.push(s); return s }
  }
  return { calls, steps, n: (k) => calls[k]?.length ?? 0, reset, restore: () => { Object.assign(E, saved) } }
}
type Spy = ReturnType<typeof spyOn>

/** 그 입구의 i 번째 걸음에 결합 plan() 이 낸 집행 목록 */
const planOf = (spy: Spy, k: string, i = -1): LB.Plan => LB.plan(spy.steps[k]!.at(i)!)

const OPTS = { wobblyGraceMs: 40, iceRestartTimeoutMs: 80, iceRestartBackoffMs: [0, 20], wsProbeTimeoutMs: 400, recoveryStableMs: 5000, dcReopen: { tries: 2, intervalMs: 30 }, unreachableAfter: 2, wakeDetectMs: 60_000 }

interface X { r: Rig; room: Room; link: LinkCore; pc: FakePC; links: LinkInfo[] }

/** 단언이 깨져도 클라이언트를 닫는다 — 남은 타이머가 시험 프로세스를 붙잡지 않게 */
const live: Rig[] = []
afterEach(async () => { for (const r of live.splice(0)) await r.c.close().catch(() => undefined) })

async function until(ok: () => boolean, ms = 1500): Promise<void> {
  for (let t = 0; t < ms && !ok(); t += 5) await tick(5)
  assert.ok(ok(), '시한 안에 조건이 서지 않았다')
}

/** 그 서버 PC 전부를 세운다 — ICE connected · DC open(SCTP · DTLS 는 협상 뒤 connected) */
async function stand(pcs: FakePC[]): Promise<void> {
  for (const p of pcs) if (!p.closed) p.ice('connected')
  for (const p of pcs) for (const d of p.dcs) if (d.readyState === 'connecting') d.open()
  await tick()
}

/** 2pc 로 방 하나에 들어가 연결을 세운다 — 진짜 LinkCore.adopt · 진짜 PeerLink · 가짜 PC */
async function upLink(o: { mlines?: MlineEntry[]; tracks?: TrackEntry[]; arev?: number; standUp?: boolean } & Record<string, unknown> = {}): Promise<X> {
  const { mlines, tracks, arev, standUp, ...opts } = o
  FakePC.made.length = 0
  FakePC.failNext = 0
  FakePC.gate = null
  const r = await up({ ...OPTS, ...opts })
  live.push(r)
  FakeWS.auto.set(Op.HEARTBEAT, {})
  FakeWS.auto.delete(Op.ICE_RESTART)
  const links: LinkInfo[] = []
  r.c.on('link', (i) => links.push(i))
  const p = r.c.join('r1')
  await tick()
  r.ws.answer(joinFrame(r.ws, 'r1'), joinBody(r, 'r1', { ...(mlines ? { mlines } : {}), ...(tracks ? { tracks } : {}), ...(arev ? { arev } : {}) }))
  const room = await p
  const link = r.core.links.get('sfu-a')!
  if (standUp !== false) await stand(FakePC.made)
  return { r, room, link, pc: FakePC.made[0]!, links }
}

const heartbeats = (x: X): number => x.r.ws.requests(Op.HEARTBEAT).length
const restarts = (x: X): number => x.r.ws.requests(Op.ICE_RESTART).length
const readies = (x: X): number => x.r.ws.requests(Op.READY).length
const lastLink = (x: X): LinkInfo => x.links.at(-1)!
const NEW_CREDS = { publish: { ufrag: 'pubUf2', pwd: 'pubPw2' }, subscribe: { ufrag: 'subUf2', pwd: 'subPw2' } }

/** 재시작 앞까지 — ICE failed → WS 점검 → 산다 → ICE_RESTART 요청 */
async function toRestart(x: X): Promise<void> {
  const n = restarts(x)
  x.pc.ice('failed')
  await until(() => restarts(x) > n)
}

/** ICE_RESTART 응답(새 자격) → APPLY · 협상 큐가 새 자격을 싣는다 */
async function answerRestart(x: X, body: unknown = NEW_CREDS, ok = true): Promise<void> {
  x.r.ws.reply(Op.ICE_RESTART, body, ok)
  await tick(); await tick()
}

const row = (mid: string, track_id: string | undefined, kind: 'audio' | 'video' = 'video'): MlineEntry => ({
  mid, kind, pt: kind === 'audio' ? 111 : 102, codec: kind === 'audio' ? 'opus' : 'H264', ssrc: 2147480000 + Number(mid), stream_id: `ox-m${mid}`,
  ...(track_id ? { track_id, room_id: 'r1' } : {}),
})
const tr = (id: string, o: Partial<TrackEntry> = {}): TrackEntry => ({ type: 'individual', room_id: 'r1', track_id: id, kind: 'video', user_id: 'u2', ...o })
const mline = (x: X, arev: number, mlines: MlineEntry[], sc: ServerConfig = SA): Promise<void> => note(x.r, Op.MLINE_EVENT, { table: { sfu_id: sc.sfu_id, arev, mlines } })
const trackEvent = (action: 'add' | 'remove', tracks: TrackEntry[], seq: number, epoch = 'e1') => ({ action, room_id: 'r1', tracks, version: { epoch, seq } })

/** 브라우저 사실 몇 갈래(흔들림 · 회복 · 낡은 의심) — 위 이음매 입구는 이것으로 불리지 않는다 */
async function barrage(x: X): Promise<void> {
  x.pc.ice('disconnected'); await tick()
  x.pc.ice('connected'); await tick()
  await note(x.r, Op.LINK_EVENT, { type: 'suspect', sfu_id: 'sfu-a', ufrag: 'old-ufrag' })
}

// ══ 입구 표 — 층별 사실 ══════════════════════════════════════════════════

test('SD-ENTRY-LINK-ICE-DISC — iceConnectionState disconnected(2pc 는 PC 둘을 나쁜 쪽으로 합친다)가 ENTRY.iceDisc 하나 · leaving = 그 서버 방이 전부 나가는 중', async () => {
  const spy = spyOn()
  try {
    const x = await upLink({ mlines: [row('0', undefined)] })
    const [pub, sub] = FakePC.made
    assert.ok(pub && sub && pub !== sub, '2pc — 발행 PC · 구독 PC 둘')
    assert.equal(x.link.state, 'up')
    spy.reset()
    sub!.ice('disconnected'); await tick()
    assert.equal(spy.n('iceDisc'), 1, 'SD-ENTRY-LINK-ICE-DISC — 구독 PC 만 disconnected(발행 PC connected)여도 나쁜 쪽으로 합쳐 ENTRY.iceDisc 하나')
    assert.deepEqual(spy.calls['iceDisc']![0], [false], 'SD-ENTRY-LINK-ICE-DISC — 읽는 칸 leaving(ROOM.rs) = 나가는 방 없음')
    assert.equal(x.link.state, 'wobbly')
    pub!.ice('disconnected'); await tick()
    assert.equal(spy.n('iceDisc'), 1, 'SD-ENTRY-LINK-ICE-DISC — 합친 사실이 그대로면 다시 넣지 않는다')
    assert.equal(worstIce(['connected', 'disconnected']), 'disconnected', 'SD-ENTRY-LINK-ICE-DISC — 2pc 합성은 나쁜 쪽')
    assert.equal(worstIce(['completed', 'connected']), 'connected')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-ICE-BACK — 기다림 안에 connected · completed 가 ENTRY.iceBack 하나 · 기다림 밖의 connected 는 넣지 않는다', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    spy.reset()
    x.pc.ice('connected'); x.pc.ice('checking'); await tick()
    assert.equal(spy.n('iceBack'), 0, 'SD-ENTRY-LINK-ICE-BACK — 기다림(WAIT) 밖에서는 넣지 않는다')
    x.pc.ice('connected'); await tick()
    x.pc.ice('disconnected'); await tick()
    const ready0 = readies(x)
    x.pc.ice('completed'); await tick(); await tick()
    assert.equal(spy.n('iceBack'), 1, 'SD-ENTRY-LINK-ICE-BACK — 기다림 안의 completed 가 ENTRY.iceBack 하나')
    assert.equal(x.link.state, 'up')
    assert.equal(readies(x) - ready0, 1, 'SD-ENTRY-LINK-ICE-BACK — 위가 낸 READY(발언권 다시 맞추기)')
    await tick(OPTS.wobblyGraceMs + 20)
    assert.equal(spy.n('waitOver'), 0, 'SD-ENTRY-LINK-ICE-BACK — 기다림이 풀렸으니 만료가 없다')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-WAIT-OVER — wobblyGraceMs 만료 · failed 가 각각 ENTRY.waitOver 하나(failed 인자) · WS 점검을 낸다', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    spy.reset()
    const hb0 = heartbeats(x)
    x.pc.ice('disconnected'); await tick(OPTS.wobblyGraceMs / 2)
    assert.equal(spy.n('waitOver'), 0, 'SD-ENTRY-LINK-WAIT-OVER — 기다림 손잡이(wobblyGraceMs) 전에는 넣지 않는다')
    await until(() => spy.n('waitOver') === 1)
    assert.deepEqual(spy.calls['waitOver']![0], [false, false], 'SD-ENTRY-LINK-WAIT-OVER — 만료는 failed 거짓')
    assert.equal(x.link.state, 'restarting')
    await until(() => heartbeats(x) > hb0)
    await x.r.c.close()
    const y = await upLink()
    spy.reset()
    y.pc.ice('failed'); await tick()
    assert.equal(spy.n('waitOver'), 1, 'SD-ENTRY-LINK-WAIT-OVER — failed 는 기다리지 않고 ENTRY.waitOver 하나')
    assert.deepEqual(spy.calls['waitOver']![0], [true, false], 'SD-ENTRY-LINK-WAIT-OVER — failed 참')
    assert.equal(y.link.state, 'restarting')
    await y.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-LINK-EVENT①②③ — LINK_EVENT{suspect} 가 ENTRY.linkEvent 하나 · ①지금 세대 → restarting(위 앱 효과 0) ②옛 세대 → 버림 ③복구 중 → 흡수(복구 시작 1회)', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    spy.reset()
    const hb0 = heartbeats(x)
    await note(x.r, Op.LINK_EVENT, { type: 'suspect', sfu_id: 'sfu-a', ufrag: 'pubUf1' })
    assert.equal(spy.n('linkEvent'), 1, 'SD-ENTRY-LINK-LINK-EVENT — 통지 하나에 ENTRY.linkEvent 하나')
    assert.equal(x.link.state, 'restarting', 'SD-ENTRY-LINK-LINK-EVENT① — 지금 세대면 restarting')
    assert.deepEqual(spy.steps['linkEvent']![0]!.fx, [], 'SD-ENTRY-LINK-LINK-EVENT① — 위 앱 효과 0')
    await until(() => heartbeats(x) > hb0)
    await x.r.c.close()

    const y = await upLink()
    spy.reset()
    const hb1 = heartbeats(y)
    await note(y.r, Op.LINK_EVENT, { type: 'suspect', sfu_id: 'sfu-a', ufrag: 'pubUf0-old' })
    assert.equal(spy.n('linkEvent'), 1)
    assert.equal(y.link.state, 'up', 'SD-ENTRY-LINK-LINK-EVENT② — 옛 세대는 버린다')
    await tick(30)
    assert.equal(heartbeats(y), hb1, 'SD-ENTRY-LINK-LINK-EVENT② — 복구 시작 0(WS 점검 0)')

    y.pc.ice('disconnected'); await tick()
    await note(y.r, Op.LINK_EVENT, { type: 'suspect', sfu_id: 'sfu-a', ufrag: 'subUf1' })
    assert.equal(spy.n('linkEvent'), 2)
    assert.equal(y.link.state, 'wobbly', 'SD-ENTRY-LINK-LINK-EVENT③ — 복구(기다림) 중이면 흡수')
    assert.equal(heartbeats(y), hb1, 'SD-ENTRY-LINK-LINK-EVENT③ — 흡수 — 새 복구 0')
    await until(() => heartbeats(y) > hb1)
    await tick(20)
    assert.equal(heartbeats(y) - hb1, 1, 'SD-ENTRY-LINK-LINK-EVENT③ — 복구 시작 1회(기다림 만료의 WS 점검 하나)')
    await y.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-HB-RES — 재시작 앞 WS 점검의 하트비트 응답이 ENTRY.hbRes 하나 · ICE_RESTART 를 낸다', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    spy.reset()
    x.pc.ice('failed'); await tick()
    assert.equal(spy.n('hbRes'), 0, 'SD-ENTRY-LINK-HB-RES — 응답 전 0')
    await until(() => spy.n('hbRes') === 1)
    assert.deepEqual(spy.calls['hbRes']![0], [{}], 'SD-ENTRY-LINK-HB-RES — 하트비트 응답 하나에 ENTRY.hbRes 하나')
    await until(() => restarts(x) === 1)
    assert.equal(x.link.st.ls, 'RESTART')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-RESTART-RES — ICE_RESTART 응답 하나에 ENTRY.restartRes 하나 · 성공은 part res(새 세대) · 5xxx 는 part fail(다시 점검)', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    await toRestart(x)
    spy.reset()
    await answerRestart(x)
    assert.equal(spy.n('restartRes'), 1, 'SD-ENTRY-LINK-RESTART-RES — 응답 하나에 ENTRY.restartRes 하나')
    const m = spy.calls['restartRes']![0]![0] as { code: number; part: string; pid: number; publish: { ufrag: number } }
    assert.deepEqual([m.code, m.part, m.pid], [0, 'res', 1], 'SD-ENTRY-LINK-RESTART-RES — 성공 · 그 요청의 pid')
    assert.equal(m.publish.ufrag, x.r.core.epochs.id('ufrag:pubUf2'), 'SD-ENTRY-LINK-RESTART-RES — 새 자격의 세대')
    assert.equal(x.link.st.ls, 'APPLY')
    await x.r.c.close()

    const y = await upLink()
    await toRestart(y)
    spy.reset()
    const hb0 = heartbeats(y)
    await answerRestart(y, { code: 5001, name: 'INTERNAL', permanent: false }, false)
    assert.equal(spy.n('restartRes'), 1)
    assert.deepEqual((spy.calls['restartRes']![0]![0] as { code: number; part: string }), { code: 5001, part: 'fail', pid: 1, publish: { ufrag: 0 } }, 'SD-ENTRY-LINK-RESTART-RES — 실패는 part fail · 앞자리 뜻은 위가 가른다')
    assert.equal(y.link.st.ls, 'CHECK')
    await until(() => heartbeats(y) > hb0)
    await y.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-APPLY-TIMEOUT — 새 자격 적용 뒤 iceRestartTimeoutMs 안에 안 서면 ENTRY.applyTimeout 하나 · 다시 점검', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    await toRestart(x)
    await answerRestart(x)
    spy.reset()
    const hb0 = heartbeats(x)
    await tick(OPTS.iceRestartTimeoutMs / 2)
    assert.equal(spy.n('applyTimeout'), 0, 'SD-ENTRY-LINK-APPLY-TIMEOUT — 시한 전 0')
    await until(() => spy.n('applyTimeout') === 1)
    assert.equal(spy.steps['applyTimeout']![0] !== null, true, 'SD-ENTRY-LINK-APPLY-TIMEOUT — 시한 만료가 ENTRY.applyTimeout 하나(위가 받았다)')
    assert.equal(x.link.state, 'restarting')
    await until(() => heartbeats(x) > hb0)
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-APPLIED — 재시작 협상이 끝난 뒤 connected 가 ENTRY.applied 하나 · up · READY', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    await toRestart(x)
    await answerRestart(x)
    spy.reset()
    assert.equal(x.link.st.nego, false, '새 자격을 실은 협상이 끝났다')
    const ready0 = readies(x)
    x.pc.ice('checking'); await tick()
    assert.equal(spy.n('applied'), 0, 'SD-ENTRY-LINK-APPLIED — connected 전 0')
    x.pc.ice('connected'); await tick(); await tick()
    assert.equal(spy.n('applied'), 1, 'SD-ENTRY-LINK-APPLIED — connected 가 ENTRY.applied 하나')
    assert.equal(x.link.state, 'up')
    assert.equal(x.link.st.gen, x.r.core.epochs.id('ufrag:pubUf2'), 'SD-ENTRY-LINK-APPLIED — 새 세대가 선다')
    assert.equal(readies(x) - ready0, 1)
    await tick(OPTS.iceRestartTimeoutMs + 20)
    assert.equal(spy.n('applyTimeout'), 0, 'SD-ENTRY-LINK-APPLIED — 시한이 멈췄다')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-ASSOC-LOST — SCTP closed · DTLS closed/failed 가 각각 ENTRY.assocLost 하나 · 재구축', async () => {
  const spy = spyOn()
  try {
    for (const hit of ['sctp', 'dtls-failed', 'dtls-closed'] as const) {
      const x = await upLink()
      spy.reset()
      if (hit === 'sctp') x.pc.sctp!.set('closed')
      else x.pc.sctp!.dtls(hit === 'dtls-failed' ? 'failed' : 'closed')
      await tick()
      assert.equal(spy.n('assocLost'), 1, `SD-ENTRY-LINK-ASSOC-LOST — ${hit} 가 ENTRY.assocLost 하나`)
      assert.deepEqual(spy.calls['assocLost']![0], [false])
      assert.equal(x.link.state, 'rebuilding')
      await x.r.c.close()
    }
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-DC-CLOSED — DC closed · SCTP connected 면 ENTRY.dcClosed 하나 · iceDisc 0', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    spy.reset()
    assert.equal(x.pc.sctp!.state, 'connected')
    x.pc.dcs[0]!.drop(); await tick()
    assert.equal(spy.n('dcClosed'), 1, 'SD-ENTRY-LINK-DC-CLOSED — DC 만 닫히면 ENTRY.dcClosed 하나')
    assert.equal(spy.n('iceDisc'), 0, 'SD-ENTRY-LINK-DC-CLOSED — ICE 사실과 가른다(iceDisc 0)')
    assert.equal(spy.n('assocLost'), 0)
    assert.equal(x.link.state, 'wobbly')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-REOPENED — 같은 PC 위 새 DC 의 결과가 ENTRY.reopened 하나씩 · r = ok / fail / exhausted(dcReopen 소진)', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    spy.reset()
    x.pc.dcs[0]!.drop(); await tick()
    await until(() => x.pc.dcs.length === 2)
    x.pc.dcs[1]!.open(); await tick()
    assert.deepEqual(spy.calls['reopened'], [['ok']], 'SD-ENTRY-LINK-REOPENED — 새 DC open 이면 r = ok')
    assert.equal(x.link.state, 'up')
    await x.r.c.close()

    const y = await upLink()
    spy.reset()
    y.pc.dcs[0]!.drop(); await tick()
    await until(() => spy.n('reopened') === 2, 2000)
    assert.deepEqual(spy.calls['reopened'], [['fail'], ['exhausted']], 'SD-ENTRY-LINK-REOPENED — 시한까지 open 이 없으면 fail · tries 번째 실패는 exhausted')
    assert.equal(y.link.state, 'rebuilding')
    await y.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-REBUILT — 재구축의 새 PeerLink 결과가 ENTRY.rebuilt 하나 · g = 새 자격의 세대 · stood = ICE 가 섰다', async () => {
  const spy = spyOn()
  try {
    for (const stood of [true, false]) {
      const x = await upLink()
      x.pc.sctp!.set('closed'); await tick()
      assert.equal(x.link.state, 'rebuilding')
      const trustBefore = x.r.c.rooms.get('r1')?.ptt.state.trusted
      await until(() => x.r.ws.requests(Op.ROOM_JOIN).length === 2)
      assert.equal((joinFrame(x.r.ws, 'r1').body as { join_id?: string }).join_id, 'j-r1', '재구축의 다시 입장은 갈아 끼울 입장의 join_id 를 싣는다(연:RULE-ROOM-JOIN-REPLACE)')
      spy.reset()
      const sc: ServerConfig = { ...SA, ice: { ...SA.ice, publish_ufrag: 'pubUf9' } }
      x.r.ws.answer(joinFrame(x.r.ws, 'r1'), joinBody(x.r, 'r1', { sc, arev: 2, jid: 'j-r1-new' }))
      await until(() => FakePC.made.length === 2 && FakePC.made[1]!.remoteDescription !== null)
      await tick()
      const fresh = FakePC.made[1]!
      assert.equal(x.link.peer !== null && x.pc.closed, true, '옛 PC 는 닫혔고 새 PeerLink 가 섰다')
      if (stood) await stand([fresh])
      else { fresh.ice('failed'); await tick() }
      assert.equal(spy.n('rebuilt'), 1, `SD-ENTRY-LINK-REBUILT — 새 연결의 결과(stood=${stood})가 ENTRY.rebuilt 하나`)
      assert.deepEqual(spy.calls['rebuilt']![0], [x.r.core.epochs.id('ufrag:pubUf9'), stood], 'SD-ENTRY-LINK-REBUILT — g = 새 자격의 세대 · stood')
      assert.equal(x.link.state, stood ? 'up' : 'restarting')
      assert.equal(x.r.core.rooms.get('r1')?.joinId, 'j-r1-new', '갈아 끼운 입장의 응답이 준 새 join_id 를 뒤 요청이 싣는다(연:RULE-ROOM-JOIN-ID)')
      if (stood) assert.deepEqual([trustBefore, x.r.c.rooms.get('r1')?.ptt.state.trusted], [false, true], 'K-sym-RULE-FLR-ROOM-SWITCH-2 — DC 소진 · 연관 소멸로 재구축되면 trusted 거짓 · 새 연결의 DC 가 서면 참(연:LINK.C.REBUILD.rebuilt 의 floor.dc_up — 거짓에 남으면 canRequest 가 막혀 PTT 를 못 누른다)')
      await x.r.c.close()
    }
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-SERVER-ICE — 입장 응답의 자격이 같으면 ENTRY.serverIce(fresh 거짓) · 재구축이 아닌데 다르면(옛 Peer 축출) fresh 참 → LINK.C.any.peer_replaced · 그 서버 발행 전부 다시(pub.reregister_server) · 방 다시 입장(rooms.rejoin_server) 0', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    const media = x.r.core.media as unknown as { reregisterAll(s: string | null): void }
    const orig = media.reregisterAll.bind(media)
    let rereg = 0
    media.reregisterAll = (s) => { rereg++; orig(s) }
    let p = x.r.c.join('r2'); await tick()
    x.r.ws.answer(joinFrame(x.r.ws, 'r2'), joinBody(x.r, 'r2', { subs: ['r1', 'r2'] })); await p; await tick()
    assert.equal(spy.calls['serverIce']!.at(-1)![0], false, 'SD-ENTRY-LINK-SERVER-ICE — 같은 Peer(같은 자격)면 fresh 거짓')
    assert.equal(planOf(spy, 'serverIce').label, 'LINK.C.any.server_ice_same')
    const madeBefore = FakePC.made.length
    p = x.r.c.join('r3'); await tick()
    const sc: ServerConfig = { ...SA, ice: { ...SA.ice, publish_ufrag: 'pubUf7' } }
    x.r.ws.answer(joinFrame(x.r.ws, 'r3'), joinBody(x.r, 'r3', { sc, subs: ['r3'] })); await p; await tick()
    assert.ok(FakePC.made.length > madeBefore, '새 자격 — 새 PeerLink 로 갈아 끼웠다(LinkCore.adopt)')
    assert.deepEqual(spy.calls['serverIce']!.at(-1), [true, x.r.core.epochs.id('ufrag:pubUf7')], 'SD-ENTRY-LINK-SERVER-ICE — fresh 참 · g = 새 자격의 세대')
    assert.equal(planOf(spy, 'serverIce').label, 'LINK.C.any.peer_replaced', '연:RULE-ROOM-JOIN-PROC — 옛 Peer 축출')
    assert.equal(rereg, 1, '연:RULE-ROOM-JOIN-PROC — 그 서버 발행을 전부 다시 건다(갈아 끼우기만 하면 서버엔 발행이 없다)')
    assert.ok(!planOf(spy, 'serverIce').seams.some((s) => s.fx === 'rooms.rejoin_server'), '방은 다시 들어가지 않는다 — 그 입장이 또 옛 Peer 를 축출한다')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-NEGO-RES — 협상 큐의 결과가 ENTRY.negoRes 하나 · ok 참 / 거짓', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    spy.reset()
    await mline(x, 2, [row('0', undefined)])
    await until(() => spy.n('negoRes') === 1)
    assert.deepEqual(spy.calls['negoRes']![0], [true], 'SD-ENTRY-LINK-NEGO-RES — 협상 성공이 ENTRY.negoRes(ok 참) 하나')
    const errs: unknown[] = []
    x.room.on('error', (e) => errs.push(e))
    FakePC.failNext = 1
    await mline(x, 3, [row('0', undefined), row('1', undefined)])
    await until(() => spy.n('negoRes') === 2)
    assert.deepEqual(spy.calls['negoRes']![1], [false], 'SD-ENTRY-LINK-NEGO-RES — 협상 실패가 ENTRY.negoRes(ok 거짓) 하나')
    assert.equal(errs.length, 1, '재조립 협상 실패는 그 서버 방의 room.error')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-MLINE-EVENT①②③ — 배정표 통지 하나에 ENTRY.mlineEvent 하나 · ①줄 생김 → 협상 뒤 track ②줄 잃음: 쉬는 트랙 → 같은 핸들 active · 그 밖 → ended + trackUnreachable ③낡은 arev → 반영 0', async () => {
  const spy = spyOn()
  try {
    const x = await upLink()
    const got: RemoteTrack[] = []
    const negoAt: number[] = []
    const unreachable: string[] = []
    x.room.on('track', (t) => { got.push(t); negoAt.push(spy.n('negoRes')) })
    x.room.on('trackUnreachable', (i) => unreachable.push(i.id))
    await note(x.r, Op.TRACK_EVENT, trackEvent('add', [tr('t2')], 2))
    assert.deepEqual(unreachable, ['t2'], '줄 없이 온 트랙')
    spy.reset()
    await mline(x, 2, [row('0', 't2')])
    assert.equal(spy.n('mlineEvent'), 1, 'SD-ENTRY-LINK-MLINE-EVENT — 통지 하나에 ENTRY.mlineEvent 하나')
    await until(() => got.length === 1)
    assert.equal(got[0]!.id, 't2')
    assert.ok(negoAt[0]! >= 1, 'SD-ENTRY-LINK-MLINE-EVENT① — 줄 생김 → 협상(negoRes) 뒤 track')

    await mline(x, 3, [row('0', 't2'), row('1', 't3')])
    await tick(); await tick()
    await note(x.r, Op.TRACK_EVENT, trackEvent('add', [tr('t3')], 3))
    await until(() => got.length === 2)
    const [t2, t3] = got as [RemoteTrack, RemoteTrack]
    const act: boolean[] = []
    let ended2 = 0
    let ended3 = 0
    t2.on('active', (a) => act.push(a.active))
    t2.on('ended', () => { ended2 += 1 })
    t3.on('ended', () => { ended3 += 1 })
    await note(x.r, Op.TRACK_EVENT, trackEvent('add', [tr('t2', { active: false })], 4))
    unreachable.length = 0
    const n0 = spy.n('mlineEvent')
    await mline(x, 4, [row('0', undefined), row('1', undefined)])
    await tick(); await tick()
    assert.equal(spy.n('mlineEvent') - n0, 1)
    assert.deepEqual([act, ended2], [[false], 0], 'SD-ENTRY-LINK-MLINE-EVENT② — 쉬는 트랙이 줄을 잃으면 같은 핸들(active false) · ended 0')
    assert.deepEqual([ended3, unreachable], [1, ['t3']], 'SD-ENTRY-LINK-MLINE-EVENT② — 받던 트랙이 줄을 잃으면 ended + trackUnreachable')
    assert.equal(x.room.tracks.some((t) => t.id === 't3'), false)

    const sub = FakePC.made[1]!
    const offers = sub.remotes.length
    const arev = x.link.table.arev
    await mline(x, 2, [row('0', 't3')])
    await tick(); await tick()
    assert.equal(spy.n('mlineEvent') - n0, 2, '낡은 표도 ENTRY.mlineEvent 하나')
    assert.equal(x.link.table.arev, arev, 'SD-ENTRY-LINK-MLINE-EVENT③ — 낡은 arev 는 반영 0(표 그대로)')
    assert.equal(sub.remotes.length, offers, 'SD-ENTRY-LINK-MLINE-EVENT③ — 재협상 0')
    assert.equal(got.length, 2, 'SD-ENTRY-LINK-MLINE-EVENT③ — 새 핸들 0')
    await x.r.c.close()
  } finally { spy.restore() }
})

// ══ 입구 표 — 위 이음매(REACTS) ════════════════════════════════════════════

test('SD-ENTRY-LINK-CLOSE-ALL — 세션이 미디어를 전부 닫으면(위 이음매 media.close_all) ENTRY.closeAll 하나 · SDK 사건으로 넣는 곳 0', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LINK.REACTS.closeAll, ['SES:media.close_all'], 'SD-ENTRY-LINK-CLOSE-ALL — 위가 정한 부르는 곳 하나')
    const x = await upLink()
    spy.reset()
    await barrage(x)
    assert.equal(spy.n('closeAll'), 0, 'SD-ENTRY-LINK-CLOSE-ALL — 브라우저 사실 · 통지로 넣는 곳 0')
    x.r.ws.close()
    await until(() => FakeWS.made.length === 2 && FakeWS.made[1]!.readyState === 0)
    const ws = FakeWS.made[1]!
    ws.open(); await tick()
    ws.reply(Op.BIND, { ...BIND_OK, session_id: 's-2' }); await tick(); await tick()
    assert.equal(spy.n('closeAll'), 1, 'SD-ENTRY-LINK-CLOSE-ALL — 세션 재구축(bind_new)의 media.close_all 이 ENTRY.closeAll 하나')
    assert.equal(x.pc.closed, true)
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-ROOM-LEFT — 그 서버 방 하나를 떠나면(위 이음매 link.room_left) ENTRY.roomLeft 하나 · last = 남은 방 없음', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LINK.REACTS.roomLeft, ['ROOM:link.room_left'], 'SD-ENTRY-LINK-ROOM-LEFT — 위가 정한 부르는 곳 하나')
    const x = await upLink()
    const p2 = x.r.c.join('r2'); await tick()
    x.r.ws.answer(joinFrame(x.r.ws, 'r2'), joinBody(x.r, 'r2'))
    const r2 = await p2
    spy.reset()
    const l1 = x.room.leave(); await tick()
    x.r.ws.answer(leaveFrame(x.r.ws, 'r1'), {}); await l1; await tick()
    assert.deepEqual(spy.calls['roomLeft'], [[false]], 'SD-ENTRY-LINK-ROOM-LEFT — 방이 남으면 last 거짓')
    assert.equal(x.pc.closed, false)
    const l2 = r2.leave(); await tick()
    x.r.ws.answer(leaveFrame(x.r.ws, 'r2'), {}); await l2; await tick()
    assert.deepEqual(spy.calls['roomLeft'], [[false], [true]], 'SD-ENTRY-LINK-ROOM-LEFT — 마지막 방이면 last 참')
    assert.equal(x.pc.closed, true, '마지막 방이면 PeerLink 를 닫는다')
    assert.equal(x.r.core.links.has('sfu-a'), false)
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-REPAIR — 이어받기 성공 뒤(위 이음매 media.repair) ENTRY.repair 하나 · SDK 사건으로 넣는 곳 0', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LINK.REACTS.repair, ['SES:media.repair'], 'SD-ENTRY-LINK-REPAIR — 위가 정한 부르는 곳 하나')
    const x = await upLink()
    spy.reset()
    await barrage(x)
    assert.equal(spy.n('repair'), 0, 'SD-ENTRY-LINK-REPAIR — 브라우저 사실 · 통지로 넣는 곳 0')
    x.r.ws.close()
    x.pc.ice('failed'); await tick()
    await until(() => FakeWS.made.length === 2 && FakeWS.made[1]!.readyState === 0)
    const ws = FakeWS.made[1]!
    ws.open(); await tick()
    ws.reply(Op.BIND, BIND_OK); await tick(); await tick()
    assert.equal(spy.n('repair'), 0, '응답 전 0')
    ws.reply(Op.RESUME, { snapshot: { r1: { participants: [mem('u1')], me: mem('u1'), tracks: [], version: { epoch: 'e1', seq: 1 } } }, publications: [], mline_tables: [] })
    await tick(); await tick()
    assert.equal(spy.n('repair'), 1, 'SD-ENTRY-LINK-REPAIR — 죽은 연결이 있는 이어받기 응답의 media.repair 가 ENTRY.repair 하나')
    assert.equal(x.link.st.ls, 'RESTART', '층별 판정 — ICE 가 죽었으면 재시작')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-EPOCH-CHANGED — 그 서버 방의 epoch 가 바뀌면(위 이음매 link.epoch_changed) ENTRY.epochChanged 하나 · SDK 사건으로 넣는 곳 0', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LINK.REACTS.epochChanged, ['ROOM:link.epoch_changed'], 'SD-ENTRY-LINK-EPOCH-CHANGED — 위가 정한 부르는 곳 하나')
    const x = await upLink()
    spy.reset()
    await barrage(x)
    assert.equal(spy.n('epochChanged'), 0, 'SD-ENTRY-LINK-EPOCH-CHANGED — 브라우저 사실 · 통지로 넣는 곳 0')
    await note(x.r, Op.TRACK_EVENT, trackEvent('add', [tr('t5')], 2, 'e2'))
    assert.equal(spy.n('epochChanged'), 1, 'SD-ENTRY-LINK-EPOCH-CHANGED — 방 상태기의 delta_epoch 이음매가 ENTRY.epochChanged 하나')
    assert.equal(x.link.state, 'rebuilding')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-PUB-LOST — 이어받기 응답에 내 발행이 없으면(위 이음매 link.pub_lost) ENTRY.pubLost 하나 · SDK 사건으로 넣는 곳 0', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LINK.REACTS.pubLost, ['PUB:link.pub_lost'], 'SD-ENTRY-LINK-PUB-LOST — 위가 정한 부르는 곳 하나')
    const x = await upLink()
    spy.reset()
    await barrage(x)
    assert.equal(spy.n('pubLost'), 0, 'SD-ENTRY-LINK-PUB-LOST — 브라우저 사실 · 통지로 넣는 곳 0')
    const t = new LocalCore(x.r.core.media, 'audio', 'external', fakeTrack('audio') as unknown as MediaStreamTrack, 'external', {})
    t.st = { ...t.st, ps: 'REGISTERED' }
    t.sfuId = 'sfu-a'
    t.resumeCheck(false, false)
    assert.equal(spy.n('pubLost'), 1, 'SD-ENTRY-LINK-PUB-LOST — 발행 상태기의 resume_unlisted 이음매가 그 서버 ENTRY.pubLost 하나')
    assert.equal(x.link.state, 'rebuilding')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-RENEGO — SDP 다시 조립 요청(위 이음매 sdp.rebuild)이 ENTRY.renego 하나 · 협상 중이면 끝난 뒤 한 번 더', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LINK.REACTS.renego, ['ROOM:sdp.rebuild', 'PUB:sdp.rebuild', 'SUB:sdp.rebuild'], 'SD-ENTRY-LINK-RENEGO — 위가 정한 부르는 곳')
    const x = await upLink()
    spy.reset()
    let open!: () => void
    FakePC.gate = new Promise<void>((r) => { open = r })
    await mline(x, 2, [row('0', undefined)])
    assert.equal(spy.n('renego'), 1, 'SD-ENTRY-LINK-RENEGO — 구독 이음매 sdp.rebuild 가 ENTRY.renego 하나')
    assert.equal(x.link.st.nego, true, '협상 진행 중')
    await mline(x, 3, [row('0', undefined), row('1', undefined)])
    assert.equal(spy.n('renego'), 2)
    assert.equal(x.link.st.dirty, true, 'SD-ENTRY-LINK-RENEGO — 협상 중에 온 요청은 큐에 적힌다')
    FakePC.gate = null
    open()
    await until(() => spy.n('negoRes') === 2)
    await tick()
    const sub = FakePC.made[1]!
    assert.equal(sub.remotes.filter((d) => d.type === 'offer').length, 2, 'SD-ENTRY-LINK-RENEGO — 끝난 뒤 한 번 더(두 요청이 협상 둘)')
    assert.match(sub.remoteDescription!.sdp!, /a=mid:1/, '마지막 협상이 마지막 표를 실었다')
    assert.equal(x.link.st.nego, false)
    await x.r.c.close()
  } finally { spy.restore() }
})

test('연:RULE-LINK-SDP-RENEGOTIATE 큐 — 협상 중에 온 표는 중간 끝(nego_ok_next)에 READY 0 · 큐가 빈 끝에 READY 하나(그때의 가장 새 arev) · 중간 끝의 이음매에 sub.* · pub.* 0', async () => {
  // 생성 상태기 — 중간 끝은 구독 · 발행에 알리지 않는다(실측 20261103: 입장 응답과 남의 영상 발행이 6ms 겹쳐 arev 2 acked 1 · 영구 검은 화면)
  const dirty = { ...LINK.initial(), nego: true, dirty: true }
  const mid = LINK.negoRes(dirty, true)
  assert.equal(mid.label, 'LINK.C.any.nego_ok_next')
  assert.deepEqual(mid.seams, [], '중간 끝(성공) — sub.nego_ok · pub.nego_ok 0')
  const midFail = LINK.negoRes(dirty, false)
  assert.equal(midFail.label, 'LINK.C.any.nego_fail_next')
  assert.deepEqual(midFail.seams, [], '중간 끝(실패) — sub.nego_fail · pub.nego_fail 0')
  const last = LINK.negoRes({ ...LINK.initial(), nego: true, dirty: false }, true)
  assert.equal(last.label, 'LINK.C.any.nego_ok')
  assert.deepEqual(last.seams.map((s) => s.fx).sort(), ['pub.nego_ok', 'sub.nego_ok'], '큐가 빈 끝 — 둘 다 알린다')

  const spy = spyOn()
  try {
    const x = await upLink()
    spy.reset()
    const ready0 = readies(x)
    let open1!: () => void
    FakePC.gate = new Promise<void>((r) => { open1 = r })
    await mline(x, 2, [row('0', undefined)])                       // 협상 1 시작(표 2)
    await mline(x, 3, [row('0', undefined), row('1', undefined)])  // 협상 중에 표 3 — 큐
    assert.equal(x.link.st.dirty, true)
    let open2!: () => void
    FakePC.gate = new Promise<void>((r) => { open2 = r })           // 협상 2 는 열 때까지 기다린다
    open1()
    await until(() => spy.n('negoRes') === 1)
    await tick()
    assert.equal(readies(x) - ready0, 0, '중간 끝 — READY 0(보내면 표 3 을 못 싣고 다음 끝엔 READY 가 없다)')
    assert.equal(x.room.core.trk.sub.st.ready, 'WANT', '구독은 WANT 그대로')
    open2()
    await until(() => spy.n('negoRes') === 2)
    await tick()
    assert.equal(readies(x) - ready0, 1, '큐가 빈 끝 — READY 하나')
    assert.equal((x.r.ws.last(Op.READY).body as { arev: number }).arev, 3, 'READY 는 그때의 가장 새 표(arev 3)')
    assert.equal(x.link.st.nego, false)
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-LINK-TABLE-CARRIED — 입장 응답이 실어 온 배정표가 ENTRY.tableCarried 하나(arev · 줄 · 줄 수) · 어느 길이든 새 차례 번호가 이긴다', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LINK.REACTS.tableCarried, ['ROOM:link.table'], 'SD-ENTRY-LINK-TABLE-CARRIED — 위가 정한 부르는 곳 하나')
    const x = await upLink({ arev: 5, mlines: [row('0', 't2')] })
    const c = spy.calls['tableCarried']!.at(-1)!
    assert.equal(c[0], 5, 'SD-ENTRY-LINK-TABLE-CARRIED — 인자: 차례 번호')
    assert.deepEqual(c[1], { t2: 0 }, 'SD-ENTRY-LINK-TABLE-CARRIED — 인자: 줄(트랙 → mid)')
    assert.equal(typeof c[2], 'number', 'SD-ENTRY-LINK-TABLE-CARRIED — 인자: SDP 재료(줄 수 · 튜플)')
    assert.equal(x.link.table.arev, 5)
    await mline(x, 4, [row('0', 't9')])
    assert.equal(x.link.table.arev, 5, '통지가 낡았으면 진다')
    await mline(x, 6, [row('0', 't2'), row('1', 't3')])
    assert.equal(x.link.table.arev, 6, '통지가 새면 이긴다')
    spy.reset()
    const p2 = x.r.c.join('r2'); await tick()
    x.r.ws.answer(joinFrame(x.r.ws, 'r2'), joinBody(x.r, 'r2', { arev: 4, mlines: [row('0', 't8')] }))
    await p2
    assert.equal(spy.n('tableCarried'), 1, 'SD-ENTRY-LINK-TABLE-CARRIED — 같은 서버 다음 방의 입장 응답도 ENTRY.tableCarried 하나')
    assert.equal(x.link.table.arev, 6, 'SD-ENTRY-LINK-TABLE-CARRIED — 응답이 실어 온 낡은 표는 진다')
    const p3 = x.r.c.join('r3'); await tick()
    x.r.ws.answer(joinFrame(x.r.ws, 'r3'), joinBody(x.r, 'r3', { arev: 9, mlines: [row('0', 't2')] }))
    await p3
    assert.equal(x.link.table.arev, 9, 'SD-ENTRY-LINK-TABLE-CARRIED — 응답이 실어 온 새 표가 이긴다')
    assert.deepEqual(x.link.table.mlines.map((m) => m.track_id), ['t2'])
    await x.r.c.close()
  } finally { spy.restore() }
})

// ══ 효과 표 ═════════════════════════════════════════════════════════════

test('SD-EFFECT-LINK-APP-LINK-OK — 위 효과 app.link_ok 는 link{state:up} · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LB.effect('app.link_ok'), { event: 'link' }, 'SD-EFFECT-LINK-APP-LINK-OK — 효과 표: app.link_ok → link')
    const x = await upLink()
    x.pc.ice('disconnected'); await tick()
    spy.reset()
    x.pc.ice('connected'); await tick()
    assert.deepEqual(spy.steps['iceBack']![0]!.fx, ['app.link_ok'])
    assert.deepEqual(planOf(spy, 'iceBack').events, ['link'], 'SD-EFFECT-LINK-APP-LINK-OK — plan() 이 link 를 낸다')
    assert.equal(lastLink(x).state, 'up', 'SD-EFFECT-LINK-APP-LINK-OK — link{state:up}')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-EFFECT-LINK-APP-LINK-SHAKY — 위 효과 app.link_shaky 는 link{state:wobbly} · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LB.effect('app.link_shaky'), { event: 'link' })
    const x = await upLink()
    spy.reset()
    const n = x.links.length
    x.pc.ice('disconnected'); await tick()
    assert.deepEqual(spy.steps['iceDisc']![0]!.fx, ['app.link_shaky'])
    assert.deepEqual(planOf(spy, 'iceDisc').events, ['link'], 'SD-EFFECT-LINK-APP-LINK-SHAKY — plan() 이 link 를 낸다')
    assert.deepEqual(x.links.slice(n).map((i) => i.state), ['wobbly'], 'SD-EFFECT-LINK-APP-LINK-SHAKY — link{state:wobbly} 하나')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-EFFECT-LINK-APP-LINK-REVIVING — 위 효과 app.link_reviving 은 link{state:restarting} · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LB.effect('app.link_reviving'), { event: 'link' })
    const x = await upLink()
    spy.reset()
    x.pc.ice('failed'); await tick()
    await until(() => spy.n('hbRes') === 1)
    assert.deepEqual(spy.steps['hbRes']![0]!.fx, ['app.link_reviving'])
    assert.deepEqual(planOf(spy, 'hbRes').events, ['link'], 'SD-EFFECT-LINK-APP-LINK-REVIVING — plan() 이 link 를 낸다')
    assert.equal(lastLink(x).state, 'restarting', 'SD-EFFECT-LINK-APP-LINK-REVIVING — link{state:restarting}')
    assert.equal(x.r.c.health, 'degraded')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-EFFECT-LINK-APP-LINK-REBUILDING — 위 효과 app.link_rebuilding 은 link{state:rebuilding} · 그 서버 방 rebuilding · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LB.effect('app.link_rebuilding'), { event: 'link' })
    const x = await upLink()
    spy.reset()
    x.pc.sctp!.set('closed'); await tick()
    assert.ok(spy.steps['assocLost']![0]!.fx.includes('app.link_rebuilding'))
    assert.deepEqual(planOf(spy, 'assocLost').events, ['link'], 'SD-EFFECT-LINK-APP-LINK-REBUILDING — plan() 이 link 를 낸다')
    assert.equal(lastLink(x).state, 'rebuilding', 'SD-EFFECT-LINK-APP-LINK-REBUILDING — link{state:rebuilding}')
    assert.equal(lastLink(x).cause, 'assoc')
    assert.deepEqual([x.room.link, x.room.rebuilding], ['rebuilding', true], 'SD-EFFECT-LINK-APP-LINK-REBUILDING — 그 서버 방 rebuilding')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-EFFECT-LINK-APP-LINK-BLOCKED — 위 효과 app.link_blocked 는 unreachableAfter 회째에 link{cause:path_unreachable} · health offline · 포기 0 · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LB.effect('app.link_blocked'), { event: 'link' })
    const x = await upLink({ standUp: false })
    FakeWS.auto.set(Op.ICE_RESTART, NEW_CREDS)
    assert.equal(x.link.state, 'connecting', '첫 수립 — 한 번도 up 에 닿지 않았다')
    spy.reset()
    x.pc.ice('failed'); await tick()
    await until(() => spy.n('applyTimeout') === 1)
    assert.deepEqual(spy.steps['applyTimeout']![0]!.fx, ['app.link_blocked'])
    assert.deepEqual(planOf(spy, 'applyTimeout', 0).events, ['link'], 'SD-EFFECT-LINK-APP-LINK-BLOCKED — plan() 이 link 를 낸다')
    assert.equal(x.link.info().cause, null, `SD-EFFECT-LINK-APP-LINK-BLOCKED — ${OPTS.unreachableAfter} 회째 전에는 표시만 미룬다`)
    assert.notEqual(x.r.c.health, 'offline')
    await until(() => spy.n('applyTimeout') === 2, 3000)
    assert.equal(lastLink(x).cause, 'path_unreachable', `SD-EFFECT-LINK-APP-LINK-BLOCKED — ${OPTS.unreachableAfter} 회째에 link{cause:path_unreachable}`)
    assert.equal(x.r.c.health, 'offline', 'SD-EFFECT-LINK-APP-LINK-BLOCKED — health offline')
    const r0 = restarts(x)
    await until(() => restarts(x) > r0, 3000)
    assert.equal(x.link.state, 'restarting', 'SD-EFFECT-LINK-APP-LINK-BLOCKED — 포기 0(되살리기를 이어 간다)')
    FakeWS.auto.delete(Op.ICE_RESTART)
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-EFFECT-LINK-CONN-CLOSE — 위 효과 conn.close 는 peer.close — 그 서버 PeerLink 를 닫는다 · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LB.effect('conn.close'), { action: 'peer.close' }, 'SD-EFFECT-LINK-CONN-CLOSE — 효과 표: conn.close → peer.close')
    const x = await upLink()
    spy.reset()
    x.pc.sctp!.dtls('failed'); await tick()
    assert.ok(planOf(spy, 'assocLost').actions.includes('peer.close'), 'SD-EFFECT-LINK-CONN-CLOSE — plan() 이 peer.close 를 낸다')
    assert.equal(x.pc.closed, true, 'SD-EFFECT-LINK-CONN-CLOSE — 그 서버 PC 가 닫혔다')
    assert.equal(x.link.peer, null, 'SD-EFFECT-LINK-CONN-CLOSE — PeerLink 를 놓았다')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-EFFECT-LINK-DC-REOPEN — 위 효과 dc.reopen 은 같은 PC 위 DC 를 새로 연다 · 시도 k 는 닫힌 뒤 k × dcReopen.intervalMs · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LB.effect('dc.reopen'), { action: 'dc.reopen' })
    const x = await upLink()
    spy.reset()
    const pcs = FakePC.made.length
    const t0 = performance.now()
    x.pc.dcs[0]!.drop(); await tick()
    assert.deepEqual(planOf(spy, 'dcClosed').actions, ['dc.reopen'], 'SD-EFFECT-LINK-DC-REOPEN — plan() 이 dc.reopen 을 낸다')
    await tick(OPTS.dcReopen.intervalMs / 2)
    assert.equal(x.pc.dcs.length, 1, 'SD-EFFECT-LINK-DC-REOPEN — 시도 1 은 intervalMs 전에 열지 않는다')
    await until(() => x.pc.dcs.length === 2)
    const dc = x.pc.dcs[1]!
    assert.deepEqual([dc.label, dc.init.ordered, dc.init.maxRetransmits], ['unreliable', false, 0], 'SD-EFFECT-LINK-DC-REOPEN — 같은 PC 위 같은 꼴의 DC')
    assert.equal(FakePC.made.length, pcs, 'SD-EFFECT-LINK-DC-REOPEN — 새 PC 0(재협상 0)')
    await tick(OPTS.dcReopen.intervalMs / 2)
    assert.equal(x.pc.dcs.length, 2, 'SD-EFFECT-LINK-DC-REOPEN — 시도 2 는 2 × intervalMs 전에 열지 않는다')
    await until(() => x.pc.dcs.length === 3)
    const I = OPTS.dcReopen.intervalMs
    const at = x.pc.dcs.slice(1).map((d) => d.at - t0)
    assert.ok(at[0]! >= I - 2 && at[0]! < 2 * I, `SD-EFFECT-LINK-DC-REOPEN — 시도 1 은 닫힌 뒤 1 × intervalMs(${at[0]!.toFixed(0)}ms)`)
    assert.ok(at[1]! >= 2 * I - 2 && at[1]! < 3 * I, `SD-EFFECT-LINK-DC-REOPEN — 시도 2 는 닫힌 뒤 2 × intervalMs(${at[1]!.toFixed(0)}ms)`)
    assert.deepEqual(spy.calls['reopened'], [['fail']], '시도 1 의 판정 시한 = 시도 2 시각')
    await x.r.c.close()
  } finally { spy.restore() }
})

test('SD-EFFECT-LINK-SDP-RESTART — 위 효과 sdp.restart 는 새 ICE 자격으로 재협상한다(협상 큐) · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(LB.effect('sdp.restart'), { action: 'sdp.restart' })
    const x = await upLink()
    await toRestart(x)
    spy.reset()
    const offers = x.pc.offers.length
    await answerRestart(x)
    assert.deepEqual(planOf(spy, 'restartRes').actions, ['sdp.restart'], 'SD-EFFECT-LINK-SDP-RESTART — plan() 이 sdp.restart 를 낸다')
    assert.equal(spy.n('negoRes'), 1, 'SD-EFFECT-LINK-SDP-RESTART — 협상 큐를 탄다(결과 negoRes)')
    assert.deepEqual(x.pc.offers.slice(offers), [{ iceRestart: true }], 'SD-EFFECT-LINK-SDP-RESTART — ICE 재시작 offer')
    assert.match(x.pc.remoteDescription!.sdp!, /a=ice-ufrag:pubUf2/, 'SD-EFFECT-LINK-SDP-RESTART — 새 자격으로 조립')
    assert.match(x.pc.remoteDescription!.sdp!, /a=setup:passive/, '지문 · setup 은 그대로')
    await x.r.c.close()
  } finally { spy.restore() }
})

// ══ 증상 ═══════════════════════════════════════════════════════════════

test('K-sym-IMPL-LINK-PROJECTION-1 — 위 상태기가 받지 않는 칸(OK 에 iceBack)을 넣으면 전이 기록 cause impossible 하나 · diagnostics 경고 하나 · 조용한 무시 0', async () => {
  const x = await upLink()
  const trace: { cause: string; layer: string; label: string }[] = []
  const warns: unknown[] = []
  x.r.c.diagnostics.on('transition', (t) => { if (t.layer === 'LINK') trace.push(t) })
  x.r.c.diagnostics.on('log', (e) => { if (e.level === 'warn' && e.ns === 'link') warns.push(e) })
  const took = x.link.enter('iceBack', 'inject', [])
  assert.equal(took, false, '위가 받지 않았다(null)')
  assert.deepEqual(trace.map((t) => [t.cause, t.label]), [['impossible', 'iceBack']], 'K-sym-IMPL-LINK-PROJECTION-1 — 전이 기록 cause:impossible 하나')
  assert.equal(warns.length, 1, 'K-sym-IMPL-LINK-PROJECTION-1 — diagnostics 경고 하나(조용한 무시 0)')
  assert.equal(x.link.state, 'up', '상태는 그대로')
  await x.r.c.close()
})

test('K-sym-IMPL-LINK-PROJECTION-2 — wobbly(DC 다시 열기) 중 ICE failed 면 다시 열기를 멈추고 restarting 하나 · 재구축 0(연:LINK.C.REOPEN.wait_over)', async () => {
  const x = await upLink()
  x.pc.dcs[0]!.drop(); await tick()
  await until(() => x.pc.dcs.length === 2)
  assert.equal(x.link.state, 'wobbly')
  const n = x.links.length
  x.pc.ice('failed'); await tick()
  const dcs = x.pc.dcs.length
  // 다시 열기가 남았다면 소진(→ 재구축)까지 갔을 시간 — 간격 × (시도 + 1) × 2
  const { tries, intervalMs } = x.r.core.cfg.dcReopen
  await tick(intervalMs * (tries + 1) * 2)
  assert.deepEqual(x.links.slice(n).map((i) => i.state), ['restarting'], 'K-sym-IMPL-LINK-PROJECTION-2 — restarting 하나(다시 열기 소진 → 재구축으로 가지 않는다)')
  assert.deepEqual([x.pc.dcs.length, x.link.st.ls === 'REBUILD'], [dcs, false], 'K-sym-IMPL-LINK-PROJECTION-2 — 다시 열기 중단(새 DC 0) · 재구축 0')
  await x.r.c.close()
})
