// author: kodeholic (powered by Claude)
// SDK:IMPL-ROOM-API · SDK:RULE-ROOM-PERMISSION-BITS · SDK:RULE-ROOM-RESYNC — 방 영역 1층. 위가 지은 방 상태기 둘레의 손 결합(보관본 · 보내는 몸통)을 잰다.
// ★입구는 위 결합(room_binding)의 ENTRY 를 지나는지 · 표면은 효과 표(effect)대로 나는지를 ROOM 단위(SD-ENTRY-ROOM-* · SD-EFFECT-ROOM-* · SD-API-* · K-sym-*)마다 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 진짜 연결 상태기(LinkCore)에 가짜 PeerLink(협상은 시험이 끝낸다).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWS, tick, type Frame } from './_ws.js'
import * as ROOM from '../src/domain/gen/room_client.js'
import * as RB from '../src/domain/gen/room_binding.js'
import * as AFF from '../src/domain/gen/aff_client.js'
import { RoomCore } from '../src/domain/room/core.js'
import { Op, type MemberInfo, type Permission, type RoomSnapshot, type RoomJoinRes, type ServerConfig, type TrackEntry, type GetRoomRes } from '../src/internal/wire/ws.js'
import type { Core } from '../src/domain/ses/core.js'
import { createClient, OxLensError, Room, type OxLensClient, type ClientOptions } from '../src/index.js'
import { localOf } from '../src/api/handles.js'
import { LinkCore } from '../src/domain/links.js'
import { LocalCore } from '../src/domain/media-registry.js'
import { SC } from './_fixtures.js'

const ALL: Permission = { publish_audio: true, publish_video: true, publish_screen: true, floor_request: true }
const NO_FLOOR: Permission = { ...ALL, floor_request: false }

function fake(): { core: Core; sent: { op: string; body: unknown }[] } {
  const sent: { op: string; body: unknown }[] = []
  const core = {
    cfg: { wakeDetectMs: 1000 },
    userId: 'u1',
    epochs: { id: (e: string) => (e === 'e1' ? 1 : 2) },
    record: () => undefined,
    impossible: (layer: string, key: string, from: string, entry: string) => { throw new Error(`받지 않는 사건 ${layer} ${key} ${from} ${entry}`) },
    linkFor: () => ({ sdpArev: 7, flushPendingTable: () => undefined }),
    log: { debug: () => undefined, warn: () => undefined, error: () => undefined },
    media: { hasHalfMic: () => false, halfMicCold: () => true, ownsTrack: () => false, permissionChanged: () => undefined },
    sig: { request: (op: string, body: unknown) => { sent.push({ op, body }); return new Promise(() => undefined) } },
  } as unknown as Core
  return { core, sent }
}

function joined(core: Core): RoomCore {
  const room = new RoomCore(core, 'r1', {})
  room.st = { ...ROOM.initial(), rs: 'JOINED', cseq: 3, cepoch: 1 }
  return room
}

const member = (user_id: string, permission: Permission): MemberInfo => ({ user_id, select: false, participant_type: 0, permission })

test('연:SUB.op.READY — READY 는 room_id · arev 만 싣는다(camera 갈래 없음 · 대장 C-37 ③)', () => {
  const { core, sent } = fake()
  joined(core).trk.sendReady()
  assert.deepEqual(sent, [{ op: 'READY', body: { room_id: 'r1', arev: 7 } }])
})

test('연:DEV-ROOM-ME-APART — 내 권한의 출처는 스냅샷의 me 다(명단의 내 항목이 아니다 · 대장 C-38 ④)', () => {
  const { core } = fake()
  const room = joined(core)
  const snap: RoomSnapshot = { participants: [member('u1', ALL), member('u2', ALL)], me: member('u1', NO_FLOOR), tracks: [], version: { epoch: 'e1', seq: 9 } }
  room.resumeSnap(snap)
  assert.equal(room.permission.floorRequest, false)
  assert.equal(room.st.cseq, 9)
})

test('연:DEV-ROOM-HIDDEN-SELF-PSTATE — version 없는 내 PARTICIPANT_STATE 는 견주지 않고 반영 · 보관 seq 그대로(대장 C-38 ④)', () => {
  const { core } = fake()
  const room = joined(core)
  const seen: { userId: string; mine: boolean }[] = []
  room.events.on('permission', (c) => seen.push({ userId: c.userId, mine: c.mine }))
  room.delta('PARTICIPANT_STATE', { type: 'permission', user_id: 'u1', room_id: 'r1', permission: NO_FLOOR })
  assert.equal(room.permission.floorRequest, false)
  assert.equal(room.st.cseq, 3)
  assert.deepEqual(seen, [{ userId: 'u1', mine: true }])
})

/** 방을 내리거나 트랙을 붙이는 길이 지나는 곳만 더한 가짜(소속 · 연결 없음) */
function fakeWide(): { core: Core; sent: { op: string; body: unknown }[] } {
  const f = fake()
  Object.assign(f.core, { rooms: Object.assign(new Map(), { aff: { st: AFF.initial(), step: () => undefined }, drop: () => undefined }), roomsOn: () => [], linkFor: () => undefined })
  return f
}

test('연:DEV-ROOM-LEAVE-WHILE-JOINING — 나가려고 입장 응답을 기다리던 방을 재구축이 내리면 ROOM_LEAVE 를 보낸다(ROOM.C.JOINING.down_quit · 유령 회원 — context 20261102b)', () => {
  const { core, sent } = fakeWide()
  const room = new RoomCore(core, 'r1', {})
  room.st = { ...ROOM.initial(), rs: 'JOINING', quit: true }
  room.downAll()
  assert.equal(room.st.rs, 'LEAVING')
  assert.deepEqual(sent.filter((s) => s.op === 'ROOM_LEAVE'), [{ op: 'ROOM_LEAVE', body: { room_id: 'r1' } }])
})

test('연:RULE-ROOM-VERSION-CLIENT-RULES — 트랙 통지는 방 상태기가 받은 것만 트랙 목록에 닿는다(trk.delta · 낡은 seq 는 닿지 않는다 — context 20261102a 1단)', () => {
  const { core } = fakeWide()
  const room = joined(core)
  const track = (seq: number) => ({ action: 'add', tracks: [{ track_id: 'tA', active: true, muted: false }], version: { epoch: 'e1', seq } })
  room.delta('TRACK_EVENT', track(3))
  assert.equal(room.trk.st.lay['tA' as never], undefined)
  room.delta('TRACK_EVENT', track(4))
  assert.equal(room.trk.st.lay['tA' as never], 'ACTIVE')
})

// ══ ROOM 영역 1층 — 입구 표 · 효과 표 · 표면 ══════════════════════════════

const BIND_OK = { user_id: 'u1', server_ver: 1, heartbeat_interval: 10_000, session_id: 's-1', resume_window_ms: 60_000, pc_mode: '2pc' }
const SA: ServerConfig = { ...SC, sfu_id: 'sfu-a' }
const SB: ServerConfig = { ...SC, sfu_id: 'sfu-b', ice: { ...SC.ice, publish_ufrag: 'pubUfB' } }
const NO_AUDIO: Permission = { ...ALL, publish_audio: false }

/** 위 결합 ENTRY 의 입구마다 불린 인자(상태 뒤) — SDK 사건이 결합 코드를 지났나를 잰다 */
function spyEntry(): { calls: Record<string, unknown[][]>; n(k: string): number; restore(): void } {
  const E = RB.ENTRY as unknown as Record<string, (...a: unknown[]) => unknown>
  const saved = { ...E }
  const calls: Record<string, unknown[][]> = {}
  for (const k of Object.keys(saved)) {
    calls[k] = []
    E[k] = (...a: unknown[]) => { calls[k]!.push(a.slice(1)); return saved[k]!(...a) }
  }
  return { calls, n: (k) => calls[k]?.length ?? 0, restore: () => { Object.assign(E, saved) } }
}

/** PeerLink 자리 — 협상은 settle() 이 끝낸다 · 조립 횟수를 센다 */
interface FakePeer { assembled: number; settle(ok?: boolean): void }
function fakePeer(): FakePeer {
  const waiting: ((r: { ok: boolean }) => void)[] = []
  const p = {
    assembled: 0, dcOpen: false, ice: 'new', sctpState: null,
    negotiate: () => { p.assembled++; return new Promise<{ ok: boolean }>((r) => waiting.push(r)) },
    settle: (ok = true) => { for (const w of waiting.splice(0)) w({ ok }) },
    setRows: () => undefined, receiverOf: () => null, sendDc: () => false, close: () => undefined,
    acquireSlot: (kind: string) => ({ kind, transceiver: null, mid: null }), releaseSlot: () => undefined, deactivate: () => undefined,
    sendInfo: () => null, restartWith: () => undefined, reopenDc: () => undefined, stats: async () => [],
  }
  return p
}

interface Rig { c: OxLensClient; core: Core; ws: FakeWS; peers: Map<string, FakePeer>; labels: { key: string; label: string }[] }

async function up(o: Partial<ClientOptions> = {}): Promise<Rig> {
  FakeWS.made.length = 0
  FakeWS.auto.set(Op.READY, {})
  const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc', massJitterMs: 0, ...o })
  const r: Rig = { c, core: c.core, ws: undefined as unknown as FakeWS, peers: new Map(), labels: [] }
  c.diagnostics.on('transition', (t) => { if (t.layer === 'ROOM') r.labels.push({ key: t.key, label: t.label }) })
  const p = c.connect()
  await tick(); r.ws = FakeWS.made[0]!; r.ws.open(); await tick()
  r.ws.reply(Op.BIND, BIND_OK)
  await p
  return r
}

/** 그 서버의 연결 — 진짜 연결 상태기 · 가짜 PeerLink(입장 응답이 이것을 고른다 — LinkCore.adopt) */
function linkOf(r: Rig, sc: ServerConfig): LinkCore {
  const have = r.core.links.get(sc.sfu_id)
  if (have?.peer) return have
  const peer = fakePeer()
  r.peers.set(sc.sfu_id, peer)
  if (have) { have.peer = peer as never; have.sc = sc; return have }
  const Link = LinkCore as unknown as new (core: Core, sc: ServerConfig, peer: unknown) => LinkCore
  const link = new Link(r.core, sc, peer)
  r.core.links.set(sc.sfu_id, link)
  return link
}

/** 그 서버의 협상을 끝까지 — 연달아 걸린 재협상까지 */
async function drain(r: Rig, sc: ServerConfig = SA): Promise<void> {
  for (let i = 0; i < 6; i++) { r.peers.get(sc.sfu_id)?.settle(); await tick() }
}

interface JB { sc?: ServerConfig; me?: Permission; meSelect?: boolean; hidden?: boolean; others?: MemberInfo[]; pub?: string | null; subs?: string[]; epoch?: string; seq?: number; tracks?: TrackEntry[] }

const mem = (user_id: string, permission?: Permission, o: { select?: boolean; type?: 0 | 1 | 2 } = {}): MemberInfo => ({ user_id, select: o.select ?? false, participant_type: o.type ?? 0, ...(permission ? { permission } : {}) })

/** 입장 응답 — sub_rooms 는 그 서버에 이미 들어간 방 + 이 방(서버가 보는 그대로) */
function joinBody(r: Rig, id: string, o: JB = {}): RoomJoinRes {
  const sc = o.sc ?? SA
  const subs = o.subs ?? [...new Set([...[...r.core.rooms.values()].filter((x) => x.sfuId === sc.sfu_id && x.st.rs === 'JOINED').map((x) => x.id), id])]
  const me = mem('u1', o.me, { select: o.meSelect ?? false })
  return {
    room_id: id, participants: [...(o.hidden ? [] : [me]), ...(o.others ?? [])], me, affiliation: { sub_rooms: subs, pub_room: o.pub ?? null },
    server_config: sc, tracks: o.tracks ?? [], version: { epoch: o.epoch ?? 'e1', seq: o.seq ?? 1 }, media_codecs: { audio: 'opus', video: 'H264' },
    mline_table: { sfu_id: sc.sfu_id, arev: 1, mlines: [] },
  }
}

const joinFrame = (ws: FakeWS, id: string): Frame => ws.requests(Op.ROOM_JOIN).filter((f) => (f.body as { room_id: string }).room_id === id).at(-1)!
const leaveFrame = (ws: FakeWS, id: string): Frame => ws.requests(Op.ROOM_LEAVE).filter((f) => (f.body as { room_id: string }).room_id === id).at(-1)!
const FAIL = (code: number, name: string, details?: Record<string, unknown>): unknown => ({ code, name, permanent: false, ...(details ? { details } : {}) })

/** client.join() 하나를 끝까지 — 입장 응답 · 첫 협상 */
async function enter(r: Rig, id: string, o: JB & { mode?: 'listen' | 'talk' } = {}): Promise<Room> {
  const sc = o.sc ?? SA
  const p = r.c.join(id, o.mode ? { mode: o.mode } : {})
  await tick()
  linkOf(r, sc)
  r.ws.answer(joinFrame(r.ws, id), joinBody(r, id, o))
  await tick()
  await drain(r, sc)
  return p
}

const vers = (seq: number, epoch = 'e1'): { epoch: string; seq: number } => ({ epoch, seq })
async function note(r: Rig, op: number, body: unknown): Promise<void> { r.ws.notify(op, body); await tick() }

/** 재동기 · 미리보기 · 목록의 HTTP — 시험이 응답을 쥔다 */
function httpMock(h: (url: string) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }): { calls: { url: string; headers: Record<string, string> }[]; restore(): void } {
  const g = globalThis as unknown as { fetch: unknown }
  const saved = g.fetch
  const calls: { url: string; headers: Record<string, string> }[] = []
  g.fetch = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers })
    const x = await h(url)
    return { status: x.status, text: async () => JSON.stringify(x.body) }
  }
  return { calls, restore: () => { g.fetch = saved } }
}

function getRoom(id: string, seq: number, others: MemberInfo[] = [], epoch = 'e1'): GetRoomRes {
  return { room_id: id, name: id, capacity: 10, user_count: others.length + 1, participants: [mem('u1'), ...others], me: mem('u1'), created_at: 0, media_codecs: {}, version: vers(seq, epoch), tracks: [] }
}

test('SD-ENTRY-ROOM-JOIN — client.join() 은 연결이 active 가 된 뒤 ENTRY.join 하나 · 위가 ROOM_JOIN 을 낸다', async () => {
  const spy = spyEntry()
  try {
    FakeWS.made.length = 0
    const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc' })
    const p = c.connect()
    await tick(); const ws = FakeWS.made[0]!; ws.open(); await tick()
    const j = c.join('r1').catch(() => undefined)
    await tick()
    assert.equal(spy.n('join'), 0, 'SD-ENTRY-ROOM-JOIN — 연결 up 전에는 넣지 않는다(기다린다)')
    assert.equal(ws.requests(Op.ROOM_JOIN).length, 0, 'SD-ENTRY-ROOM-JOIN — up 전 ROOM_JOIN 0')
    ws.reply(Op.BIND, BIND_OK); await p; await tick()
    assert.equal(spy.n('join'), 1, 'SD-ENTRY-ROOM-JOIN — up 뒤 결합 ENTRY.join 하나')
    assert.equal(ws.requests(Op.ROOM_JOIN).length, 1, 'SD-ENTRY-ROOM-JOIN — 위가 낸 ROOM_JOIN 하나')
    assert.equal(RB.ENTRY_ALL.join, true)
    await c.close(); await j
  } finally { spy.restore() }
})

test('SD-ENTRY-ROOM-JOIN-RES · SD-EFFECT-ROOM-APP-JOINED — 입장 응답 하나에 ENTRY.joinRes 하나(pcm = session.pcMode) · joined 1 · join() 은 첫 협상 뒤 resolve · state joined', async () => {
  const spy = spyEntry()
  try {
    const r = await up()
    assert.equal(RB.effect('app.joined').event, 'joined', 'SD-EFFECT-ROOM-APP-JOINED — 효과 표: app.joined → joined')
    const p = r.c.join('r1')
    let resolved = false
    void p.then(() => { resolved = true })
    await tick()
    const room = r.core.rooms.get('r1')!
    const seen: string[] = []
    room.events.on('joined', () => seen.push('joined'))
    linkOf(r, SA)
    r.ws.answer(joinFrame(r.ws, 'r1'), joinBody(r, 'r1'))
    await tick()
    assert.equal(spy.n('joinRes'), 1, 'SD-ENTRY-ROOM-JOIN-RES — 입장 응답 하나에 ENTRY.joinRes 하나')
    const [m, pcm] = spy.calls['joinRes']![0]! as [{ part: string; server_config: { pc_mode: string } }, string]
    assert.deepEqual([m.part, m.server_config.pc_mode, pcm], ['res', '2pc', r.c.session.pcMode], 'SD-ENTRY-ROOM-JOIN-RES — 읽는 값 pcm = session.pcMode')
    assert.deepEqual(seen, ['joined'], 'SD-EFFECT-ROOM-APP-JOINED — joined 1')
    assert.equal(room.state, 'joined', 'SD-EFFECT-ROOM-APP-JOINED — state joined')
    assert.equal(resolved, false, 'SD-EFFECT-ROOM-APP-JOINED — 첫 협상이 끝나기 전에는 resolve 하지 않는다')
    await drain(r)
    const h = await p
    assert.equal(resolved, true, 'SD-EFFECT-ROOM-APP-JOINED — 첫 협상 뒤 join() resolve')
    assert.equal(h.state, 'joined', 'SD-EFFECT-ROOM-APP-JOINED — 핸들 state joined')

    // 연결 모드가 다른 응답 — 같은 입구 하나 · 위가 갈라 협상 실패로
    const q = r.c.join('r2').catch((e: unknown) => e)
    await tick()
    r.ws.answer(joinFrame(r.ws, 'r2'), joinBody(r, 'r2', { sc: { ...SB, pc_mode: '1pc' } }))
    await tick()
    assert.equal(spy.n('joinRes'), 2, 'SD-ENTRY-ROOM-JOIN-RES — 연결 모드가 달라도 ENTRY.joinRes 하나')
    assert.equal(spy.calls['joinRes']![1]![1], r.c.session.pcMode, 'SD-ENTRY-ROOM-JOIN-RES — pcm = session.pcMode')
    const e = await q
    assert.ok(e instanceof OxLensError && e.category === 'negotiation', 'SD-ENTRY-ROOM-JOIN-RES — 모드가 다르면 negotiation 으로 reject')
    assert.equal(leaveFrame(r.ws, 'r2') !== undefined, true, '모드가 다르면 들어간 채로 나간다(ROOM_LEAVE)')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-ROOM-RETRY-DUE — 4009 는 retry_after_ms 하한이 지나야 ENTRY.retryDue 하나 · 하한 전 0 · 그동안 join() 은 pending', async () => {
  const spy = spyEntry()
  try {
    const r = await up()
    let settled = false
    const p = r.c.join('r1').then(() => { settled = true }, () => { settled = true })
    await tick()
    r.ws.answer(joinFrame(r.ws, 'r1'), FAIL(4009, 'OVERLOADED', { retry_after_ms: 60 }), false)
    await tick(20)
    assert.equal(spy.n('retryDue'), 0, 'SD-ENTRY-ROOM-RETRY-DUE — 하한 전 0')
    assert.equal(r.ws.requests(Op.ROOM_JOIN).length, 1)
    assert.equal(settled, false, '4009 는 reject 가 아니다 — pending')
    await tick(80)
    assert.equal(spy.n('retryDue'), 1, 'SD-ENTRY-ROOM-RETRY-DUE — 하한이 지나자 ENTRY.retryDue 하나')
    assert.equal(r.ws.requests(Op.ROOM_JOIN).length, 2, 'SD-ENTRY-ROOM-RETRY-DUE — 위가 다시 낸 ROOM_JOIN')
    await r.c.close(); await p
  } finally { spy.restore() }
})

test('SD-ENTRY-ROOM-LEAVE · SD-ENTRY-ROOM-LEAVE-RES · SD-EFFECT-ROOM-APP-LEFT — room.leave() 는 셋 상태 모두 ENTRY.leave 하나 · 퇴장 응답은 ENTRY.leaveRes 하나 · left 1 · leave() resolve · closed · rooms 에서 빠짐', async () => {
  const spy = spyEntry()
  try {
    const r = await up()
    assert.equal(RB.effect('app.left').event, 'left', 'SD-EFFECT-ROOM-APP-LEFT — 효과 표: app.left → left')
    // ① 들어가 있음
    const h1 = await enter(r, 'r1')
    let left = 0
    h1.on('left', () => { left += 1 })
    let done1 = false
    const l1 = h1.leave().then(() => { done1 = true })
    await tick()
    assert.equal(spy.n('leave'), 1, 'SD-ENTRY-ROOM-LEAVE — 들어가 있는 방: ENTRY.leave 하나')
    assert.equal(h1.state, 'leaving')
    assert.equal(spy.n('leaveRes'), 0)
    r.ws.answer(leaveFrame(r.ws, 'r1'), {})
    await l1
    assert.equal(spy.n('leaveRes'), 1, 'SD-ENTRY-ROOM-LEAVE-RES — 퇴장 응답 하나에 ENTRY.leaveRes 하나')
    assert.deepEqual([done1, left, h1.state, r.c.rooms.has('r1')], [true, 1, 'closed', false], 'SD-EFFECT-ROOM-APP-LEFT — leave() resolve · left 1 · closed · client.rooms 에서 빠짐')

    // ② 입장 응답 대기 — 응답 뒤 나간다
    const j2 = r.c.join('r2').catch(() => undefined)
    await tick()
    const room2 = r.core.rooms.get('r2')!
    const l2 = room2.leave()
    await tick()
    assert.equal(spy.n('leave'), 2, 'SD-ENTRY-ROOM-LEAVE — 입장 응답 대기: ENTRY.leave 하나')
    assert.equal(r.ws.requests(Op.ROOM_LEAVE).filter((f) => (f.body as { room_id: string }).room_id === 'r2').length, 0, '응답 전에는 ROOM_LEAVE 0')
    linkOf(r, SA)
    r.ws.answer(joinFrame(r.ws, 'r2'), joinBody(r, 'r2'))
    await tick()
    assert.ok(leaveFrame(r.ws, 'r2'), '입장 응답 뒤 ROOM_LEAVE(ROOM.C.JOINING.join_ok_quit)')
    r.ws.answer(leaveFrame(r.ws, 'r2'), { code: 3001, name: 'NOT_IN_ROOM', permanent: false }, false)
    await l2; await j2
    assert.equal(spy.n('leaveRes'), 2, 'SD-ENTRY-ROOM-LEAVE-RES — 실패 응답도 ENTRY.leaveRes 하나')
    assert.equal(room2.state, 'closed')

    // ③ 과부하 대기 — 대기를 멈추고 바로 닫힌다
    const j3 = r.c.join('r3').catch((e: unknown) => e)
    await tick()
    r.ws.answer(joinFrame(r.ws, 'r3'), FAIL(4009, 'OVERLOADED', { retry_after_ms: 5000 }), false)
    await tick()
    const room3 = r.core.rooms.get('r3')!
    await room3.leave()
    assert.equal(spy.n('leave'), 3, 'SD-ENTRY-ROOM-LEAVE — 과부하 대기: ENTRY.leave 하나')
    assert.deepEqual([room3.state, r.c.rooms.has('r3')], ['closed', false], 'SD-EFFECT-ROOM-APP-LEFT — 과부하 대기 중 leave 도 closed · 빠짐')
    assert.ok((await j3) instanceof OxLensError, '기다리던 join() 은 reject')
    await tick(10)
    assert.equal(spy.n('retryDue'), 0, '멈춘 대기는 하한이 와도 넣지 않는다')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-ROOM-DELTA — 방 통지 넷과 version 없는 내 권한 통지는 ENTRY.delta 하나씩 · bare 는 version 없는 PARTICIPANT_STATE 만 · 명단 반영은 store.apply 한 곳(낡은 통지 0)', async () => {
  const spy = spyEntry()
  try {
    const r = await up()
    const h = await enter(r, 'r1', { seq: 1 })
    const room = r.core.rooms.get('r1')!
    const applied: string[] = []
    const apply = room.store.apply.bind(room.store)
    room.store.apply = (op, body, me) => { applied.push(op); return apply(op, body, me) }
    await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r1', user_id: 'u2', select: false, participant_type: 0, version: vers(2) })
    await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u2', permission: NO_AUDIO, version: vers(3) })
    await note(r, Op.TRACK_EVENT, { action: 'add', room_id: 'r1', tracks: [{ type: 'individual', room_id: 'r1', track_id: 't2', kind: 'audio', user_id: 'u2' }], version: vers(4) })
    await note(r, Op.TRACK_STATE, { room_id: 'r1', track_id: 't2', muted: true, version: vers(5) })
    await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u1', permission: NO_AUDIO })
    await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r1', user_id: 'u3', select: false, participant_type: 0, version: vers(5) })
    assert.equal(spy.n('delta'), 6, 'SD-ENTRY-ROOM-DELTA — 통지 하나에 ENTRY.delta 하나')
    assert.deepEqual(spy.calls['delta']!.map((a) => a[1]), [false, false, false, false, true, false], 'SD-ENTRY-ROOM-DELTA — bare 는 version 없는 PARTICIPANT_STATE 만')
    assert.deepEqual(applied, ['PARTICIPANT_EVENT', 'PARTICIPANT_STATE', 'TRACK_EVENT', 'TRACK_STATE', 'PARTICIPANT_STATE'], 'SD-ENTRY-ROOM-DELTA — 위가 반영하라고 한 통지만 store.apply 한 곳을 지난다 · 낡은 seq(5 ≤ 5)는 0')
    assert.deepEqual(h.participants.map((p) => p.userId), ['u1', 'u2'], 'SD-ENTRY-ROOM-DELTA — 낡은 입장 통지는 명단에 없다')
    assert.equal(room.trk.entries.get('t2')?.muted, true, 'SD-ENTRY-ROOM-DELTA — 트랙 · 트랙 상태는 이음매 trk.delta 로 트랙 목록에')
    assert.equal(room.st.cseq, 5, 'version 없는 통지는 보관 seq 를 바꾸지 않는다')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-ROOM-ROOM-EVENT · SD-EFFECT-ROOM-APP-ROOM-GONE — 방 사건 하나에 ENTRY.roomEvent 하나 · 다시 받으라면 GET_ROOM · affiliation 이면 forced 1(사유 = 받은 사건) · closed · rooms 에서 빠짐', async () => {
  const spy = spyEntry()
  const http = httpMock(() => new Promise(() => undefined))
  try {
    const r = await up()
    assert.equal(RB.effect('app.room_gone').event, 'forced', 'SD-EFFECT-ROOM-APP-ROOM-GONE — 효과 표: app.room_gone → forced')
    const h = await enter(r, 'r1')
    await note(r, Op.ROOM_EVENT, { type: 'sync_required', room_id: 'r1', reason: 'x' })
    assert.equal(spy.n('roomEvent'), 1, 'SD-ENTRY-ROOM-ROOM-EVENT — 방 사건 하나에 ENTRY.roomEvent 하나')
    assert.equal(http.calls.length, 1, 'SD-ENTRY-ROOM-ROOM-EVENT — 위가 낸 재동기(GET /rooms/r1?tracks=1)')
    assert.ok(http.calls[0]!.url.endsWith('/rooms/r1?tracks=1') && http.calls[0]!.headers['X-OxLens-Session'] === 's-1', '재동기는 세션 헤더')
    const forced: { cause: string }[] = []
    h.on('forced', (x) => forced.push(x))
    await note(r, Op.ROOM_EVENT, { type: 'affiliation', room_id: 'r1', affiliation: { sub_rooms: [], pub_room: null }, cause: 'kick' })
    assert.equal(spy.n('roomEvent'), 2, 'SD-ENTRY-ROOM-ROOM-EVENT — ENTRY.roomEvent 하나')
    assert.deepEqual(forced, [{ cause: 'kick' }], 'SD-EFFECT-ROOM-APP-ROOM-GONE — forced 1 · 사유 = 받은 방 사건')
    assert.deepEqual([h.state, r.c.rooms.has('r1')], ['closed', false], 'SD-EFFECT-ROOM-APP-ROOM-GONE — closed · client.rooms 에서 빠짐')
    await r.c.close()
  } finally { spy.restore(); http.restore() }
})

test('SD-ENTRY-ROOM-SNAPSHOT — 재동기 응답 하나에 ENTRY.snapshot 하나 · 명단을 통째로 · 여러 방이 협상 중에 받으면 다 반영한 뒤 조립은 한 번', async () => {
  const spy = spyEntry()
  const wait: Record<string, (v: { status: number; body: unknown }) => void> = {}
  const http = httpMock((url) => new Promise((res) => { wait[url.includes('/rooms/r1') ? 'r1' : 'r2'] = res }))
  try {
    const r = await up()
    const h1 = await enter(r, 'r1')
    await enter(r, 'r2')
    let resync = 0
    h1.on('resync', () => { resync += 1 })
    await note(r, Op.ROOM_EVENT, { type: 'sync_required', room_id: 'r1', reason: 'x' })
    await note(r, Op.ROOM_EVENT, { type: 'sync_required', room_id: 'r2', reason: 'x' })
    // 다른 일로 그 서버 협상이 떠 있는 동안 두 응답이 온다
    r.core.links.get('sfu-a')!.renego()
    const peer = r.peers.get('sfu-a')!
    const before = peer.assembled
    wait['r1']!({ status: 200, body: getRoom('r1', 4, [mem('u7')]) })
    wait['r2']!({ status: 200, body: getRoom('r2', 4) })
    await tick(); await tick()
    assert.equal(spy.n('snapshot'), 2, 'SD-ENTRY-ROOM-SNAPSHOT — 방마다 재동기 응답 하나에 ENTRY.snapshot 하나')
    assert.deepEqual(h1.participants.map((p) => p.userId), ['u1', 'u7'], 'SD-ENTRY-ROOM-SNAPSHOT — 받아들인 응답으로 명단을 통째로')
    assert.equal(resync, 1)
    assert.equal(peer.assembled, before, '협상이 떠 있는 동안 새 조립 0')
    await drain(r)
    assert.equal(peer.assembled, before + 1, 'SD-ENTRY-ROOM-SNAPSHOT — 두 방을 다 반영한 뒤 조립은 한 번')
    await r.c.close()
  } finally { spy.restore(); http.restore() }
})

test('SD-ENTRY-ROOM-SUB-ROOMS — 같은 서버 방의 입장 응답이 오면 이 방에 ENTRY.subRooms 하나 · listed = 그 응답의 sub_rooms 에 있다 · 빠졌으면 다시 들어간다', async () => {
  const spy = spyEntry()
  try {
    const r = await up()
    await enter(r, 'r1')
    assert.equal(spy.n('subRooms'), 0, '혼자면 0')
    await enter(r, 'r2', { subs: ['r1', 'r2'] })
    assert.deepEqual(spy.calls['subRooms'], [[true]], 'SD-ENTRY-ROOM-SUB-ROOMS — r1 이 목록에 있다: listed 참')
    const r1Joins = r.ws.requests(Op.ROOM_JOIN).filter((f) => (f.body as { room_id: string }).room_id === 'r1').length
    await enter(r, 'r3', { subs: ['r2', 'r3'] })
    assert.deepEqual(spy.calls['subRooms']!.slice(1).map((a) => a[0]).sort(), [false, true], 'SD-ENTRY-ROOM-SUB-ROOMS — 같은 서버 방마다 하나 · r1 은 빠졌다(listed 거짓)')
    assert.ok(r.labels.some((l) => l.key === 'r1' && l.label === 'ROOM.C.JOINED.not_in_sub_rooms'), 'SD-ENTRY-ROOM-SUB-ROOMS — 위가 판정')
    assert.equal(r.ws.requests(Op.ROOM_JOIN).filter((f) => (f.body as { room_id: string }).room_id === 'r1').length, r1Joins + 1, 'SD-ENTRY-ROOM-SUB-ROOMS — 빠진 방은 다시 ROOM_JOIN')
    r.ws.answer(joinFrame(r.ws, 'r1'), joinBody(r, 'r1', { subs: ['r1', 'r2', 'r3'] }))
    await tick(); await drain(r)
    assert.deepEqual(spy.calls['subRooms']!.slice(3).map((a) => a[0]), [true, true], 'SD-ENTRY-ROOM-SUB-ROOMS — 다시 들어간 r1 의 응답에 r2 · r3 은 listed 참')
    await enter(r, 'rb', { sc: SB })
    assert.equal(spy.n('subRooms'), 5, 'SD-ENTRY-ROOM-SUB-ROOMS — 다른 서버 방의 응답은 넣지 않는다')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-ROOM-DOWN-ALL · SD-ENTRY-ROOM-REJOIN — 재구축은 위 이음매(SES rooms.down_all · LINK store.drop_server)만 ENTRY.downAll 을 · 다시 들어가기(rooms.rejoin · rooms.rejoin_server)만 ENTRY.rejoin 을 넣는다 · SDK 사건으로 0', async () => {
  const spy = spyEntry()
  try {
    assert.deepEqual(ROOM.REACTS.downAll, ['SES:rooms.down_all', 'LINK:store.drop_server'], 'SD-ENTRY-ROOM-DOWN-ALL — 위가 정한 부르는 곳 둘')
    assert.deepEqual(ROOM.REACTS.rejoin, ['SES:rooms.rejoin', 'LINK:rooms.rejoin_server'], 'SD-ENTRY-ROOM-REJOIN — 위가 정한 부르는 곳 둘')
    const r = await up()
    const h1 = await enter(r, 'r1')
    await enter(r, 'rb', { sc: SB })
    await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r1', user_id: 'u2', select: false, participant_type: 0, version: vers(2) })
    const msg = h1.sendMessage('x')
    await tick(); r.ws.reply(Op.MESSAGE, { msg_id: 'm-1' }); await msg
    assert.deepEqual([spy.n('downAll'), spy.n('rejoin')], [0, 0], 'SD-ENTRY-ROOM-DOWN-ALL · SD-ENTRY-ROOM-REJOIN — 앱 · 통지 사건은 넣지 않는다(0)')
    // LINK — 그 서버 기동이 바뀌었다(epoch) → store.drop_server · rooms.rejoin_server
    await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r1', user_id: 'u3', select: false, participant_type: 0, version: vers(3, 'e2') })
    assert.equal(spy.n('downAll'), 1, 'SD-ENTRY-ROOM-DOWN-ALL — LINK store.drop_server: 그 서버 방에만 ENTRY.downAll 하나')
    assert.equal(r.core.rooms.get('rb')!.st.rs, 'JOINED', '다른 서버 방은 그대로')
    await tick(5)
    assert.equal(spy.n('rejoin'), 1, 'SD-ENTRY-ROOM-REJOIN — LINK rooms.rejoin_server: ENTRY.rejoin 하나')
    assert.equal(h1.state, 'joining', '같은 핸들이 다시 들어간다')
    linkOf(r, SA)
    r.ws.answer(joinFrame(r.ws, 'r1'), joinBody(r, 'r1', { epoch: 'e2' }))
    await tick(); await drain(r)
    assert.equal(h1.state, 'joined')
    // SES — 이어받기 실패 뒤 새 세션 → rooms.down_all · rooms.rejoin
    r.ws.close(); await tick(5)
    const ws2 = FakeWS.made.at(-1)!
    ws2.open(); await tick()
    ws2.reply(Op.BIND, { ...BIND_OK, session_id: 's-2' }); await tick(5)
    assert.equal(spy.n('downAll'), 3, 'SD-ENTRY-ROOM-DOWN-ALL — SES rooms.down_all: 방마다 ENTRY.downAll 하나')
    assert.equal(spy.n('rejoin'), 3, 'SD-ENTRY-ROOM-REJOIN — SES rooms.rejoin: 방마다 ENTRY.rejoin 하나')
    assert.ok(ws2.requests(Op.ROOM_JOIN).length >= 1, 'SD-ENTRY-ROOM-REJOIN — 위가 다시 낸 ROOM_JOIN(창 1 — 하나씩 나간다)')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-ROOM-CLOSE-ALL — 세션이 끝나면(위 이음매 rooms.close_all) 방마다 ENTRY.closeAll 하나 · ROOM_LEAVE 0 · SDK 사건으로 0', async () => {
  const spy = spyEntry()
  try {
    assert.deepEqual(ROOM.REACTS.closeAll, ['SES:rooms.close_all'], 'SD-ENTRY-ROOM-CLOSE-ALL — 위가 정한 부르는 곳 하나')
    const r = await up()
    const h1 = await enter(r, 'r1')
    await enter(r, 'r2')
    const l = h1.leave()
    await tick()
    r.ws.answer(leaveFrame(r.ws, 'r1'), {})
    await l
    assert.equal(spy.n('closeAll'), 0, 'SD-ENTRY-ROOM-CLOSE-ALL — 앱 leave 는 넣지 않는다(0)')
    await r.c.close()
    assert.equal(spy.n('closeAll'), 1, 'SD-ENTRY-ROOM-CLOSE-ALL — 남은 방마다 ENTRY.closeAll 하나')
    assert.equal(r.c.rooms.size, 0)
    assert.equal(r.ws.requests(Op.ROOM_LEAVE).filter((f) => (f.body as { room_id: string }).room_id === 'r2').length, 0, 'SD-ENTRY-ROOM-CLOSE-ALL — 방마다 나가지 않는다(ROOM_LEAVE 0)')
  } finally { spy.restore() }
})

test('SD-ENTRY-ROOM-RESUME-SNAP · SD-EFFECT-ROOM-APP-ROOM-GONE — 이어받기 성공은 들어간 방마다 ENTRY.resumeSnap 하나(인자 = 스냅샷의 그 방 몫) · 빠진 방은 forced{missing} · 재구축 없이 명단을 갈아 끼운다', async () => {
  const spy = spyEntry()
  try {
    const r = await up()
    const h1 = await enter(r, 'r1')
    const h2 = await enter(r, 'r2')
    const forced: { cause: string }[] = []
    h2.on('forced', (x) => forced.push(x))
    r.ws.close(); await tick(5)
    assert.equal(r.c.session.state, 'resuming')
    const ws2 = FakeWS.made.at(-1)!
    ws2.open(); await tick()
    ws2.reply(Op.BIND, BIND_OK); await tick()
    const snap: RoomSnapshot = { participants: [mem('u1'), mem('u8')], me: mem('u1', NO_AUDIO), tracks: [], version: vers(7) }
    ws2.reply(Op.RESUME, { snapshot: { r1: snap }, publications: [], mline_tables: [] })
    await tick()
    assert.equal(spy.n('resumeSnap'), 2, 'SD-ENTRY-ROOM-RESUME-SNAP — 들어간 방마다 ENTRY.resumeSnap 하나')
    const args = spy.calls['resumeSnap']!.map((a) => a.slice(0, 3))
    assert.deepEqual(args, [[true, 7, r.core.epochs.id('e1')], [false, 0, 0]], 'SD-ENTRY-ROOM-RESUME-SNAP — present · seq · epoch = 스냅샷의 그 방 몫(없으면 present 거짓)')
    assert.deepEqual(h1.participants.map((p) => p.userId), ['u1', 'u8'], 'SD-ENTRY-ROOM-RESUME-SNAP — 받아들인 스냅샷으로 명단')
    assert.equal(h1.permission.publishAudio, false, '내 권한은 스냅샷의 me')
    assert.deepEqual([forced, h2.state, r.c.rooms.has('r2')], [[{ cause: 'missing' }], 'closed', false], 'SD-EFFECT-ROOM-APP-ROOM-GONE — 스냅샷에서 빠졌다: forced{missing} · closed · 빠짐')
    assert.equal(spy.n('downAll'), 0, '이어받기는 방을 내리지 않는다')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-EFFECT-ROOM-APP-JOIN-FAILED · SD-EFFECT-ROOM-APP-BUG — 입장 실패는 joinFailed 1 · join() reject(분류 = 받은 코드) · client.rooms 에 남지 않는다 · 1xxx 는 bug', async () => {
  assert.equal(RB.effect('app.join_failed').event, 'joinFailed', 'SD-EFFECT-ROOM-APP-JOIN-FAILED — 효과 표')
  assert.equal(RB.effect('app.bug').event, 'joinFailed', 'SD-EFFECT-ROOM-APP-BUG — 효과 표')
  const r = await up()
  for (const [id, code, category, unit] of [['r1', 3001, 'state', 'SD-EFFECT-ROOM-APP-JOIN-FAILED'], ['r2', 1002, 'bug', 'SD-EFFECT-ROOM-APP-BUG']] as const) {
    const p = r.c.join(id).catch((e: unknown) => e)
    await tick()
    const failed: unknown[] = []
    r.core.rooms.get(id)!.events.on('joinFailed', (f) => failed.push(f))
    r.ws.answer(joinFrame(r.ws, id), FAIL(code, 'X'), false)
    await tick()
    const e = await p
    assert.equal(failed.length, 1, `${unit} — joinFailed 1`)
    assert.ok(e instanceof OxLensError && e.code === code && e.category === category, `${unit} — join() reject · 분류 ${category}`)
    assert.equal(r.c.rooms.has(id), false, `${unit} — client.rooms 에 남지 않는다`)
    assert.equal(r.labels.filter((l) => l.key === id).at(-1)!.label, code === 1002 ? 'ROOM.C.JOINING.join_1xxx' : 'ROOM.C.JOINING.join_fail')
  }
  await r.c.close()
})

test('SD-EFFECT-ROOM-APP-MEMBERS①②③ — app.members 는 participants 1 · 권한이 바뀌면 permission(남의 것 mine 거짓 · 내 것 참) · 투명 참가자의 version 없는 내 권한 통지는 본인 mine:true 만(명단에 항목 0)', async () => {
  assert.equal(RB.effect('app.members').event, 'participants', 'SD-EFFECT-ROOM-APP-MEMBERS — 효과 표')
  const r = await up()
  const h = await enter(r, 'r1', { others: [mem('u2', ALL)] })
  const parts: string[][] = []
  const perms: { userId: string; mine: boolean }[] = []
  h.on('participants', (p) => parts.push(p.map((x) => x.userId)))
  h.on('permission', (c) => perms.push({ userId: c.userId, mine: c.mine }))
  await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r1', user_id: 'u3', select: false, participant_type: 0, version: vers(2) })
  assert.deepEqual([parts.length, perms.length], [1, 0], 'SD-EFFECT-ROOM-APP-MEMBERS — 입장 통지: participants 1 · permission 0')
  await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u2', permission: NO_AUDIO, version: vers(3) })
  assert.deepEqual(perms, [{ userId: 'u2', mine: false }], 'SD-EFFECT-ROOM-APP-MEMBERS① — 남의 권한 변경도 방 전원에게 permission')
  await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u1', permission: NO_AUDIO, version: vers(4) })
  assert.deepEqual(perms.at(-1), { userId: 'u1', mine: true }, 'SD-EFFECT-ROOM-APP-MEMBERS② — 내 것이면 mine 참 · 남의 것과 갈린다')
  assert.equal(parts.length, 3, 'SD-EFFECT-ROOM-APP-MEMBERS — 통지마다 participants 1')
  // 투명 참가자로 들어간 방 — 명단에 내가 없다 · 내 권한 통지는 version 없이 나에게만 온다
  const hh = await enter(r, 'r9', { hidden: true, others: [mem('u2', ALL)], sc: SB })
  const room9 = r.core.rooms.get('r9')!
  const seq = room9.st.cseq
  const hp: { userId: string; mine: boolean }[] = []
  hh.on('permission', (c) => hp.push({ userId: c.userId, mine: c.mine }))
  await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r9', user_id: 'u1', permission: NO_AUDIO })
  assert.deepEqual(hp, [{ userId: 'u1', mine: true }], 'SD-EFFECT-ROOM-APP-MEMBERS③ — version 없는 내 권한 통지: 견주지 않고 반영 · mine:true 하나')
  assert.deepEqual([hh.permission.publishAudio, room9.st.cseq], [false, seq], 'SD-EFFECT-ROOM-APP-MEMBERS③ — room.permission 을 맞춘다 · 보관 seq 그대로')
  assert.equal(hh.participants.filter((p) => p.userId === 'u1').length, 0, 'SD-EFFECT-ROOM-APP-MEMBERS③ — 투명 참가자 항목은 명단에 0(남에게 보이는 표면 0)')
  await r.c.close()
})

test('SD-EFFECT-ROOM-HTTP-ABANDON — 떠 있는 재동기를 위가 버리면(http.abandon) 늦게 온 응답은 반영 0', async () => {
  assert.equal(RB.effect('http.abandon').action, 'resync.abandon', 'SD-EFFECT-ROOM-HTTP-ABANDON — 효과 표')
  const spy = spyEntry()
  let late: ((v: { status: number; body: unknown }) => void) | null = null
  const http = httpMock(() => new Promise((res) => { late = res }))
  try {
    const r = await up()
    const h = await enter(r, 'r1')
    let resync = 0
    h.on('resync', () => { resync += 1 })
    await note(r, Op.ROOM_EVENT, { type: 'sync_required', room_id: 'r1', reason: 'x' })
    assert.equal(http.calls.length, 1)
    const l = h.leave()
    await tick()
    assert.ok(r.labels.some((x) => x.label === 'ROOM.C.JOINED.leave'))
    late!({ status: 200, body: getRoom('r1', 9, [mem('u9')]) })
    await tick(); await tick()
    assert.deepEqual([spy.n('snapshot'), resync, h.participants.some((p) => p.userId === 'u9')], [0, 0, false], 'SD-EFFECT-ROOM-HTTP-ABANDON — 늦게 온 재동기 응답: 입구 0 · resync 0 · 명단 그대로')
    r.ws.answer(leaveFrame(r.ws, 'r1'), {})
    await l
    await r.c.close()
  } finally { spy.restore(); http.restore() }
})

test('SD-EFFECT-ROOM-WS-ABANDON — 그 방에 걸린 요청을 위가 버리면(ws.abandon) 늦게 온 응답은 반영 0', async () => {
  assert.equal(RB.effect('ws.abandon').action, 'request.abandon', 'SD-EFFECT-ROOM-WS-ABANDON — 효과 표')
  const spy = spyEntry()
  try {
    const r = await up()
    const h1 = await enter(r, 'r1')
    await enter(r, 'r2')
    const l = h1.leave()
    await tick()
    const pending = leaveFrame(r.ws, 'r1')
    assert.ok(pending, 'ROOM_LEAVE 가 떠 있다')
    // 그 서버 기동이 바뀌었다 → 재구축이 그 서버 방을 내린다(나가던 방은 ROOM.C.LEAVING.down — ws.abandon)
    await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r2', user_id: 'u5', select: false, participant_type: 0, version: vers(2, 'e2') })
    assert.ok(r.labels.some((x) => x.key === 'r1' && x.label === 'ROOM.C.LEAVING.down'))
    await l
    r.ws.answer(pending, {})
    await tick()
    assert.equal(spy.n('leaveRes'), 0, 'SD-EFFECT-ROOM-WS-ABANDON — 버린 뒤 온 ROOM_LEAVE 응답: 입구 leaveRes 0')
    assert.equal(h1.state, 'closed')
    await r.c.close()
  } finally { spy.restore() }
})

/** AFFILIATION 요청에 차례로 답한다 */
async function affReply(r: Rig, body: unknown): Promise<Frame> {
  await tick()
  const f = r.ws.last(Op.AFFILIATION)
  r.ws.answer(f, body)
  await tick()
  return f
}

test('SD-API-CLIENT-JOIN — 기본은 listen(select:false) · talk 는 발언 방이 없으면 select:true · 발언 방이 다른 서버에 있으면 그 발언 방부터 내리고(pub_deselect) 옮긴다', async () => {
  const r = await up()
  const h = await enter(r, 'r1')
  assert.deepEqual([h.mode, (joinFrame(r.ws, 'r1').body as { select: boolean }).select], ['listen', false], 'SD-API-CLIENT-JOIN — 기본 listen = select:false')
  const ha = await enter(r, 'ra', { mode: 'talk', pub: 'ra', subs: ['r1', 'ra'] })
  assert.deepEqual([ha.mode, (joinFrame(r.ws, 'ra').body as { select: boolean }).select, r.c.speakingRoom?.id], ['talk', true, 'ra'], 'SD-API-CLIENT-JOIN — talk · 발언 방 없음: select:true 로 들어가 발언 방이 된다')
  const p = r.c.join('rb', { mode: 'talk' })
  await tick()
  linkOf(r, SB)
  r.ws.answer(joinFrame(r.ws, 'rb'), joinBody(r, 'rb', { sc: SB }))
  await tick(); await drain(r, SB)
  assert.equal((joinFrame(r.ws, 'rb').body as { select: boolean }).select, false, 'SD-API-CLIENT-JOIN — 발언 방이 있으면 입장이 가로채지 않는다(select:false)')
  const first = await affReply(r, { sub_rooms: ['r1', 'ra'], pub_room: null, cause: 'user' })
  assert.deepEqual(first.body, { pub_deselect: 'ra' }, 'SD-API-CLIENT-JOIN — 다른 서버 발언 방을 먼저 내린다')
  const second = await affReply(r, { sub_rooms: ['rb'], pub_room: 'rb', cause: 'user' })
  assert.deepEqual(second.body, { pub_select: 'rb' }, 'SD-API-CLIENT-JOIN — 내린 뒤 새 방을 고른다')
  const hb = await p
  assert.deepEqual([hb.mode, r.c.speakingRoom?.id], ['talk', 'rb'])
  await r.c.close()
})

test('SD-API-CLIENT-PREVIEW · SD-API-CLIENT-LIST-ROOMS — preview 는 입장 없이 HTTP 하나(Bearer · 정원 미점유) · 401 은 auth reject + tokenRequired · listRooms 는 rec 를 싣는다', async () => {
  const http = httpMock((url) => {
    if (url.endsWith('/rooms/r9')) return { status: 200, body: getRoom('r9', 3, [mem('u2', ALL, { select: true })]) }
    if (url.endsWith('/rooms/gone')) return { status: 401, body: { code: 2003, name: 'TOKEN_EXPIRED', permanent: false } }
    return { status: 200, body: { rooms: [{ room_id: 'r1', name: 'n1', capacity: 10, user_count: 2, created_at: 5, rec: true }, { room_id: 'r2', name: 'n2', capacity: 4, user_count: 0, created_at: 6, rec: false }] } }
  })
  try {
    FakeWS.made.length = 0
    const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc' })
    const tokens: unknown[] = []
    c.on('tokenRequired', (x) => tokens.push(x))
    const pv = await c.preview('r9')
    assert.deepEqual([pv.roomId, pv.capacity, pv.userCount, pv.participants.map((x) => [x.userId, x.mode]), pv.version], ['r9', 10, 2, [['u1', 'listen'], ['u2', 'talk']], vers(3)], 'SD-API-CLIENT-PREVIEW — 미리보기 값')
    assert.equal(http.calls[0]!.headers['Authorization'], 'Bearer tok', 'SD-API-CLIENT-PREVIEW — 미리보기는 Bearer')
    assert.equal(FakeWS.made.length, 0, 'SD-API-CLIENT-PREVIEW — 입장 없이(소켓 · ROOM_JOIN 0) — 정원을 차지하지 않는다')
    assert.equal(c.rooms.size, 0, 'SD-API-CLIENT-PREVIEW — 방 핸들 0')
    const e = await c.preview('gone').catch((x: unknown) => x)
    assert.ok(e instanceof OxLensError && e.category === 'auth', 'SD-API-CLIENT-PREVIEW — 401 은 auth 로 reject')
    assert.deepEqual(tokens, [{ cause: 'expired' }], 'SD-API-CLIENT-PREVIEW — 401 은 tokenRequired{expired}')
    const r = await up()
    const list = await r.c.listRooms()
    assert.deepEqual(list.map((x) => [x.roomId, x.rec]), [['r1', true], ['r2', false]], 'SD-API-CLIENT-LIST-ROOMS — GET /rooms 의 rec 를 싣는다')
    assert.ok(http.calls.at(-1)!.url.endsWith('/rooms'), 'SD-API-CLIENT-LIST-ROOMS — GET /rooms')
    await r.c.close()
  } finally { http.restore() }
})

test('SD-API-ROOM-LEAVE — 발언 방을 나가면 위 이음매가 발언 방(pub_room) · 발언권을 정리한다 · 다른 서버 방은 그대로', async () => {
  const r = await up()
  const ha = await enter(r, 'ra', { mode: 'talk', pub: 'ra' })
  const hb = await enter(r, 'rb', { sc: SB })
  assert.equal(r.c.speakingRoom?.id, 'ra')
  const room = r.core.rooms.get('ra')!
  const l = ha.leave()
  await tick()
  assert.equal(r.c.speakingRoom, null, 'SD-API-ROOM-LEAVE — 발언 방 정리(aff.leave)')
  assert.equal(room.floor.st.left, true, 'SD-API-ROOM-LEAVE — 발언권 정리(floor.leave)')
  r.ws.answer(leaveFrame(r.ws, 'ra'), {})
  await l
  assert.deepEqual([ha.state, hb.state], ['closed', 'joined'], 'SD-API-ROOM-LEAVE — 그 방만(다른 서버 방 그대로)')
  await r.c.close()
})

test('SD-API-ROOM-SEND-MESSAGE — 방 문자는 MESSAGE 왕복 하나 · msgId 로 resolve', async () => {
  const r = await up()
  const h = await enter(r, 'r1')
  const p = h.sendMessage('hello')
  await tick()
  assert.deepEqual(r.ws.last(Op.MESSAGE).body, { room_id: 'r1', content: 'hello' })
  r.ws.reply(Op.MESSAGE, { msg_id: 'm-7' })
  assert.deepEqual(await p, { msgId: 'm-7' }, 'SD-API-ROOM-SEND-MESSAGE — 왕복 뒤 msgId')
  await r.c.close()
})

test('SD-API-ROOM-PARTICIPANTS — participants 의 mode 는 그 사람의 입장 시점 select 그대로(권한이 바뀌어도 고정 · 자격이 아니다) · participantType 은 u8 순서', async () => {
  const r = await up()
  const h = await enter(r, 'r1', { others: [mem('u2', ALL, { select: true }), mem('u3', { ...ALL, floor_request: false }), mem('u4', undefined, { type: 2 })] })
  const modes = (): string[][] => h.participants.map((p) => [p.userId, p.mode, p.participantType])
  const before = modes()
  assert.deepEqual(before, [['u1', 'listen', 'user'], ['u2', 'talk', 'user'], ['u3', 'listen', 'user'], ['u4', 'listen', 'bot']], 'SD-API-ROOM-PARTICIPANTS — mode = 입장 시점 select · participantType = wire u8 순서')
  await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u3', permission: ALL, version: vers(2) })
  await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u2', permission: { ...ALL, floor_request: false }, version: vers(3) })
  assert.deepEqual(modes(), before, 'SD-API-ROOM-PARTICIPANTS — 발언 자격(권한)이 바뀌어도 mode 고정')
  await r.c.close()
})

test('SD-API-ROOM-MODE — room.mode 는 입장 시점 값으로 고정 · room.state 는 joining → joined → leaving → closed 넷', async () => {
  const r = await up()
  const p = r.c.join('r1')
  await tick()
  const room = r.core.rooms.get('r1')!
  const states: string[] = [room.state]
  room.events.on('state', (s) => states.push(s))
  linkOf(r, SA)
  r.ws.answer(joinFrame(r.ws, 'r1'), joinBody(r, 'r1'))
  await tick(); await drain(r)
  const h = await p
  const ht = await enter(r, 'rt', { mode: 'talk', pub: 'rt' })
  const d = r.c.setSpeakingRoom(null)
  await affReply(r, { sub_rooms: ['r1', 'rt'], pub_room: null, cause: 'user' })
  await d
  assert.deepEqual([h.mode, ht.mode, r.c.speakingRoom], ['listen', 'talk', null], 'SD-API-ROOM-MODE — 발언 방이 바뀌어도 mode 고정')
  const l = h.leave()
  await tick()
  r.ws.answer(leaveFrame(r.ws, 'r1'), {})
  await l
  assert.deepEqual(states, ['joining', 'joined', 'leaving', 'closed'], 'SD-API-ROOM-MODE — 전이 넷(같은 값 되풀이 0)')
  assert.equal(h.mode, 'listen', 'SD-API-ROOM-MODE — 닫혀도 mode 그대로')
  await r.c.close()
})

/** 장치 트랙 자리 — ended 를 쏠 수 있다 */
function fakeTrack(kind: 'audio' | 'video'): MediaStreamTrack & { fire(ev: string): void } {
  const ls = new Map<string, (() => void)[]>()
  const t = {
    kind, id: `ft-${Math.random()}`, enabled: true, readyState: 'live', muted: false,
    addEventListener: (ev: string, f: () => void) => { ls.set(ev, [...(ls.get(ev) ?? []), f]) },
    removeEventListener: () => undefined, stop: () => { t.readyState = 'ended' }, getSettings: () => ({}), applyConstraints: () => Promise.resolve(),
    fire: (ev: string) => { for (const f of ls.get(ev) ?? []) f() },
  }
  return t as unknown as MediaStreamTrack & { fire(ev: string): void }
}

test('SD-API-ROOM-SERVER — room.server = 그 방 입장 응답의 server_config.sfu_id · 방 둘 서버 둘이면 다르다 · 그 방으로 발행한 track.server 와 같은 값', async () => {
  const r = await up()
  const ha = await enter(r, 'ra', { mode: 'talk', pub: 'ra' })
  const hb = await enter(r, 'rb', { sc: SB })
  assert.deepEqual([ha.server, hb.server], ['sfu-a', 'sfu-b'], 'SD-API-ROOM-SERVER — room.server = sfu_id')
  const t = new LocalCore(r.core, 'audio', 'external', fakeTrack('audio'), 'external', {})
  void t.publish(r.core.rooms.get('ra')!, 'full').catch(() => undefined)
  await tick()
  assert.equal(localOf(t).server, ha.server, 'SD-API-ROOM-SERVER — track.server 와 같은 값 공간')
  assert.equal(r.core.links.get(ha.server!)?.server, ha.server, 'PeerLink 를 고르는 축')
  await r.c.close()
})

test('SD-API-ROOM-LINK — 같은 서버 방의 room.link 는 그 PeerLink 의 값 하나 · 쓰기 API 0 · Room.rebuilding = room.link===\'rebuilding\'', async () => {
  const r = await up()
  const h1 = await enter(r, 'r1')
  const h2 = await enter(r, 'r2')
  const h3 = await enter(r, 'r3', { sc: SB })
  const la = r.core.links.get('sfu-a')!
  const lb = r.core.links.get('sfu-b')!
  for (const k of ['link', 'rebuilding'] as const) assert.equal(Object.getOwnPropertyDescriptor(Room.prototype, k)?.set, undefined, `SD-API-ROOM-LINK — ${k} 쓰기 API 0`)
  assert.deepEqual([h1.link, h2.link, h3.link], [la.state, la.state, lb.state], 'SD-API-ROOM-LINK — 그 서버 PeerLink 에서 읽는다')
  assert.deepEqual([h1.rebuilding, h3.rebuilding], [h1.link === 'rebuilding', h3.link === 'rebuilding'], 'SD-API-ROOM-LINK — 평시 rebuilding = (link===rebuilding)')
  await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r1', user_id: 'u5', select: false, participant_type: 0, version: vers(2, 'e2') })
  assert.deepEqual([h1.link, h2.link, h3.link === 'rebuilding'], ['rebuilding', 'rebuilding', false], 'SD-API-ROOM-LINK — 같은 서버 방은 같은 값 · 다른 서버는 따로')
  assert.deepEqual([h1.rebuilding, h2.rebuilding, h3.rebuilding], [true, true, false], 'SD-API-ROOM-LINK — Room.rebuilding = room.link===rebuilding')
  await r.c.close()
})

test('SD-API-ROOM-PERMISSION①②③ · SD-API-ROOM-PARTICIPANTS-PERMISSION①② · SD-API-ROOM-ON-PERMISSION①② — 내 비트(씨앗 = me · 통지로 갱신 · 방마다 · 재입장해도 me 가 다시 준다) · 남의 비트도 명단에 · permission 이벤트의 mine', async () => {
  const r = await up()
  const h1 = await enter(r, 'r1', { me: NO_AUDIO, others: [mem('u2', ALL)] })
  const h2 = await enter(r, 'r2')
  assert.deepEqual(h1.permission, { publishAudio: false, publishVideo: true, publishScreen: true, floorRequest: true }, 'SD-API-ROOM-PERMISSION① — 넷 · 씨앗은 입장 응답의 me')
  assert.deepEqual(h2.permission, { publishAudio: true, publishVideo: true, publishScreen: true, floorRequest: true }, 'SD-API-ROOM-PERMISSION① — me 에 permission 이 없으면 넷 다 true')
  assert.notDeepEqual(h1.permission, h2.permission, 'SD-API-ROOM-PERMISSION② — 같은 사람이라도 방마다 다르다')
  const ev: { userId: string; mine: boolean; audio: boolean }[] = []
  h1.on('permission', (c) => ev.push({ userId: c.userId, mine: c.mine, audio: c.permission.publishAudio }))
  await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u2', permission: NO_AUDIO, version: vers(2) })
  assert.equal(h1.participants.find((p) => p.userId === 'u2')!.permission!.publishAudio, false, 'SD-API-ROOM-PARTICIPANTS-PERMISSION① — 남의 비트가 participants[].permission 에')
  await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u1', permission: ALL, version: vers(3) })
  assert.equal(h1.permission.publishAudio, true, 'SD-API-ROOM-PERMISSION① — 권한 통지가 갱신한다')
  assert.deepEqual(h1.participants.map((p) => [p.userId, p.permission!.publishAudio]), [['u1', true], ['u2', false]], 'SD-API-ROOM-PARTICIPANTS-PERMISSION② — 본인 것만 들지 않는다(둘 다 각자 값)')
  assert.deepEqual(ev, [{ userId: 'u2', mine: false, audio: false }, { userId: 'u1', mine: true, audio: true }], 'SD-API-ROOM-ON-PERMISSION①② — 바뀔 때마다 permission · mine 이 갈린다')
  // 나갔다 다시 들어가도 서버가 기억한 비트를 me 로 다시 준다
  const l = h1.leave(); await tick(); r.ws.answer(leaveFrame(r.ws, 'r1'), {}); await l
  const again = await enter(r, 'r1', { me: NO_AUDIO })
  assert.equal(again.permission.publishAudio, false, 'SD-API-ROOM-PERMISSION③ — 재입장해도 비트가 살아 있다(me 가 다시 싣는다 · 기본값으로 되돌리지 않는다)')
  await r.c.close()
})

test('K-sym-RULE-ROOM-PERMISSION-BITS-2 — 지령대가 「누가 말할 수 있나」를 그린다: 명단 전원에 비트 값이 있다(안 실린 사람도 넷 다 true) · 빈 값 0', async () => {
  const r = await up()
  const h = await enter(r, 'r1', { others: [mem('u2', { ...ALL, floor_request: false }), mem('u3')] })
  await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r1', user_id: 'u4', select: false, participant_type: 0, version: vers(2) })
  await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u3', permission: NO_AUDIO, version: vers(3) })
  const canTalk = h.participants.map((p) => [p.userId, p.permission?.floorRequest])
  assert.equal(h.participants.filter((p) => p.permission === undefined).length, 0, 'K-sym-RULE-ROOM-PERMISSION-BITS-2 — 비트가 없는 참가자 0')
  assert.deepEqual(canTalk, [['u1', true], ['u2', false], ['u3', true], ['u4', true]], 'K-sym-RULE-ROOM-PERMISSION-BITS-2 — 전원의 발언 비트를 그린다')
  await r.c.close()
})

test('K-sym-RULE-ROOM-PERMISSION-BITS-3①② — 내려간 비트의 발행 API 는 왕복 없이 state(STATE_NO_PERMISSION · details.denied) 로 reject · PUBLISH_TRACKS 0(2006 받을 일 0)', async () => {
  const r = await up()
  const h = await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
  await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u1', permission: { ...ALL, publish_audio: false, publish_screen: false, publish_video: false }, version: vers(2) })
  assert.equal(h.permission.publishAudio, false)
  const cases = [['enableMicrophone', 'publish_audio'], ['enableCamera', 'publish_video'], ['enableScreen', 'publish_screen']] as const
  for (const [api, bit] of cases) {
    const e = await r.c.media[api]().catch((x: unknown) => x)
    assert.ok(e instanceof OxLensError && e.category === 'state' && e.name === 'STATE_NO_PERMISSION' && JSON.stringify(e.details?.['denied']) === JSON.stringify([bit]), `K-sym-RULE-ROOM-PERMISSION-BITS-3① — ${api}: state 분류 reject · denied ${bit}`)
  }
  const ev = await h.ptt.enableVideo().catch((x: unknown) => x)
  assert.ok(ev instanceof OxLensError && ev.name === 'STATE_NO_PERMISSION', 'K-sym-RULE-ROOM-PERMISSION-BITS-3① — ptt.enableVideo 도 부르기 전에 막는다')
  assert.equal(r.ws.requests(Op.PUBLISH_TRACKS).length, 0, 'K-sym-RULE-ROOM-PERMISSION-BITS-3② — 왕복 0 · 서버 2006 받을 일 0')
  await r.c.close()
})

test('K-sym-RULE-ROOM-PERMISSION-BITS-1①② — 비트를 내린 뒤 장치 복구 · 전면 재구축이 일어나도 자동 재발행 0(PUBLISH_TRACKS add 0) · 앱이 명시로 부르면 state reject', async () => {
  const g = globalThis as unknown as { navigator?: unknown }
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let acquired = 0
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'mic-1', label: 'mic', groupId: 'g' }],
    getUserMedia: async () => { acquired++; const t = fakeTrack('audio'); return { getAudioTracks: () => [t], getVideoTracks: () => [], getTracks: () => [t] } },
    addEventListener: () => undefined, removeEventListener: () => undefined,
  } } })
  try {
    const r = await up()
    await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
    const room = r.core.rooms.get('r1')!
    const t = new LocalCore(r.core, 'audio', 'microphone', fakeTrack('audio'), 'sdk', {})
    void t.publish(room, 'full').catch(() => undefined)
    await tick()
    await note(r, Op.PARTICIPANT_STATE, { type: 'permission', room_id: 'r1', user_id: 'u1', permission: NO_AUDIO, version: vers(2) })
    const adds = (): number => FakeWS.made.reduce((n, ws) => n + ws.requests(Op.PUBLISH_TRACKS).filter((f) => (f.body as { action?: string }).action === 'add').length, 0)
    const base = adds()
    const pub: string[] = []
    r.c.diagnostics.on('transition', (x) => { if (x.layer === 'PUB') pub.push(`${x.label}|${x.cause}`) })
    // 장치 복구 — 이미 보내던 마이크(발행 단을 세운 자리)의 장치 트랙이 끝났다
    const dev2 = fakeTrack('audio')
    const t2 = new LocalCore(r.core, 'audio', 'microphone', dev2, 'sdk', {})
    t2.roomId = 'r1'; t2.sfuId = 'sfu-a'; t2.st = { ...t2.st, ps: 'SENDING', want: true }
    r.core.media.register(t2)
    dev2.fire('ended'); await tick(5)
    assert.equal(adds(), base, 'K-sym-RULE-ROOM-PERMISSION-BITS-1① — 장치 복구: 자동 재발행 0')
    // 전면 재구축 — 이어받기 실패 뒤 새 세션(pub.reregister_all)
    r.ws.close(); await tick(5)
    const ws2 = FakeWS.made.at(-1)!
    ws2.open(); await tick()
    ws2.reply(Op.BIND, { ...BIND_OK, session_id: 's-2' }); await tick(5)
    assert.equal(adds(), base, 'K-sym-RULE-ROOM-PERMISSION-BITS-1① — 전면 재구축: 자동 재발행 0(2006 왕복 0)')
    assert.notEqual(t.state, 'staged', 'K-sym-RULE-ROOM-PERMISSION-BITS-1① — 막힌 비트의 트랙은 다시 싣지 않는다')
    assert.ok(pub.some((x) => x.endsWith('.off|permission')) && !pub.some((x) => x.startsWith('PUB.C.any.reregister|')), `K-sym-RULE-ROOM-PERMISSION-BITS-1① — 재발행 대신 비트가 끈다: ${pub.join(' · ')}`)
    assert.ok(acquired >= 1, '장치 복구는 돌았다(재획득)')
    linkOf(r, SA)
    ws2.answer(joinFrame(ws2, 'r1'), joinBody({ ...r, ws: ws2 }, 'r1', { mode: 'talk', pub: 'r1', me: NO_AUDIO } as JB))
    await tick(); await drain(r)
    const e = await r.c.media.enableMicrophone().catch((x: unknown) => x)
    assert.ok(e instanceof OxLensError && e.category === 'state' && e.name === 'STATE_NO_PERMISSION', 'K-sym-RULE-ROOM-PERMISSION-BITS-1② — 앱이 명시로 부른 것만 state reject 로 답한다')
    assert.equal(adds(), base)
    await r.c.close()
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved)
    else delete g.navigator
  }
})

test('K-sym-IMPL-ROOM-API-1 · K-sym-IMPL-ROOM-API-2 — 10채널 기본 join 은 발언 방을 정하지 않는다(null) · allSettled 로 한 방 3001 이 나머지를 막지 않는다', async () => {
  const r = await up()
  const ids = Array.from({ length: 10 }, (_, i) => `ch-${i + 1}`)
  const all = Promise.allSettled(ids.map((id) => r.c.join(id)))
  linkOf(r, SA)
  for (const id of ids) {
    for (let i = 0; i < 50 && !joinFrame(r.ws, id); i++) await tick()
    if (id === 'ch-3') r.ws.answer(joinFrame(r.ws, id), FAIL(3001, 'ROOM_NOT_FOUND'), false)
    else r.ws.answer(joinFrame(r.ws, id), joinBody(r, id))
    await tick()
  }
  await drain(r)
  const res = await all
  assert.deepEqual(res.map((x) => x.status), ids.map((id) => (id === 'ch-3' ? 'rejected' : 'fulfilled')), 'K-sym-IMPL-ROOM-API-2 — 3001 하나는 그 방만 reject · 나머지 아홉은 들어간다')
  assert.ok(ids.every((id) => (joinFrame(r.ws, id).body as { select: boolean }).select === false), '기본 listen = select:false')
  assert.equal(r.c.speakingRoom, null, 'K-sym-IMPL-ROOM-API-1 — 기본 join 열 번 뒤 발언 방 = null(마지막 입장 방이 아니다)')
  assert.equal(r.c.rooms.size, 9)
  await r.c.close()
})
