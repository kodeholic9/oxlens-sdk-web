// author: kodeholic (powered by Claude)
// SDK:IMPL-FLR-BUTTON · SDK:IMPL-FLR-EXPOSE · SDK:IMPL-FLR-TRUST · SDK:RULE-FLR-ROOM-SWITCH · SDK:RULE-FLR-RECOVERY — 발언권(FLR) 영역 1층. 위가 지은 발언권 클라 상태기 둘레의 손 결합(입구 표 · 효과 표 · 이음매 · 버튼 계약)을 잰다.
// ★입구는 위 결합(ptt_binding)의 ENTRY 를 지나는지 · 효과는 결합 plan() 이 낸 대로 SDK 가 하는지를 FLR 단위(SD-ENTRY-FLR-* · SD-EFFECT-FLR-* · SD-API-PTT-* · SD-EVENT-* · SD-SIGNAL-* · K-sym-*)마다 잰다.
// 받침 둘 — ①발언권 하나(가짜 방 · 발행 · 소속 — 방이 내주는 것만) ②진짜 클라이언트(가짜 WebSocket · 진짜 연결 상태기 · 가짜 PeerLink · 가짜 navigator) — 다른 영역의 사건이 발언권 입구에 닿는가.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWS, tick, type Frame } from './_ws.js'
import { SA, SB, up, enter, drain, linkOf, note, vers, joinBody, joinFrame, leaveFrame, fakeTrack, BIND_OK, type Rig, type FakeTrack } from './_rig.js'
import * as FLR from '../src/domain/gen/floor_client.js'
import * as PB from '../src/domain/gen/ptt_binding.js'
import * as C from '../src/internal/wire/floor_codec.js'
import * as Mbcp from '../src/internal/flr/mbcp.js'
import { Timers } from '../src/internal/wire/floor_consts.js'
import { Op, type TrackEntry, type MlineEntry, type ServerConfig } from '../src/internal/wire/ws.js'
import { FloorCore, type PttState, type ArmingStage, type Extra } from '../src/domain/flr/core.js'
import { Ptt, type PttState as ApiPttState, type Room } from '../src/index.js'
import { Fault } from '../src/platform/fault.js'
import type { Logger } from '../src/platform/log.js'
import type { LinkCore } from '../src/domain/link/core.js'

// ══ 위 결합 ENTRY 를 지나는가 — 입구마다 부른 인자 · 걸음 ═══════════════════════════════════════

interface Spy { calls: Record<string, unknown[][]>; steps: Record<string, (FLR.Step | null)[]>; n(k: string): number; plan(k: string, i?: number): PB.Plan; restore(): void }
function spyOn(): Spy {
  const E = PB.ENTRY as unknown as Record<string, (...a: unknown[]) => FLR.Step | null>
  const saved = { ...E }
  const calls: Record<string, unknown[][]> = {}
  const steps: Record<string, (FLR.Step | null)[]> = {}
  for (const k of Object.keys(saved)) {
    calls[k] = []
    steps[k] = []
    E[k] = (...a: unknown[]) => { calls[k]!.push(a.slice(1)); const s = saved[k]!(...a); steps[k]!.push(s); return s }
  }
  return {
    calls, steps, n: (k) => calls[k]?.length ?? 0,
    plan: (k, i = -1) => PB.plan(steps[k]!.at(i)!),
    restore: () => { Object.assign(E, saved) },
  }
}

/** 시험 하나 동안만 결합 ENTRY 를 엿본다 */
async function spying<T>(f: (spy: Spy) => Promise<T> | T): Promise<T> {
  const spy = spyOn()
  try { return await f(spy) } finally { spy.restore() }
}

const msgs = (sent: C.Message[]): number[] => sent.map((m) => m.type)

// ══ 받침 ① — 발언권 하나(방 · 발행 · 소속은 방이 내주는 것만 가짜) ══════════════════════════════

const LOG = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger

interface U {
  f: FloorCore
  room: { id: string; sfuId: string; st: { rs: string }; permission: { floorRequest: boolean }; rebuilding: boolean; closed: boolean; sessionClosed: boolean; path: 'open' | 'transport' | 'recovering'; slots: string[]; rendered: number }
  media: { half: boolean; cold: boolean; opened: number; closed: number; ensured: number; fail: Fault | null; hold: Promise<void> | null }
  aff: { speakingRoom: string | null; selects: string[] }
  sent: C.Message[]
  labels: string[]
  impossible: string[]
  states: PttState[]
  ev: Record<Extra | 'speaker', unknown[]>
  rx(m: C.Message): void
}

function unit(o: { half?: boolean } = {}): U {
  const sent: C.Message[] = []
  const labels: string[] = []
  const impossible: string[] = []
  const room = {
    id: 'ch-3', sfuId: 'sfu-a', st: { rs: 'JOINED' }, permission: { floorRequest: true }, rebuilding: false, closed: false, sessionClosed: false,
    path: 'open' as 'open' | 'transport' | 'recovering', slots: [] as string[], rendered: 0,
    floorPath() { return room.path },
    sendFloor(b: Uint8Array) { sent.push(C.decode(Mbcp.unwrap(b)!)!); return true },
    slotTrackIds() { return [...room.slots] },
    renderVoice() { room.rendered++ },
    record(_l: string, _k: string, _f: string, _t: string, label: string) { labels.push(label) },
    impossible(_l: string, _k: string, _f: string, entry: string) { impossible.push(entry) },
  }
  const media = {
    half: o.half ?? true, cold: false, opened: 0, closed: 0, ensured: 0, fail: null as Fault | null, hold: null as Promise<void> | null,
    hasHalfMic: () => media.half,
    halfMicCold: () => media.cold,
    ensureHalfMic: async () => { media.ensured++; if (media.hold) await media.hold; if (media.fail) throw media.fail; media.half = true },
    warmHalf: async () => undefined,
    floorOpen: () => { media.opened++ },
    floorClose: () => { media.closed++ },
  }
  const aff = {
    speakingRoom: 'ch-3' as string | null, selects: [] as string[],
    setSpeakingRoom: async (id: string) => { aff.selects.push(id); aff.speakingRoom = id },
  }
  const f = new FloorCore(room as never, media as never, aff as never, { wakeDetectMs: 1000 }, LOG)
  const states: PttState[] = []
  const ev: Record<Extra | 'speaker', unknown[]> = { granted: [], denied: [], revoked: [], queued: [], released: [], speaker: [] }
  f.events.on('state', (s) => states.push(s))
  for (const k of Object.keys(ev) as (Extra | 'speaker')[]) f.events.on(k, (x: unknown) => ev[k].push(x))
  return {
    f, room, media, aff, sent, labels, impossible, states, ev,
    rx: (m) => { const got = Mbcp.parse(Mbcp.wrap(C.encode(m)))!; f.receive(got.rx) },
  }
}

const R = 'ch-3'
const granted = (priority = 0, duration = 30, room = R): C.Message => C.buildGranted({ priority, duration, room })
const taken = (speaker: string, seq = 1, room = R): C.Message => C.buildTaken({ speaker, seq, room })
const idle = (seq = 2, room = R): C.Message => C.buildIdle({ seq, room })
const deny = (cause: number, reason?: string): C.Message => C.buildDeny(reason === undefined ? { cause, room: R } : { cause, room: R, reason })
const revoke = (cause: number, reason?: string): C.Message => C.buildRevoke(reason === undefined ? { cause, room: R } : { cause, room: R, reason })
const qinfo = (position: number): C.Message => C.buildQueueInfo({ info: { position, priority: 0 }, room: R })
const set = (u: U, s: Partial<FLR.Cl>): void => { u.f.st = { ...u.f.st, ...s } }
const prioOf = (m: C.Message): number | undefined => C.readRequest(m).value.priority

/** press() 의 arming 이 입구에 닿을 때까지 */
async function pressed(u: U, o?: { source?: 'user' | 'accessory' | 'app' }): Promise<void> {
  await u.f.press(o)
  for (let i = 0; i < 20 && u.f.snapshot().arming; i++) await tick()
}

// ══ 입구 표 — 버튼(SDK 사건 → 위 입구) ═══════════════════════════════════════════════════

test('SD-ENTRY-FLR-PRESS — arming 이 끝난 press() 하나에 ENTRY.press 하나 · 우선순위 = ptt.priority · no_permission 밖 누름은 위가 버린다', () => spying(async (spy) => {
  const u = unit()
  u.f.priority = 7
  await pressed(u)
  assert.equal(spy.n('press'), 1, 'SD-ENTRY-FLR-PRESS — arming 끝 press() 하나에 입구 press 하나')
  assert.deepEqual(spy.calls['press']![0], [7], 'SD-ENTRY-FLR-PRESS — 우선순위 = ptt.priority')
  assert.equal(spy.plan('press').label, 'FLR.C.NOPERM.press', 'SD-ENTRY-FLR-PRESS — 결합 코드 ENTRY 를 지난다')
  assert.deepEqual([msgs(u.sent), prioOf(u.sent[0]!)], [[C.Type.REQUEST], 7])
  const before = u.f.st
  await u.f.press()
  assert.equal(spy.plan('press').label, 'FLR.C.any.press_drop', 'SD-ENTRY-FLR-PRESS — pending_request 의 누름은 위가 버린다(연:DEV-FLR-PRESS-DROP)')
  assert.deepEqual([u.f.st, msgs(u.sent)], [before, [C.Type.REQUEST]], 'SD-ENTRY-FLR-PRESS — no_permission 밖 누름은 입구에서 아무것도 바꾸지 않는다(상태 · 송신 0)')
  u.f.dispose()
}))

test('SD-ENTRY-FLR-RELEASE — ptt.release() 하나에 ENTRY.release 하나(결합 코드를 지난다)', () => spying(async (spy) => {
  const u = unit()
  set(u, { cs: 'PREQ', want: true, c101: 1 })
  await u.f.release()
  assert.equal(spy.n('release'), 1, 'SD-ENTRY-FLR-RELEASE — release() 하나에 입구 release 하나')
  assert.equal(spy.plan('release').label, 'FLR.C.PREQ.release', 'SD-ENTRY-FLR-RELEASE — 결합 코드 ENTRY 를 지난다')
  assert.deepEqual(msgs(u.sent), [C.Type.RELEASE])
  u.f.dispose()
}))

test('SD-ENTRY-FLR-INTENT — 승계 허가 때 hold 가 눌려 있으면 · toggle 이면 acceptPending 중 press() 가 ENTRY.intent 하나', () => spying(async (spy) => {
  const h = unit()
  set(h, { cs: 'QUEUED', sub: 'WAIT', want: true })
  await h.f.press()
  assert.equal(spy.n('intent'), 0)
  h.rx(granted())
  assert.equal(spy.n('intent'), 1, 'SD-ENTRY-FLR-INTENT — hold: 승계 허가가 온 순간 눌려 있으면 입구 intent 하나')
  assert.equal(spy.plan('intent').label, 'FLR.C.QUEUED.intent', 'SD-ENTRY-FLR-INTENT — 결합 코드 ENTRY 를 지난다')
  assert.equal(h.f.st.cs, 'PERM')
  h.f.dispose()
  const t = unit()
  t.f.input = 'toggle'
  set(t, { cs: 'QUEUED', sub: 'WAIT', want: true })
  t.rx(granted())
  assert.equal(spy.n('intent'), 1, 'toggle: 승계 허가만으로는 입구 0')
  await t.f.press()
  assert.equal(spy.n('intent'), 2, 'SD-ENTRY-FLR-INTENT — toggle: acceptPending 중 press() 가 입구 intent 하나')
  assert.equal(t.f.st.cs, 'PERM')
  t.f.dispose()
}))

test('SD-ENTRY-FLR-EXPIRE — 위가 걸라고 한 타이머 만료마다 ENTRY.expire 하나 · 걸지 않은 타이머 0', () => spying(async (spy) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const u = unit()
    await u.f.press()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    mock.timers.tick(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    assert.equal(u.f.st.cs, 'PREQ')
    mock.timers.tick(FLR.TIMER_MS.T101)
    assert.equal(spy.n('expire'), 1, 'SD-ENTRY-FLR-EXPIRE — T101 만료 하나에 입구 expire 하나')
    assert.deepEqual(spy.calls['expire']![0], ['T101'])
    assert.equal(spy.plan('expire').label, 'FLR.C.PREQ.T101', 'SD-ENTRY-FLR-EXPIRE — 결합 코드 ENTRY 를 지난다')
    mock.timers.tick(FLR.TIMER_MS.T101 * 10)
    assert.ok(spy.calls['expire']!.every((a) => a[0] === 'T101'), 'SD-ENTRY-FLR-EXPIRE — 위가 걸지 않은 타이머(T100 · T104 · T132) 만료 0')
    assert.ok(spy.steps['expire']!.every((s) => s !== null), 'SD-ENTRY-FLR-EXPIRE — 돌지 않는 타이머로 입구에 닿지 않는다(받지 않는 사건 0)')
    assert.deepEqual(u.impossible, [])
    u.f.dispose()
  } finally { mock.timers.reset() }
}))

// ══ 효과 표 — 위 효과 → SDK 표면(결합 plan() 이 낸 그대로) ═══════════════════════════════════

/** 받은 사건 한 걸음의 plan — receive 입구가 돌려준 걸음 */
const lastPlan = (spy: Spy, k = 'receive'): PB.Plan => spy.plan(k)

test('SD-EFFECT-FLR-APP-GRANTED — 위 효과 app.granted 에 granted 하나 · remainingSec · priority', () => spying(async (spy) => {
  const u = unit()
  u.f.priority = 9
  await pressed(u)
  u.rx(granted(9, 25))
  assert.ok(lastPlan(spy).events.includes('granted') && spy.steps['receive']!.at(-1)!.fx.includes('app.granted'), 'SD-EFFECT-FLR-APP-GRANTED — 결합 코드 plan() 이 낸다')
  assert.equal(u.ev.granted.length, 1, 'SD-EFFECT-FLR-APP-GRANTED — granted 하나')
  const s = u.ev.granted[0] as PttState
  assert.deepEqual([s.remainingSec, s.priority, s.phase], [25, 9, 'has_permission'], 'SD-EFFECT-FLR-APP-GRANTED — remainingSec · priority')
  u.f.dispose()
}))

test('SD-EFFECT-FLR-APP-GRANTED-QUEUED — 위 효과 app.granted_queued 에 granted 하나 · acceptPending 참', () => spying(async (spy) => {
  const u = unit()
  u.f.input = 'toggle'
  set(u, { cs: 'QUEUED', sub: 'WAIT', want: true })
  u.rx(granted(0, 20))
  assert.ok(lastPlan(spy).events.includes('granted') && spy.steps['receive']!.at(-1)!.fx.includes('app.granted_queued'), 'SD-EFFECT-FLR-APP-GRANTED-QUEUED — 결합 코드 plan() 이 낸다')
  assert.equal(u.ev.granted.length, 1, 'SD-EFFECT-FLR-APP-GRANTED-QUEUED — granted 하나')
  const s = u.ev.granted[0] as PttState
  assert.deepEqual([s.acceptPending, s.phase, s.remainingSec], [true, 'queued', 20], 'SD-EFFECT-FLR-APP-GRANTED-QUEUED — acceptPending 참(승계 시한이 도는 창)')
  u.f.dispose()
}))

test('SD-EFFECT-FLR-APP-DENIED — 위 효과 app.denied 에 denied 하나 · lastDeny{cause · text}', () => spying(async (spy) => {
  const u = unit()
  await pressed(u)
  u.rx(deny(102, 'no floor bit'))
  assert.ok(lastPlan(spy).events.includes('denied'), 'SD-EFFECT-FLR-APP-DENIED — 결합 코드 plan() 이 낸다')
  assert.equal(u.ev.denied.length, 1, 'SD-EFFECT-FLR-APP-DENIED — denied 하나')
  const s = u.ev.denied[0] as PttState
  assert.deepEqual([s.lastDeny, s.lastEnd, s.phase], [{ cause: 102, text: 'no floor bit' }, 'denied', 'no_permission'], 'SD-EFFECT-FLR-APP-DENIED — lastDeny')
  u.f.dispose()
}))

test('SD-EFFECT-FLR-APP-QUEUED — 위 효과 app.queued 에 queued 하나 · queue{position}', () => spying(async (spy) => {
  const u = unit()
  await pressed(u)
  u.rx(qinfo(3))
  assert.ok(lastPlan(spy).events.includes('queued'), 'SD-EFFECT-FLR-APP-QUEUED — 결합 코드 plan() 이 낸다')
  assert.equal(u.ev.queued.length, 1, 'SD-EFFECT-FLR-APP-QUEUED — queued 하나')
  assert.deepEqual((u.ev.queued[0] as PttState).queue, { position: 3 }, 'SD-EFFECT-FLR-APP-QUEUED — queue')
  u.f.dispose()
}))

test('SD-EFFECT-FLR-APP-REVOKED — 위 효과 app.revoked 에 revoked 하나 · lastRevoke{cause · text}', () => spying(async (spy) => {
  const u = unit()
  set(u, { cs: 'PERM', want: true })
  u.rx(revoke(4, 'preempted'))
  assert.ok(lastPlan(spy).events.includes('revoked'), 'SD-EFFECT-FLR-APP-REVOKED — 결합 코드 plan() 이 낸다')
  assert.equal(u.ev.revoked.length, 1, 'SD-EFFECT-FLR-APP-REVOKED — revoked 하나')
  const s = u.ev.revoked[0] as PttState
  assert.deepEqual([s.lastRevoke, s.lastEnd], [{ cause: 4, text: 'preempted' }, 'revoked'], 'SD-EFFECT-FLR-APP-REVOKED — lastRevoke')
  u.f.dispose()
}))

test('SD-EFFECT-FLR-APP-SPEAKER · SD-EFFECT-FLR-APP-SPEAKER-NONE — 위 효과 app.speaker 에 speaker{userId} · app.speaker_none 에 speaker{userId:null}', () => spying(async (spy) => {
  const u = unit()
  u.room.slots = ['ptt-ch-3-audio']
  u.rx(taken('u2'))
  assert.ok(lastPlan(spy).events.includes('speaker') && spy.steps['receive']!.at(-1)!.fx.includes('app.speaker'), 'SD-EFFECT-FLR-APP-SPEAKER — 결합 코드 plan() 이 낸다')
  assert.deepEqual(u.ev.speaker, [{ userId: 'u2', trackIds: ['ptt-ch-3-audio'] }], 'SD-EFFECT-FLR-APP-SPEAKER — speaker{userId}')
  u.rx(idle())
  assert.ok(lastPlan(spy).events.includes('speaker') && spy.steps['receive']!.at(-1)!.fx.includes('app.speaker_none'), 'SD-EFFECT-FLR-APP-SPEAKER-NONE — 결합 코드 plan() 이 낸다')
  assert.deepEqual(u.ev.speaker.at(-1), { userId: null, trackIds: ['ptt-ch-3-audio'] }, 'SD-EFFECT-FLR-APP-SPEAKER-NONE — speaker{userId:null}')
  u.f.dispose()
}))

test("SD-EFFECT-FLR-APP-REQUEST-TIMEOUT · SD-EFFECT-FLR-APP-QUEUE-TIMEOUT · SD-EFFECT-FLR-APP-GRANT-EXPIRED — 시한 효과 셋은 state 의 lastEnd 로(no_response · no_response · t132_expired)", () => spying(async (spy) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const a = unit()
    set(a, { cs: 'PREQ', want: true, c101: FLR.COUNTS.C101 })
    a.f.enter('expire', 'timer', ['T101'])
    assert.ok(spy.steps['expire']!.at(-1)!.fx.includes('app.request_timeout') && spy.plan('expire').events.includes('state'), 'SD-EFFECT-FLR-APP-REQUEST-TIMEOUT — 결합 코드 plan() 이 낸다')
    assert.deepEqual([a.states.at(-1)!.lastEnd, a.states.at(-1)!.phase], ['no_response', 'no_permission'], "SD-EFFECT-FLR-APP-REQUEST-TIMEOUT — state{lastEnd:'no_response'}")
    a.f.dispose()

    const b = unit()
    set(b, { cs: 'QUEUED', sub: 'WAIT', want: true })
    b.f.queuePosition()
    for (let i = 0; i < FLR.COUNTS.C104; i++) mock.timers.tick(FLR.TIMER_MS.T104)
    assert.ok(spy.steps['expire']!.at(-1)!.fx.includes('app.queue_timeout') && spy.plan('expire').events.includes('state'), 'SD-EFFECT-FLR-APP-QUEUE-TIMEOUT — 결합 코드 plan() 이 낸다')
    assert.equal(b.states.at(-1)!.lastEnd, 'no_response', "SD-EFFECT-FLR-APP-QUEUE-TIMEOUT — state{lastEnd:'no_response'}")
    b.f.dispose()

    const c = unit()
    c.f.input = 'toggle'
    set(c, { cs: 'QUEUED', sub: 'WAIT', want: true })
    c.rx(granted())
    mock.timers.tick(FLR.TIMER_MS.T132)
    assert.ok(spy.steps['expire']!.at(-1)!.fx.includes('app.grant_expired') && spy.plan('expire').events.includes('state'), 'SD-EFFECT-FLR-APP-GRANT-EXPIRED — 결합 코드 plan() 이 낸다')
    assert.deepEqual([c.states.at(-1)!.lastEnd, c.states.at(-1)!.acceptPending], ['t132_expired', false], "SD-EFFECT-FLR-APP-GRANT-EXPIRED — state{lastEnd:'t132_expired'}")
    assert.equal(msgs(c.sent).at(-1), C.Type.RELEASE)
    c.f.dispose()
  } finally { mock.timers.reset() }
}))

test('SD-EFFECT-FLR-APP-FLOOR-UNRELIABLE · SD-EFFECT-FLR-APP-FLOOR-RELIABLE — DC 끊김 · 다시 열림의 위 효과가 state{trusted:false · true}', () => spying(async (spy) => {
  const u = unit()
  u.f.dcDown()
  assert.ok(spy.steps['dcDown']![0]!.fx.includes('app.floor_unreliable') && spy.plan('dcDown').events.includes('state'), 'SD-EFFECT-FLR-APP-FLOOR-UNRELIABLE — 결합 코드 plan() 이 낸다')
  assert.equal(u.states.at(-1)!.trusted, false, 'SD-EFFECT-FLR-APP-FLOOR-UNRELIABLE — state{trusted:false}')
  u.f.dcUp()
  assert.ok(spy.steps['dcUp']![0]!.fx.includes('app.floor_reliable') && spy.plan('dcUp').events.includes('state'), 'SD-EFFECT-FLR-APP-FLOOR-RELIABLE — 결합 코드 plan() 이 낸다')
  assert.equal(u.states.at(-1)!.trusted, true, 'SD-EFFECT-FLR-APP-FLOOR-RELIABLE — state{trusted:true}')
  u.f.dispose()
}))

// ══ 이벤트 ════════════════════════════════════════════════════════════════════════════════

test('SD-EVENT-STATE — 바뀔 때마다 state 하나 · 안 바뀌면 0', async () => {
  const u = unit()
  set(u, { cs: 'PREQ', want: true })
  u.f.surface()
  u.states.length = 0
  u.rx(granted())
  assert.equal(u.states.length, 1, 'SD-EVENT-STATE — 바뀜 하나에 state 하나')
  u.f.rtpTx()
  u.rx(taken('u9'))
  u.f.surface()
  assert.equal(u.states.length, 1, 'SD-EVENT-STATE — 표면이 그대로인 걸음(rtp_tx · 발언 중 TAKEN)은 0')
  await u.f.release()
  assert.deepEqual(u.states.map((s) => s.phase), ['has_permission', 'pending_release'], 'SD-EVENT-STATE — 다음 바뀜에 하나')
  u.f.dispose()
})

test("SD-EVENT-GRANTED — 사건별 편의 이벤트는 state 와 같은 순간 · released 는 lastEnd:'released' 일 때만", async () => {
  const u = unit()
  const order: string[] = []
  u.f.events.on('state', () => order.push('state'))
  u.f.events.on('granted', () => order.push('granted'))
  set(u, { cs: 'PREQ', want: true })
  u.rx(granted())
  assert.deepEqual(order, ['state', 'granted'], 'SD-EVENT-GRANTED — 같은 걸음에 state 다음 granted')
  await u.f.release()
  u.rx(idle())
  assert.equal(u.ev.released.length, 1, "SD-EVENT-GRANTED — 놓아서 끝나면(lastEnd:'released') released 하나")
  assert.equal((u.ev.released[0] as PttState).lastEnd, 'released')
  set(u, { cs: 'PERM', want: true })
  u.rx(revoke(4))
  u.rx(idle(9))
  assert.equal(u.states.at(-1)!.lastEnd, 'revoked')
  assert.equal(u.ev.released.length, 1, 'SD-EVENT-GRANTED — 회수로 끝나면 released 0')
  set(u, { cs: 'PREQ', want: true })
  u.rx(deny(3))
  assert.equal(u.ev.released.length, 1, 'SD-EVENT-GRANTED — 거절로 끝나면 released 0')
  u.f.dispose()
})

// ══ 버튼 계약 · 상태 노출 ══════════════════════════════════════════════════════════════════

test('SD-API-PTT-STATE — PttState 필드 전량(arming · armingStage 넷 · lastError 포함 · draining 부재)', () => {
  const fields: Record<keyof PttState, true> = { phase: true, remainingSec: true, priority: true, queue: true, acceptPending: true, talkingSince: true, lastDeny: true, lastRevoke: true, canRequest: true, source: true, lastEnd: true, trusted: true, arming: true, armingStage: true, lastError: true, mic: true }
  const api: Record<keyof ApiPttState, true> = fields
  const stages: Record<ArmingStage, true> = { register: true, select: true, transport: true, recovering: true }
  assert.equal(Object.keys(fields).length, 16, 'SD-API-PTT-STATE — 필드 열여섯(§7-1-1)')
  assert.deepEqual(Object.keys(stages), ['register', 'select', 'transport', 'recovering'], "SD-API-PTT-STATE — armingStage 넷('recovering' 포함 · release_other 0)")
  assert.ok(!('draining' in api), 'SD-API-PTT-STATE — draining 부재')
  const u = unit()
  const s = u.f.snapshot()
  for (const k of ['phase', 'acceptPending', 'canRequest', 'trusted', 'arming', 'mic'] as const) assert.ok(k in s, `SD-API-PTT-STATE — 늘 있는 칸 ${k}`)
  assert.ok(!('draining' in s), 'SD-API-PTT-STATE — draining 부재(값)')
  u.f.dispose()
})

test('SD-API-PTT-PRIORITY①②③ — REQUEST 의 우선순위 TLV = 설정값 · 허가 뒤 state.priority 가 같은 값(깎임 0) · 기본은 0(같은 0 끼리 선점 0 — 서버 FIFO 는 2층)', async () => {
  const d0 = unit()
  await pressed(d0)
  assert.deepEqual([d0.f.priority, prioOf(d0.sent[0]!) ?? 0], [0, 0], 'SD-API-PTT-PRIORITY③ — 기본 우선순위 0 으로 낸다(올려 선점하지 않는다 · 같은 0 끼리는 서버가 FIFO)')
  d0.f.dispose()
  const u = unit()
  const ptt = new Ptt(u.f, u.room as never)
  ptt.priority = 200
  await ptt.press()
  for (let i = 0; i < 10 && u.f.snapshot().arming; i++) await tick()
  assert.equal(prioOf(u.sent[0]!), 200, 'SD-API-PTT-PRIORITY① — REQUEST TLV 0 = 설정값')
  u.rx(granted(200))
  assert.equal(ptt.state.priority, 200, 'SD-API-PTT-PRIORITY② — state.priority = 같은 값(깎임 0)')
  u.f.dispose()
  const d = unit()
  await pressed(d)
  assert.equal(prioOf(d.sent[0]!), undefined, '기본 0 은 우선순위 칸을 싣지 않는다(연:RULE-FLR-TLV)')
  d.f.dispose()
})

test('SD-API-PTT-RELEASE — pending_request 의 뗌 · 재전송 열차 정지 · 큐 철회 즉시 표시 · arming 중 뗌은 단계 완료 후 REQUEST 0', () => spying(async (spy) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const a = unit()
    set(a, { cs: 'PREQ', want: true, c101: 1 })
    a.f.enter('expire', 'timer', ['T101'])
    assert.deepEqual(msgs(a.sent), [C.Type.REQUEST])
    await a.f.release()
    assert.equal(a.f.st.cs, 'PREL', 'SD-API-PTT-RELEASE — pending_request 갈래(FLR.C.PREQ.release)')
    mock.timers.tick(FLR.TIMER_MS.T101 * 10)
    assert.ok(!msgs(a.sent).slice(1).includes(C.Type.REQUEST), 'SD-API-PTT-RELEASE — REQUEST 재전송 열차가 선다(T101 0)')
    a.f.dispose()

    const b = unit()
    set(b, { cs: 'QUEUED', sub: 'WAIT', want: true })
    b.f.surface()
    const n = b.states.length
    await b.f.release()
    assert.equal(b.states.length, n + 1, 'SD-API-PTT-RELEASE — 큐 철회는 그 자리에서 state 하나')
    assert.equal(b.states.at(-1)!.phase, 'pending_release', 'SD-API-PTT-RELEASE — 큐 철회 즉시 표시(서버 답을 기다리지 않는다)')
    b.f.dispose()
  } finally { mock.timers.reset() }

  const c = unit()
  let go!: () => void
  c.media.half = false
  c.media.hold = new Promise<void>((r) => { go = r })
  await c.f.press()
  assert.deepEqual([c.f.snapshot().arming, c.f.snapshot().armingStage], [true, 'register'])
  await c.f.release()
  assert.equal(c.f.snapshot().arming, true, '진행 중 단계는 끊지 않는다(절반 상태 금지)')
  go()
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(c.media.ensured, 1, '단계는 끝까지 밟는다')
  assert.deepEqual([msgs(c.sent), spy.n('press')], [[], 0], 'SD-API-PTT-RELEASE — arming 중 release = 단계 완료 후 REQUEST 0')
  assert.deepEqual([c.f.snapshot().phase, c.f.snapshot().lastEnd, c.ev.released.length], ['no_permission', 'released', 1])
  c.f.dispose()
}))

test('SD-API-PTT-INPUT — 승계 시한 중 press 해석(hold · toggle) · queued 중 클릭 = 철회 · 선점자는 큐 승계가 아니다(T132 0 · toggle 이어도 즉시 발화)', () => spying(async (spy) => {
  const t = unit()
  t.f.input = 'toggle'
  set(t, { cs: 'QUEUED', sub: 'WAIT', want: true })
  t.rx(granted())
  assert.deepEqual([t.f.acceptPending, FLR.armed(t.f.st)], [true, ['T132']])
  await t.f.press()
  assert.deepEqual([t.f.st.cs, t.media.opened, spy.n('press')], ['PERM', 1, 0], 'SD-API-PTT-INPUT — toggle: 승계 시한 중 press = 수락(입구 intent · 새 요청 0)')
  t.f.dispose()

  const h = unit()
  set(h, { cs: 'QUEUED', sub: 'WAIT', want: true })
  h.rx(granted())
  assert.equal(h.f.acceptPending, true, 'hold: 버튼이 떼어진 채 승계 허가 — 의지 표시 없음')
  await h.f.press()
  assert.deepEqual([h.f.st.cs, spy.plan('press').label], ['QUEUED', 'FLR.C.any.press_drop'], 'SD-API-PTT-INPUT — hold: 승계 시한 중 press 는 수락이 아니다(위가 버린다 · 시한 만료가 처리)')
  h.f.dispose()

  const q = unit()
  set(q, { cs: 'QUEUED', sub: 'WAIT', want: true })
  await q.f.release()
  assert.deepEqual([q.f.st.cs, msgs(q.sent)], ['PREL', [C.Type.RELEASE]], 'SD-API-PTT-INPUT — queued(acceptPending 아님) 중 클릭(release) = 철회')
  q.f.dispose()

  const p = unit()
  p.f.input = 'toggle'
  p.f.priority = 200
  await pressed(p)
  p.rx(granted(200))
  assert.deepEqual([p.f.st.cs, p.f.acceptPending, FLR.armed(p.f.st), p.media.opened], ['PERM', false, [], 1], 'SD-API-PTT-INPUT — 선점자는 PREQ 에서 바로 허가 — T132 0 · toggle 이어도 즉시 mic.open')
  p.f.dispose()
}))

test('SD-API-PTT-PRESS①③④⑤ — 상태표 6 갈래 · arming 중 release 는 REQUEST 0 · 단계 실패는 lastEnd arm_failed + lastError(reject 0) · armingStage 넷', () => spying(async (spy) => {
  const phases: [string, Partial<FLR.Cl>, boolean][] = [
    ['off', {}, false], ['no_permission', {}, true], ['pending_request', { cs: 'PREQ' }, true],
    ['has_permission', { cs: 'PERM' }, true], ['pending_release', { cs: 'PREL' }, true], ['queued', { cs: 'QUEUED', sub: 'WAIT' }, true],
  ]
  for (const [phase, st, half] of phases) {
    const u = unit({ half })
    set(u, st)
    assert.equal(u.f.phase, phase)
    const before = spy.n('press')
    await pressed(u)
    const nopr = phase === 'off' || phase === 'no_permission'
    if (nopr) assert.deepEqual([u.f.st.cs, msgs(u.sent), spy.plan('press').label], ['PREQ', [C.Type.REQUEST], 'FLR.C.NOPERM.press'], `SD-API-PTT-PRESS① — ${phase}: arming 뒤 REQUEST`)
    else assert.deepEqual([u.f.st.cs, msgs(u.sent), spy.n('press') - before, spy.plan('press').label], [st.cs, [], 1, 'FLR.C.any.press_drop'], `SD-API-PTT-PRESS① — ${phase}: 위가 버린다(상태 · 송신 0)`)
    u.f.dispose()
  }

  const c = unit({ half: false })
  let go!: () => void
  c.media.hold = new Promise<void>((r) => { go = r })
  await c.f.press()
  await c.f.release()
  go()
  for (let i = 0; i < 10; i++) await tick()
  assert.deepEqual(msgs(c.sent), [], 'SD-API-PTT-PRESS③ — arming 중 release() → REQUEST 0')
  c.f.dispose()

  const f = unit({ half: false })
  f.media.fail = new Fault({ code: 0, name: 'DEVICE_NOT_FOUND', category: 'device' })
  const settled = await f.f.press().then(() => 'resolve', () => 'reject')
  for (let i = 0; i < 10; i++) await tick()
  const s = f.f.snapshot()
  assert.equal(settled, 'resolve', 'SD-API-PTT-PRESS④ — 단계 실패는 reject 0(던짐은 closed 만)')
  assert.deepEqual([s.lastEnd, s.lastError?.category, s.arming, f.states.filter((x) => x.lastEnd === 'arm_failed').length], ['arm_failed', 'device', false, 1], "SD-API-PTT-PRESS④ — lastEnd:'arm_failed' + lastError 하나")
  f.room.sessionClosed = true
  assert.equal(await f.f.press().then(() => 'resolve', (e: unknown) => (e instanceof Fault ? e.category : 'x')), 'closed', 'SD-API-PTT-PRESS④ — 던지는 것은 closed 하나')
  f.f.dispose()

  const stages: string[] = []
  const g = unit({ half: false })
  g.room.path = 'transport'
  g.aff.speakingRoom = null
  g.f.events.on('state', (x) => { if (x.armingStage && stages.at(-1) !== x.armingStage) stages.push(x.armingStage) })
  await g.f.press()
  for (let i = 0; i < 3; i++) await tick()
  g.room.path = 'recovering'
  await tick(80)
  g.room.path = 'open'
  await tick(80)
  const four: readonly ArmingStage[] = ['register', 'select', 'transport', 'recovering']
  assert.deepEqual(stages, [...four], "SD-API-PTT-PRESS⑤ — armingStage 는 넷('recovering' 포함) · 0단(release_other) 0")
  g.f.dispose()
}))

test('K-sym-RULE-FLR-ROOM-SWITCH-1 — release 를 안 부르면(주입) 상한 회수 사유 2 · T9 동안 canRequest 거짓 · 끝나면 state 로 다시 참', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const u = unit()
    set(u, { cs: 'PERM', want: true })
    u.rx(revoke(2))
    assert.deepEqual([u.f.st.cs, msgs(u.sent)], ['PREL', [C.Type.RELEASE]])
    u.rx(idle())
    const s = u.states.at(-1)!
    assert.deepEqual([s.lastRevoke?.cause, s.lastEnd, s.phase, s.canRequest], [2, 'revoked', 'no_permission', false], 'K-sym-RULE-FLR-ROOM-SWITCH-1 — 회수 사유 2 · T9 동안 canRequest 거짓')
    const n = u.states.length
    mock.timers.tick(Timers.T9_MS - 1)
    assert.equal(u.f.canRequest, false, 'K-sym-RULE-FLR-ROOM-SWITCH-1 — T9 안')
    mock.timers.tick(1)
    assert.deepEqual([u.states.length, u.states.at(-1)!.canRequest], [n + 1, true], 'K-sym-RULE-FLR-ROOM-SWITCH-1 — T9 가 끝나면 state 하나 · canRequest 참')
    const v = unit()
    set(v, { cs: 'PERM', want: true })
    v.rx(revoke(4))
    v.rx(idle())
    assert.equal(v.f.canRequest, true, '선점(사유 4)에는 T9 가 없다 — 처방이 반대')
    u.f.dispose(); v.f.dispose()
  } finally { mock.timers.reset() }
})

test('K-sym-RULE-FLR-ROOM-SWITCH-2 — trusted:false 는 DC 생존 하나로만 바뀐다(발언 중 흔들림에 phase 는 그대로 · DC 사실이 아닌 사건은 trusted 를 바꾸지 않는다 · 재구축은 새 연결 DC 가 설 때 — link.test SD-ENTRY-LINK-REBUILT)', async () => {
  const u = unit()
  set(u, { cs: 'PERM', want: true })
  u.f.dcDown()
  assert.deepEqual([u.f.snapshot().trusted, u.f.snapshot().phase], [false, 'has_permission'], 'K-sym-RULE-FLR-ROOM-SWITCH-2 — 경고 경로: 말한다고 믿지만 확인 안 됨(phase 그대로 + trusted:false)')
  u.rx(revoke(4))
  u.rx(idle())
  u.f.queuePosition()
  u.f.down()
  u.f.join()
  u.f.linkChanged()
  assert.equal(u.f.snapshot().trusted, false, 'K-sym-RULE-FLR-ROOM-SWITCH-2 — 회수 · 반환 · 재동기 · 내림 · 입장 자체는 trusted 를 바꾸지 않는다(재구축의 회복은 연:LINK.C.REBUILD.rebuilt 의 floor.dc_up — DC 사실이다)')
  assert.equal(u.f.canRequest, false)
  u.f.dcUp()
  assert.equal(u.f.snapshot().trusted, true, 'K-sym-RULE-FLR-ROOM-SWITCH-2 — DC 다시 열림 하나로 돌아온다')
  u.f.dispose()
})

test('K-sym-RULE-FLR-ROOM-SWITCH-3 — 토글 앱이 로컬 플래그로 가르면(주입) 승계 뒤 다시 누르기가 철회가 된다 · 정상 예제는 acceptPending 으로 가른다', async () => {
  const click = async (u: U, flag: { on: boolean } | null): Promise<void> => {
    // 정상 예제 — state 로 가른다 · 주입 — 로컬 플래그로 가른다
    if (flag) { if (flag.on) { flag.on = false; await u.f.release() } else { flag.on = true; await u.f.press() } return }
    const s = u.f.snapshot()
    if (s.phase === 'has_permission' || (s.phase === 'queued' && !s.acceptPending)) await u.f.release()
    else await u.f.press()
  }
  const bad = unit()
  bad.f.input = 'toggle'
  const flag = { on: false }
  await click(bad, flag)
  for (let i = 0; i < 5; i++) await tick()
  bad.rx(qinfo(1))
  bad.rx(granted())
  await click(bad, flag)
  assert.equal(bad.f.st.cs, 'PREL', '주입 — 로컬 플래그면 승계 뒤 클릭이 release 로 나가 대기를 철회한다(증상)')
  bad.f.dispose()
  const good = unit()
  good.f.input = 'toggle'
  await click(good, null)
  for (let i = 0; i < 5; i++) await tick()
  good.rx(qinfo(1))
  good.rx(granted())
  assert.equal(good.f.snapshot().acceptPending, true)
  await click(good, null)
  assert.equal(good.f.st.cs, 'PERM', 'K-sym-RULE-FLR-ROOM-SWITCH-3 — 정상 예제: acceptPending 갈래의 클릭이 수락(press → 입구 intent)')
  good.f.dispose()
})

// ══ 받침 ② — 진짜 클라이언트 · 다른 영역의 사건이 발언권 입구에 닿는가 ══════════════════════════

/** 가짜 장치 — navigator.mediaDevices(platform/env 가 부르는 전역) · 획득마다 제약을 남긴다 */
interface FT { readonly kind: 'audio' | 'video'; readonly id: string; enabled: boolean; readyState: string; contentHint: string; stop(): void; addEventListener(): void; removeEventListener(): void; getSettings(): { deviceId: string }; applyConstraints(): Promise<void> }
let made = 0
function ft(kind: 'audio' | 'video'): FT & MediaStreamTrack {
  const t: FT = {
    kind, id: `${kind}-${++made}`, enabled: true, readyState: 'live', contentHint: '',
    stop() { t.readyState = 'ended' }, addEventListener() { /* 없다 */ }, removeEventListener() { /* 없다 */ },
    getSettings: () => ({ deviceId: kind === 'audio' ? 'mic-1' : 'cam-1' }), applyConstraints: () => Promise.resolve(),
  }
  return t as FT & MediaStreamTrack
}
const gum: { kind: string; c: MediaTrackConstraints }[] = []
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  mediaDevices: {
    enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'mic-1', label: 'mic-1', groupId: 'g1' }, { kind: 'videoinput', deviceId: 'cam-1', label: 'cam-1', groupId: 'g2' }],
    getUserMedia: async (c: MediaStreamConstraints) => {
      const kind = c.audio ? 'audio' : 'video'
      gum.push({ kind, c: (c.audio ?? c.video) as MediaTrackConstraints })
      const track = ft(kind)
      return { getAudioTracks: () => (kind === 'audio' ? [track] : []), getVideoTracks: () => (kind === 'video' ? [track] : []), getTracks: () => [track] }
    },
    addEventListener: () => undefined, removeEventListener: () => undefined,
  },
  permissions: { query: async () => ({ state: 'granted' }) },
} })

/** 발행 PeerLink — 트랜시버 자리(방 코덱을 남긴다) · 협상(settle) · DC(열림 · 보낸 발언권 메시지) */
interface PubPeer { slots: { kind: string; codec: { name: string }; replaced: (string | null)[] }[]; sent: C.Message[]; dcOpen: boolean; ice: string; sctpState: string | null; settle(ok?: boolean): void }
function pubPeer(): PubPeer {
  const waiting: ((r: { ok: boolean }) => void)[] = []
  const p = {
    slots: [] as PubPeer['slots'], sent: [] as C.Message[], dcOpen: false, ice: 'new', sctpState: 'connected' as string | null, assembled: 0, rx: new Map(),
    negotiate: () => { p.assembled++; return new Promise<{ ok: boolean }>((r) => waiting.push(r)) },
    settle: (ok = true) => { for (const w of waiting.splice(0)) w({ ok }) },
    setRows: () => undefined, receiverOf: () => null, close: () => undefined, restartWith: () => undefined, reopenDc: () => undefined, stats: async () => [],
    sendDc: (b: Uint8Array) => { if (!p.dcOpen) return false; p.sent.push(C.decode(Mbcp.unwrap(b)!)!); return true },
    acquireSlot: (kind: string, _sim: boolean, _enc: unknown, codec: { name: string }) => {
      const replaced: (string | null)[] = []
      const sender = { track: null as unknown, getParameters: () => ({ encodings: [{}] }), setParameters: async () => undefined, replaceTrack: async (t: { id: string } | null) => { sender.track = t; replaced.push(t ? t.id : null) }, getStats: async () => new Map() }
      const s = { kind, codec, replaced, mid: String(p.slots.length), transceiver: { direction: 'sendonly', sender } }
      p.slots.push(s)
      return s
    },
    releaseSlot: () => undefined, deactivate: () => undefined,
    sendInfo: (s: { kind: string; mid: string }) => ({ track: { kind: s.kind, ssrc: 1000 + Number(s.mid), mid: s.mid, pt: s.kind === 'audio' ? 111 : 102, codec: s.kind === 'audio' ? 'opus' : 'H264' }, ext: { mid_extmap_id: 1 } }),
  }
  return p
}

/** 들어가 있는 서버의 연결에 발행 PeerLink 를 끼운다 */
function wire(r: Rig, sc: ServerConfig = SA): PubPeer {
  const peer = pubPeer()
  const link = linkOf(r, sc)
  link.peer = peer as never
  r.peers.set(sc.sfu_id, peer as never)
  return peer
}

/** 그 서버 연결을 처음 세운다 — ICE · DC 가 섰다(everUp · up) */
function linkUp(r: Rig, sc: ServerConfig = SA): LinkCore {
  const link = linkOf(r, sc)
  const p = link.peer as unknown as { dcOpen: boolean; ice: string; sctpState: string | null }
  p.dcOpen = true
  p.ice = 'connected'
  p.sctpState = 'connected'
  link.fact({ t: 'ice', state: 'connected' })
  return link
}

/** 그 서버 DC 만 닫힌다(연관은 산다) · 다시 열린다 */
function dcClose(r: Rig, sc: ServerConfig = SA): void {
  const link = linkOf(r, sc)
  ;(link.peer as unknown as { dcOpen: boolean }).dcOpen = false
  link.fact({ t: 'dc', open: false })
}
function dcOpen(r: Rig, sc: ServerConfig = SA): void {
  const link = linkOf(r, sc)
  ;(link.peer as unknown as { dcOpen: boolean }).dcOpen = true
  link.fact({ t: 'dc', open: true })
}

/** 서버가 그 연결 DC 로 보낸 발언권 메시지 — 연결이 방 키로 가른다 */
function dcIn(r: Rig, m: C.Message, sc: ServerConfig = SA): void { linkOf(r, sc).fact({ t: 'dcData', data: Mbcp.wrap(C.encode(m)) }) }

/** 반이중 마이크는 이미 있다 — press 의 첫 단계를 비운다(발행 영역 시험은 pub.test · 아래 받침 ②-발행) */
function halfReady(r: Rig): void {
  const m = r.core.media as unknown as { hasHalfMic(): boolean; ensureHalfMic(): Promise<void>; warmHalf(): Promise<void> }
  m.hasHalfMic = () => true
  m.ensureHalfMic = async () => undefined
  m.warmHalf = async () => undefined
}

/** 그 방 발언권 클라 — 진짜 클라이언트 안의 것 */
const floorOf = (r: Rig, id: string): FloorCore => r.core.rooms.get(id)!.floor

/** press() 가 입구에 닿을 때까지 */
async function pressRoom(r: Rig, id: string): Promise<void> {
  await floorOf(r, id).press()
  for (let i = 0; i < 30 && floorOf(r, id).snapshot().arming; i++) await tick(5)
}

/** 지금 걸린 AFFILIATION 요청에 답한다 */
async function affReply(r: Rig, sub_rooms: string[], pub_room: string | null): Promise<Frame> {
  await tick()
  const f = r.ws.last(Op.AFFILIATION)
  r.ws.answer(f, { sub_rooms, pub_room, cause: 'user' })
  await tick()
  return f
}

/** 들어간 방 하나 · 연결 up · DC 탭 */
async function one(o: { pub?: boolean } = {}): Promise<{ r: Rig; h: Room; sent: C.Message[] }> {
  const r = await up()
  const h = await enter(r, 'r1', o.pub === false ? {} : { mode: 'talk', pub: 'r1' })
  const peer = wire(r)
  linkUp(r)
  return { r, h, sent: peer.sent }
}

test('SD-ENTRY-FLR-DC-DOWN · SD-ENTRY-FLR-DC-UP — 그 서버 DC 닫힘 · 다시 열림 하나에 그 서버 방마다 ENTRY.dcDown · dcUp 하나', () => spying(async (spy) => {
  const r = await up()
  await enter(r, 'r1'); await enter(r, 'r2'); await enter(r, 'r3', { sc: SB })
  linkUp(r); linkUp(r, SB)
  dcClose(r)
  assert.equal(spy.n('dcDown'), 2, 'SD-ENTRY-FLR-DC-DOWN — 그 서버 방(r1 · r2)마다 입구 dcDown 하나 · 다른 서버 0')
  assert.ok(spy.steps['dcDown']!.every((s) => s?.label === 'FLR.C.any.dc_down'), 'SD-ENTRY-FLR-DC-DOWN — 결합 코드 ENTRY 를 지난다')
  assert.deepEqual(['r1', 'r2', 'r3'].map((id) => floorOf(r, id).snapshot().trusted), [false, false, true])
  dcOpen(r)
  assert.equal(spy.n('dcUp'), 2, 'SD-ENTRY-FLR-DC-UP — 다시 열림 하나에 그 서버 방마다 입구 dcUp 하나')
  assert.ok(spy.steps['dcUp']!.every((s) => s?.label === 'FLR.C.any.dc_reopen'), 'SD-ENTRY-FLR-DC-UP — 결합 코드 ENTRY 를 지난다')
  assert.deepEqual(['r1', 'r2', 'r3'].map((id) => floorOf(r, id).snapshot().trusted), [true, true, true])
  await r.c.close()
}))

test('SD-SIGNAL-PTT-STATE-TRUSTED①②③ — DC 절단 → trusted:false · 연결 up → trusted:true(재동기 답을 기다리지 않는다) · 재동기 답을 잃어도 canRequest 막힘 0', async () => {
  const { r, h } = await one()
  halfReady(r)
  FakeWS.auto.delete(Op.READY)
  try {
    assert.deepEqual([h.ptt.state.trusted, h.ptt.state.canRequest], [true, true])
    dcClose(r)
    assert.equal(h.ptt.state.trusted, false, 'SD-SIGNAL-PTT-STATE-TRUSTED① — DC 절단 → trusted:false')
    assert.equal(h.link, 'wobbly')
    const readyBefore = r.ws.requests(Op.READY).length
    dcOpen(r)
    assert.equal(h.link, 'up')
    assert.equal(r.ws.requests(Op.READY).length, readyBefore + 1, '재동기(READY)가 나갔다 — 답은 오지 않는다')
    assert.equal(h.ptt.state.trusted, true, 'SD-SIGNAL-PTT-STATE-TRUSTED② — 연결 up 에 trusted:true(재동기 답을 기다리지 않는다)')
    await tick(20)
    assert.equal(h.ptt.state.canRequest, true, 'SD-SIGNAL-PTT-STATE-TRUSTED③ — 재동기 답을 잃어도 canRequest 막힘 0')
  } finally { FakeWS.auto.set(Op.READY, {}) }
  await r.c.close()
})

test('SD-ENTRY-FLR-QUEUE-POSITION — 연결 재동기 때 대기 중이면 ENTRY.queuePosition 하나(QPOS_REQ) · 앱 API 0', () => spying(async (spy) => {
  const { r, h, sent } = await one()
  halfReady(r)
  await pressRoom(r, 'r1')
  dcIn(r, C.buildQueueInfo({ info: { position: 2, priority: 0 }, room: 'r1' }))
  assert.equal(h.ptt.state.phase, 'queued')
  assert.equal(spy.n('queuePosition'), 0)
  dcClose(r)
  dcOpen(r)
  assert.equal(spy.n('queuePosition'), 1, 'SD-ENTRY-FLR-QUEUE-POSITION — 재동기(DC 다시 열림 → READY) 때 대기 중이면 입구 하나')
  assert.equal(spy.plan('queuePosition').label, 'FLR.C.QUEUED.qpos', 'SD-ENTRY-FLR-QUEUE-POSITION — 결합 코드 ENTRY 를 지난다')
  assert.equal(msgs(sent).at(-1), C.Type.QPOS_REQ)
  assert.ok(!('queuePosition' in h.ptt) && !('queuePosition' in Ptt.prototype), 'SD-ENTRY-FLR-QUEUE-POSITION — 앱 API 0(순번은 state.queue 로 읽는다)')
  await r.c.close()
}))

test('SD-ENTRY-FLR-RECEIVE — 그 방 DC 발언권 메시지(방 가르기 뒤) 하나에 ENTRY.receive 하나 · 다른 방 메시지 0', () => spying(async (spy) => {
  const r = await up()
  await enter(r, 'r1'); await enter(r, 'r2'); await enter(r, 'r3', { sc: SB })
  dcIn(r, C.buildTaken({ speaker: 'u2', seq: 1, room: 'r1' }))
  assert.equal(spy.n('receive'), 1, 'SD-ENTRY-FLR-RECEIVE — 입구 receive 하나')
  assert.equal(spy.plan('receive').label, 'FLR.C.NOPERM.rx_TAKEN', 'SD-ENTRY-FLR-RECEIVE — 결합 코드 ENTRY 를 지난다')
  assert.deepEqual(['r1', 'r2', 'r3'].map((id) => floorOf(r, id).st.shown), ['u2', null, null])
  dcIn(r, C.buildTaken({ speaker: 'u3', seq: 2, room: 'r2' }))
  assert.deepEqual(['r1', 'r2'].map((id) => floorOf(r, id).st.shown), ['u2', 'u3'], 'SD-ENTRY-FLR-RECEIVE — 다른 방(r2) 메시지는 r1 에 0')
  dcIn(r, C.buildTaken({ speaker: 'u4', seq: 3, room: 'r3' }))
  dcIn(r, C.buildTaken({ speaker: 'u5', seq: 4, room: 'nowhere' }))
  assert.equal(spy.n('receive'), 2, 'SD-ENTRY-FLR-RECEIVE — 다른 서버 방 · 모르는 방 메시지는 입구 0')
  assert.equal(floorOf(r, 'r3').st.shown, null)
  await r.c.close()
}))

test('SD-ENTRY-FLR-JOIN — 입장 응답(처음 · 다시 입장) 하나에 ENTRY.join 하나 · 다시 입장 뒤 그 방 발언권 클라가 left 가 아니다', () => spying(async (spy) => {
  const r = await up()
  await enter(r, 'r1')
  assert.equal(spy.n('join'), 1, 'SD-ENTRY-FLR-JOIN — 처음 입장 응답에 입구 join 하나')
  assert.equal(spy.plan('join').label, 'FLR.C.any.join', 'SD-ENTRY-FLR-JOIN — 결합 코드 ENTRY 를 지난다')
  await enter(r, 'r2')
  // r2 의 입장 응답이 r1 을 sub_rooms 에서 뺐다 — r1 은 떠나 다시 입장한다(같은 방 핸들)
  const p = r.c.join('r4')
  await tick()
  r.ws.answer(joinFrame(r.ws, 'r4'), joinBody(r, 'r4', { subs: ['r2', 'r4'] }))
  await tick()
  await drain(r)
  await p
  assert.equal(floorOf(r, 'r1').st.left, true, '스냅샷에서 빠져 그 방 발언권은 떠났다')
  const joins = spy.n('join')
  r.ws.answer(joinFrame(r.ws, 'r1'), joinBody(r, 'r1', { subs: ['r1', 'r2', 'r4'] }))
  await tick()
  await drain(r)
  assert.equal(spy.n('join'), joins + 1, 'SD-ENTRY-FLR-JOIN — 다시 입장 응답에 입구 join 하나')
  assert.equal(floorOf(r, 'r1').st.left, false, 'SD-ENTRY-FLR-JOIN — 다시 입장 뒤 left 가 아니다')
  await r.c.close()
}))

test('SD-ENTRY-FLR-LEAVE — 퇴장 · 강제 퇴장 · 스냅샷에서 빠짐 하나마다 그 방 ENTRY.leave 하나', () => spying(async (spy) => {
  const r = await up()
  for (const id of ['r1', 'r2', 'r3']) await enter(r, id)
  const f1 = floorOf(r, 'r1')
  const f2 = floorOf(r, 'r2')
  const f3 = floorOf(r, 'r3')
  void r.c.rooms.get('r1')!.leave()
  await tick()
  assert.equal(spy.n('leave'), 1, 'SD-ENTRY-FLR-LEAVE — room.leave() 에 입구 leave 하나')
  assert.equal(spy.plan('leave').label, 'FLR.C.any.leave', 'SD-ENTRY-FLR-LEAVE — 결합 코드 ENTRY 를 지난다')
  assert.deepEqual([f1.st.left, f2.st.left, f3.st.left], [true, false, false])
  r.ws.answer(leaveFrame(r.ws, 'r1'), {})
  await tick()
  await note(r, Op.ROOM_EVENT, { type: 'affiliation', room_id: 'r2', affiliation: { sub_rooms: [], pub_room: null }, cause: 'kick' })
  assert.equal(spy.n('leave'), 2, 'SD-ENTRY-FLR-LEAVE — 강제 퇴장에 입구 leave 하나')
  assert.deepEqual([f2.st.left, f3.st.left], [true, false])
  const p = r.c.join('r5')
  await tick()
  r.ws.answer(joinFrame(r.ws, 'r5'), joinBody(r, 'r5', { subs: ['r5'] }))
  await tick()
  await drain(r)
  await p
  assert.equal(spy.n('leave'), 3, 'SD-ENTRY-FLR-LEAVE — 스냅샷(sub_rooms)에서 빠짐에 입구 leave 하나')
  assert.equal(f3.st.left, true)
  await r.c.close()
}))

test("SD-ENTRY-FLR-PUB-SELECT · SD-ENTRY-FLR-PUB-AWAY — 소속 응답에 새 발언 방 ENTRY.pubSelect 하나 · 옛 방 ENTRY.pubAway 하나 · 옛 방 lastEnd:'moved'", () => spying(async (spy) => {
  const r = await up()
  const h1 = await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
  const h2 = await enter(r, 'r2', { pub: 'r1' })
  wire(r); linkUp(r); halfReady(r)
  await pressRoom(r, 'r1')
  dcIn(r, C.buildGranted({ priority: 0, duration: 30, room: 'r1' }))
  assert.equal(h1.ptt.state.phase, 'has_permission')
  const sel = spy.n('pubSelect')
  const away = spy.n('pubAway')
  const p = r.c.setSpeakingRoom('r2')
  await affReply(r, ['r1', 'r2'], 'r2')
  await p
  assert.equal(spy.n('pubSelect'), sel + 1, 'SD-ENTRY-FLR-PUB-SELECT — 소속 응답(이 방이 발언 방)에 입구 pubSelect 하나')
  assert.equal(spy.plan('pubSelect').label, 'FLR.C.any.pub_select', 'SD-ENTRY-FLR-PUB-SELECT — 결합 코드 ENTRY 를 지난다')
  assert.equal(floorOf(r, 'r2').st.isPub, true)
  assert.equal(spy.n('pubAway'), away + 1, 'SD-ENTRY-FLR-PUB-AWAY — 소속 응답(발언 방에서 빠짐)에 입구 pubAway 하나')
  assert.equal(spy.plan('pubAway').label, 'FLR.C.any.pub_away', 'SD-ENTRY-FLR-PUB-AWAY — 결합 코드 ENTRY 를 지난다')
  assert.deepEqual([h1.ptt.state.phase, h1.ptt.state.lastEnd], ['no_permission', 'moved'], "SD-ENTRY-FLR-PUB-AWAY — lastEnd:'moved'")
  assert.equal(h2.ptt.state.lastEnd, undefined)
  await r.c.close()
}))

test("SD-ENTRY-FLR-DOWN · SD-SIGNAL-SESSION-RECOVERING — 서버 재구축이면 그 서버 방만 ENTRY.down · rebuilding · 세션 재구축이면 전부 · lastEnd:'rebuilt'", () => spying(async (spy) => {
  const r = await up()
  const h1 = await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
  const h3 = await enter(r, 'r3', { sc: SB })
  wire(r); linkUp(r); linkUp(r, SB); halfReady(r)
  await pressRoom(r, 'r1')
  dcIn(r, C.buildGranted({ priority: 0, duration: 30, room: 'r1' }))
  assert.equal(h1.ptt.state.phase, 'has_permission')
  linkOf(r, SA).fact({ t: 'sctp', state: 'closed' })
  assert.equal(spy.n('down'), 1, 'SD-ENTRY-FLR-DOWN — 그 서버 재구축에 그 서버 방마다 입구 down 하나')
  assert.equal(spy.plan('down').label, 'FLR.C.any.down', 'SD-ENTRY-FLR-DOWN — 결합 코드 ENTRY 를 지난다')
  assert.deepEqual([h1.ptt.state.phase, h1.ptt.state.lastEnd], ['no_permission', 'rebuilt'], "SD-ENTRY-FLR-DOWN — 발언권을 잃고 lastEnd:'rebuilt'(반이중 마이크는 다시 발행된다 — off 로 가지 않는다)")
  assert.deepEqual([h1.rebuilding, h3.rebuilding, r.c.session.recovering], [true, false, true], 'SD-SIGNAL-SESSION-RECOVERING — 서버 재구축이면 그 서버 방만 rebuilding · 세션 recovering')
  const downs = spy.n('down')
  r.ws.close()
  for (let i = 0; i < 300 && FakeWS.made.length < 2; i++) await tick(10)
  const ws2 = FakeWS.made.at(-1)!
  ws2.open(); await tick()
  ws2.reply(Op.BIND, { ...BIND_OK, session_id: 's-2' })
  await tick()
  assert.equal(spy.n('down') - downs, 2, 'SD-ENTRY-FLR-DOWN — 세션 재구축이면 방 전부에 입구 down 하나씩')
  assert.deepEqual([h1.rebuilding, h3.rebuilding, r.c.session.recovering], [true, true, true], 'SD-SIGNAL-SESSION-RECOVERING — 세션 재구축이면 방 전부 rebuilding')
  await r.c.close()
}))

// ── 받침 ②-발행 — 진짜 반이중 마이크(발행 상태기 · 게이트) ─────────────────────────────────

/** 마지막 PUBLISH_TRACKS add 에 응답한다 — 그 mid 에 track_id */
function answerAdd(r: Rig, trackId: string): void {
  const f = r.ws.requests(Op.PUBLISH_TRACKS).filter((q) => (q.body as { action: string }).action === 'add').at(-1)!
  const mid = (f.body as { tracks: { mid: string }[] }).tracks[0]!.mid
  r.ws.answer(f, { tracks: [{ mid, track_id: trackId }] })
}
const adds = (r: Rig): { tracks: Record<string, unknown>[] }[] => r.ws.requests(Op.PUBLISH_TRACKS).map((f) => f.body as never).filter((b: { action: string }) => b.action === 'add')

/** 발행 한 바퀴 — 협상을 끝내고 add 에 응답한다 */
async function settlePublish(r: Rig, trackId: string): Promise<void> {
  await tick()
  await drain(r)
  answerAdd(r, trackId)
  await tick(); await tick()
}

test('SD-ENTRY-FLR-REGISTER-HALF — 그 서버 반이중 마이크 발행이 섬(ptt.enable) 하나에 그 서버 방마다 ENTRY.registerHalf 하나', () => spying(async (spy) => {
  const r = await up()
  const h = await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
  await enter(r, 'r2', { pub: 'r1' })
  await enter(r, 'r3', { sc: SB })
  wire(r)
  const p = h.ptt.enable()
  await settlePublish(r, 't-half')
  await p
  assert.equal(spy.n('registerHalf'), 2, 'SD-ENTRY-FLR-REGISTER-HALF — 그 서버 방(r1 · r2)마다 입구 registerHalf 하나 · 다른 서버 0')
  assert.ok(spy.steps['registerHalf']!.every((s) => s?.label === 'FLR.C.any.reg_half'), 'SD-ENTRY-FLR-REGISTER-HALF — 결합 코드 ENTRY 를 지난다')
  assert.deepEqual(['r1', 'r2', 'r3'].map((id) => floorOf(r, id).st.hasHalf), [true, true, false])
  assert.equal(h.ptt.state.phase, 'no_permission', "반이중 마이크가 섰다 — 'off' 를 벗어난다")
  await r.c.close()
}))

test('SD-ENTRY-FLR-RTP-TX — 허가(mic.open)로 게이트가 열려 반이중 송출이 시작되면 ENTRY.rtpTx 하나', () => spying(async (spy) => {
  const r = await up()
  const h = await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
  const peer = wire(r)
  const p = h.ptt.enable()
  await settlePublish(r, 't-half')
  await p
  linkUp(r)
  await pressRoom(r, 'r1')
  assert.deepEqual([msgs(peer.sent), spy.n('rtpTx')], [[C.Type.REQUEST], 0], '허가 전에는 게이트가 닫혀 있다 — 송출 0')
  dcIn(r, C.buildGranted({ priority: 0, duration: 30, room: 'r1' }))
  await tick()
  assert.equal(peer.slots[0]!.replaced.filter((x) => x !== null).length, 1, '게이트가 열렸다 — sender 에 소스 하나')
  assert.equal(spy.n('rtpTx'), 1, 'SD-ENTRY-FLR-RTP-TX — 게이트 열림 뒤 첫 송출에 입구 rtpTx 하나')
  assert.equal(spy.plan('rtpTx').label, 'FLR.C.PERM.rtp_tx', 'SD-ENTRY-FLR-RTP-TX — 결합 코드 ENTRY 를 지난다')
  assert.equal(typeof h.ptt.state.talkingSince, 'number')
  await r.c.close()
}))

test('SD-API-PTT-ENABLE — 서버당 반이중 발행 하나 · 옵션은 서버당 첫 것이 이긴다 · track 경로(외부 트랙 · 획득 0)', async () => {
  gum.length = 0
  const r = await up()
  const h1 = await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
  const h2 = await enter(r, 'r2', { pub: 'r1' })
  wire(r)
  const p = h1.ptt.enable({ capture: { echoCancellation: false } })
  await settlePublish(r, 't-half')
  await p
  await h2.ptt.enable({ capture: { autoGainControl: false } })
  await tick()
  assert.equal(adds(r).length, 1, 'SD-API-PTT-ENABLE — 같은 서버 두 방의 enable 에 반이중 발행 하나')
  assert.deepEqual([gum.length, gum[0]!.c.echoCancellation, gum[0]!.c.autoGainControl], [1, false, true], 'SD-API-PTT-ENABLE — 옵션은 서버당 첫 enable 것(뒤 것은 무시)')
  assert.equal(adds(r)[0]!.tracks[0]!['duplex'], 'half')
  await r.c.close()

  gum.length = 0
  const x = await up()
  const hx = await enter(x, 'r1', { mode: 'talk', pub: 'r1' })
  wire(x)
  const tone = ft('audio')
  const q = hx.ptt.enable({ track: tone })
  await settlePublish(x, 't-ext')
  await q
  const half = x.core.media.halfMic('sfu-a')!
  assert.deepEqual([gum.length, half.owner, half.duplex, adds(x).length], [0, 'external', 'half', 1], 'SD-API-PTT-ENABLE — track 경로: 앱 트랙을 반이중으로(획득 0 · owner external)')
  await hx.ptt.enable()
  assert.equal(adds(x).length, 1, 'SD-API-PTT-ENABLE — 외부 트랙이 선 뒤에도 서버당 하나')
  await x.c.close()
})

test('SD-API-PTT-ENABLE-VIDEO — 반이중 영상은 그 방 미디어 코덱(슬롯 코덱)을 따른다 · 방이 비운 칸은 기본값(H264)', async () => {
  for (const [codecs, want] of [[{ audio: 'opus', video: 'VP8' }, 'VP8'], [{ audio: 'opus' }, 'H264']] as const) {
    const r = await up()
    const p = r.c.join('r1', { mode: 'talk' })
    await tick()
    linkOf(r, SA)
    r.ws.answer(joinFrame(r.ws, 'r1'), { ...joinBody(r, 'r1', { pub: 'r1' }), media_codecs: codecs })
    await tick()
    await drain(r)
    const h = await p
    const peer = wire(r)
    const v = h.ptt.enableVideo()
    await settlePublish(r, 't-pv')
    const t = await v
    assert.deepEqual([t.duplex, peer.slots.at(-1)!.kind, peer.slots.at(-1)!.codec.name], ['half', 'video', want], `SD-API-PTT-ENABLE-VIDEO — 방 코덱 ${JSON.stringify(codecs)} → 발행 코덱 ${want}(앱이 고르는 칸 없음)`)
    await r.c.close()
  }
})

// ── 받침 ②-수신 — 무전 슬롯 수신 트랙(트랙 영역 · 가짜 수신 트랜시버) ─────────────────────────

const slotOf = (room: string, kind: 'audio' | 'video'): TrackEntry => ({ type: 'slot', room_id: room, track_id: `ptt-${room}-${kind}`, kind })
const row = (mid: string, track_id: string, kind: 'audio' | 'video', room_id = 'r1'): MlineEntry => ({ mid, kind, pt: kind === 'audio' ? 111 : 102, codec: kind === 'audio' ? 'opus' : 'H264', ssrc: 2147480000 + Number(mid), stream_id: `ox-m${mid}`, track_id, room_id })
function rxSlot(r: Rig, mid: string, kind: 'audio' | 'video', sc: ServerConfig = SA): FakeTrack {
  linkOf(r, sc)
  const t = fakeTrack(kind)
  r.peers.get(sc.sfu_id)!.rx.set(mid, { track: t, getStats: async () => new Map() })
  return t
}

test('SD-ENTRY-FLR-RTP-RX — 그 방 무전 슬롯 오디오가 닿으면(첫 디코딩 프레임) 그 방 ENTRY.rtpRx 하나 · 슬롯 영상은 0', () => spying(async (spy) => {
  const r = await up()
  const a = rxSlot(r, '0', 'audio')
  const v = rxSlot(r, '1', 'video')
  await enter(r, 'r1', { tracks: [slotOf('r1', 'audio'), slotOf('r1', 'video')], mlines: [row('0', 'ptt-r1-audio', 'audio'), row('1', 'ptt-r1-video', 'video')] })
  await tick()
  v.unmute()
  await tick()
  assert.equal(spy.n('rtpRx'), 0, '슬롯 영상은 입구 0')
  a.unmute()
  await tick()
  assert.equal(spy.n('rtpRx'), 1, 'SD-ENTRY-FLR-RTP-RX — 그 방 슬롯 오디오 수신에 입구 rtpRx 하나')
  assert.equal(spy.plan('rtpRx').label, 'FLR.C.NOPERM.rtp_rx', 'SD-ENTRY-FLR-RTP-RX — 결합 코드 ENTRY 를 지난다')
  await r.c.close()
}))

test('SD-EFFECT-FLR-MEDIA-RENDER — 위 효과 media.render 에 playback.render — 받은 슬롯 오디오를 그 방 room.audio 로 낸다', () => spying(async (spy) => {
  const r = await up()
  const a = rxSlot(r, '0', 'audio')
  await enter(r, 'r1', { tracks: [slotOf('r1', 'audio')], mlines: [row('0', 'ptt-r1-audio', 'audio')] })
  await tick()
  // 문서가 이제 생긴다 — 그 뒤의 재생 요소는 효과 media.render 가 만든다
  const els: { attrs: Record<string, string>; played: number; muted: boolean; srcObject: unknown }[] = []
  const g = globalThis as unknown as Record<string, unknown>
  g['document'] = { createElement: () => { const el = { attrs: {} as Record<string, string>, played: 0, muted: false, volume: 1, srcObject: null as unknown, autoplay: false, isConnected: false, setAttribute(k: string, val: string) { el.attrs[k] = val }, pause() { /* 없다 */ }, remove() { /* 없다 */ }, play() { el.played++; return Promise.resolve() } }; els.push(el); return el } }
  g['MediaStream'] = class { constructor(readonly ts: unknown[]) {} getAudioTracks(): unknown[] { return this.ts } }
  try {
    a.unmute()
    await tick()
    assert.ok(spy.plan('rtpRx').actions.includes('playback.render'), 'SD-EFFECT-FLR-MEDIA-RENDER — 결합 코드 plan() 이 낸다')
    assert.equal(els.length, 1)
    assert.deepEqual([els[0]!.attrs['data-oxlens-room'], els[0]!.attrs['data-oxlens-track'], els[0]!.played > 0, els[0]!.muted], ['r1', 'ptt-r1-audio', true, false], 'SD-EFFECT-FLR-MEDIA-RENDER — 그 방 room.audio(음소거 · 음량 그대로)로 재생')
  } finally { delete g['document']; delete g['MediaStream'] }
  await r.c.close()
}))

test('SD-EVENT-SPEAKER — 화자는 방마다 갈린다 · 슬롯 트랙이 늦게 오면 trackIds 를 채워 다시 낸다', async () => {
  const r = await up()
  const h1 = await enter(r, 'r1')
  const h2 = await enter(r, 'r2')
  const s1: { userId: string | null; trackIds: string[] }[] = []
  const s2: unknown[] = []
  h1.ptt.on('speaker', (x) => s1.push(x))
  h2.ptt.on('speaker', (x) => s2.push(x))
  dcIn(r, C.buildTaken({ speaker: 'u2', seq: 1, room: 'r1' }))
  assert.deepEqual([s1, s2], [[{ userId: 'u2', trackIds: [] }], []], 'SD-EVENT-SPEAKER — 그 방 화자만(방 가름) · 슬롯 트랙이 아직 없으면 빈 배열')
  rxSlot(r, '0', 'audio')
  await note(r, Op.MLINE_EVENT, { table: { sfu_id: SA.sfu_id, arev: 2, mlines: [row('0', 'ptt-r1-audio', 'audio')] } })
  await note(r, Op.TRACK_EVENT, { action: 'add', room_id: 'r1', tracks: [slotOf('r1', 'audio')], version: vers(2) })
  await drain(r)
  assert.deepEqual(s1.at(-1), { userId: 'u2', trackIds: ['ptt-r1-audio'] }, 'SD-EVENT-SPEAKER — 슬롯 트랙 늦은 도착에 다시 낸다')
  assert.deepEqual(s2, [], 'SD-EVENT-SPEAKER — 다른 방은 0')
  const n = s1.length
  r.core.rooms.get('r1')!.tracksChanged()
  assert.equal(s1.length, n, '같은 화자 · 같은 트랙이면 다시 내지 않는다')
  await r.c.close()
})

test('SD-SIGNAL-LINK — link 이벤트 · room.link · health 는 같은 연결 기록(LINK 전이)에서 나온다(어긋남 0)', async () => {
  const r = await up()
  const h1 = await enter(r, 'r1')
  const h3 = await enter(r, 'r3', { sc: SB })
  const events: { server: string; state: string }[] = []
  r.c.on('link', (i) => events.push({ server: i.server, state: i.state }))
  // 연결 기록 한 줄(위 상태 ls) → 앱 값 — SDK:IMPL-LINK-PROJECTION 투영표 그대로
  const project = (ls: string, everUp: boolean): string => (ls === 'NONE' ? 'closed' : ls === 'REBUILD' ? 'rebuilding' : ls === 'WAIT' || ls === 'REOPEN' ? 'wobbly' : ls === 'CHECK' || ls === 'RESTART' || ls === 'APPLY' ? 'restarting' : everUp ? 'up' : 'connecting')
  const health = (s: string): string => (s === 'rebuilding' ? 'recovering' : s === 'wobbly' || s === 'restarting' ? 'degraded' : 'ok')
  const check = (why: string): void => {
    const rec = r.trace.filter((t) => t.layer === 'LINK' && t.key === SA.sfu_id).at(-1)!
    const st = project(rec.to, r.core.links.get(SA.sfu_id)!.everUp)
    const last = events.filter((e) => e.server === SA.sfu_id).at(-1)?.state
    assert.deepEqual([last, h1.link, r.c.health], [st, st, health(st)], `SD-SIGNAL-LINK — ${why}: 마지막 연결 기록(${rec.label} → ${rec.to})의 투영 하나에서 link 이벤트 · room.link · health 가 나온다`)
    assert.equal(h3.link, r.core.links.get(SB.sfu_id)!.state, 'SD-SIGNAL-LINK — 다른 서버 방은 제 연결')
  }
  linkUp(r, SB)
  linkUp(r)
  check('첫 수립')
  linkOf(r, SA).fact({ t: 'ice', state: 'disconnected' })
  check('흔들림')
  linkOf(r, SA).fact({ t: 'ice', state: 'connected' })
  check('되살아남')
  linkOf(r, SA).fact({ t: 'sctp', state: 'closed' })
  check('재구축')
  await r.c.close()
})

test('SD-API-PTT-PRESS②⑥ — 입장 직후(DC 전) press 는 reject 0 · arming 1 · DC 열림 뒤 REQUEST 1 · 연결이 up 아니면 recovering · 연타해도 하나 · 시한 0 · 복구 뒤 REQUEST 1 · 발언 방 전환이면 pub_select 응답 뒤', () => spying(async (spy) => {
  for (const input of ['hold', 'toggle'] as const) {
    const r = await up()
    const h = await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
    const peer = wire(r)
    halfReady(r)
    h.ptt.input = input
    const settled = await h.ptt.press().then(() => 'resolve', () => 'reject')
    await tick(20)
    assert.deepEqual([settled, h.ptt.state.arming, h.ptt.state.armingStage, msgs(peer.sent)], ['resolve', true, 'transport', []], `SD-API-PTT-PRESS② — ${input}: 입장 직후(DC 개설 전) press() reject 0 · arming:true`)
    linkUp(r)
    await tick(80)
    assert.deepEqual([h.ptt.state.arming, msgs(peer.sent)], [false, [C.Type.REQUEST]], `SD-API-PTT-PRESS② — ${input}: DC open 뒤 REQUEST 하나`)
    await h.ptt.release()
    dcIn(r, C.buildIdle({ seq: 1, room: 'r1' }))
    peer.sent.length = 0
    // 그 서버 연결이 흔들린다 — up 이 아니다
    linkOf(r, SA).fact({ t: 'ice', state: 'disconnected' })
    const before = spy.n('press')
    for (let i = 0; i < 3; i++) await h.ptt.press()
    await tick(300)
    assert.deepEqual([h.ptt.state.arming, h.ptt.state.armingStage, spy.n('press') - before, msgs(peer.sent)], [true, 'recovering', 0, []], `SD-API-PTT-PRESS⑥ — ${input}: up 아님 → arming · 'recovering' · 연타해도 하나 · 시한 0(300ms 뒤에도 기다린다)`)
    linkOf(r, SA).fact({ t: 'ice', state: 'connected' })
    await tick(80)
    assert.deepEqual([h.ptt.state.arming, spy.n('press') - before, msgs(peer.sent)], [false, 1, [C.Type.REQUEST]], `SD-API-PTT-PRESS⑥ — ${input}: 복구 뒤 release() 가 없었으면 REQUEST 하나`)
    await r.c.close()
  }
  const r = await up()
  await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
  const h2 = await enter(r, 'r2', { pub: 'r1' })
  const peer = wire(r)
  linkUp(r); halfReady(r)
  await h2.ptt.press()
  await tick(20)
  assert.deepEqual([h2.ptt.state.armingStage, msgs(peer.sent), r.ws.requests(Op.AFFILIATION).length], ['select', [], 1], 'SD-API-PTT-PRESS⑥ — 발언 방 전환이면 소속 응답 전 REQUEST 0')
  await affReply(r, ['r1', 'r2'], 'r2')
  await tick(80)
  assert.deepEqual(msgs(peer.sent), [C.Type.REQUEST], 'SD-API-PTT-PRESS⑥ — pub_select 응답 뒤 REQUEST 하나')
  await r.c.close()
}))

test('재발 20261102d-9 — arming 중 release 뒤 다시 press 하면 그 누름은 산다(연:RULE-FLR-PROC-PRESS · 버튼은 눌려 있다)', () => spying(async (spy) => {
  const c = unit()
  let go!: () => void
  c.media.half = false
  c.media.hold = new Promise<void>((r) => { go = r })
  await c.f.press()
  await c.f.release()
  await c.f.press()
  go()
  for (let i = 0; i < 10; i++) await tick()
  assert.deepEqual([msgs(c.sent), spy.n('press')], [[C.Type.REQUEST], 1], '재발 9 — 둘째 누름이 REQUEST 하나로 간다(유실 0)')
  c.f.dispose()
}))
