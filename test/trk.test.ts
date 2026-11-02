// author: kodeholic (powered by Claude)
// SDK:IMPL-TRK-RECEIVE · SDK:RULE-TRK-STORE — 받는 쪽 영역 1층(SUB 는 TRK 로 접힌다). 위가 지은 트랙 · 구독 상태기 둘레의 손 결합(보관본 · 핸들 · 보내는 몸통)을 잰다.
// ★입구는 위 결합(trk_binding · sub_binding)의 ENTRY 를 지나는지 · 표면은 효과 표(effect)대로 나는지를 TRK 단위(SD-ENTRY-TRK-* · SD-EFFECT-TRK-* · SD-API-* · K-sym-*)마다 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 진짜 연결 상태기에 가짜 PeerLink(줄마다 가짜 수신 트랜시버 — test/_rig).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWS, tick } from './_ws.js'
import { SA, SB, up, linkOf, drain, enter, vers, note, httpMock, getRoom, leaveFrame, joinBody, fakeTrack, type Rig, type JB, type FakeTrack } from './_rig.js'
import * as TRK from '../src/domain/gen/trk_client.js'
import * as TB from '../src/domain/gen/trk_binding.js'
import * as SUB from '../src/domain/gen/sub_client.js'
import * as UB from '../src/domain/gen/sub_binding.js'
import { Op, type TrackEntry, type MlineEntry, type ServerConfig } from '../src/internal/wire/ws.js'
import { OxLensError, RemoteTrack, type Room } from '../src/index.js'
import type { LocalCore } from '../src/domain/pub/local.js'

/** 위 결합 ENTRY 의 입구마다 불린 인자(상태 뒤) — SDK 사건이 결합 코드를 지났나를 잰다 */
function spyOn(entry: object): { calls: Record<string, unknown[][]>; n(k: string): number; restore(): void } {
  const E = entry as Record<string, (...a: unknown[]) => unknown>
  const saved = { ...E }
  const calls: Record<string, unknown[][]> = {}
  for (const k of Object.keys(saved)) {
    calls[k] = []
    E[k] = (...a: unknown[]) => { calls[k]!.push(a.slice(1)); return saved[k]!(...a) }
  }
  return { calls, n: (k) => calls[k]?.length ?? 0, restore: () => { Object.assign(E, saved) } }
}

const tr = (id: string, o: Partial<TrackEntry> = {}): TrackEntry => ({ type: 'individual', room_id: 'r1', track_id: id, kind: 'video', user_id: 'u2', ...o })
const slotOf = (room: string, kind: 'audio' | 'video'): TrackEntry => ({ type: 'slot', room_id: room, track_id: `ptt-${room}-${kind}`, kind })
const row = (mid: string, track_id: string | undefined, kind: 'audio' | 'video' = 'video', room_id = 'r1', pt?: number): MlineEntry => ({
  mid, kind, pt: pt ?? (kind === 'audio' ? 111 : 102), codec: kind === 'audio' ? 'opus' : 'H264', ssrc: 2147480000 + Number(mid), stream_id: `ox-m${mid}`,
  ...(track_id ? { track_id, room_id } : {}),
})

/** 그 서버 PeerLink 의 줄 mid 에 수신 트랜시버를 놓는다 */
function rx(r: Rig, mid: string, kind = 'video', sc: ServerConfig = SA): FakeTrack {
  linkOf(r, sc)
  const t = fakeTrack(kind)
  r.peers.get(sc.sfu_id)!.rx.set(mid, { track: t, getStats: async () => new Map() })
  return t
}

/** 표에 실린 줄마다 트랜시버를 놓고 들어간다 */
async function join(r: Rig, id: string, o: JB = {}): Promise<Room> {
  for (const m of o.mlines ?? []) if (m.track_id) rx(r, m.mid, m.kind, o.sc ?? SA)
  return enter(r, id, o)
}

async function table(r: Rig, arev: number, mlines: MlineEntry[], sc: ServerConfig = SA): Promise<void> {
  await note(r, Op.MLINE_EVENT, { table: { sfu_id: sc.sfu_id, arev, mlines } })
}

/** 레이어 응답은 서버 몫을 대신 자동으로(실패를 재는 시험만 끈다) */
FakeWS.auto.set(Op.SUBSCRIBE_LAYER, {})

const trackEvent = (action: 'add' | 'remove', tracks: TrackEntry[], seq: number, room = 'r1') => ({ action, room_id: room, tracks, version: vers(seq) })

// ══ 입구 표 — 트랙 목록(TRK) ═══════════════════════════════════════════════

test('SD-ENTRY-TRK-SNAPSHOT — 입장 · 재동기 응답의 그 방 트랙 전부가 ENTRY.snapshot 하나(위 이음매 trk.snapshot) · 내 개인 트랙은 싣지 않는다 · 통지는 넣지 않는다', async () => {
  const spy = spyOn(TB.ENTRY)
  const http = httpMock(() => ({ status: 200, body: getRoom('r1', 9, [], 'e1', [tr('t2'), tr('t9'), slotOf('r1', 'audio')]) }))
  try {
    assert.deepEqual(TRK.REACTS.snapshot, ['ROOM:trk.snapshot'], 'SD-ENTRY-TRK-SNAPSHOT — 위가 정한 부르는 곳 하나(ROOM trk.snapshot)')
    assert.equal(TB.ENTRY_ALL.snapshot, true)
    const r = await up()
    await join(r, 'r1', { tracks: [tr('t2'), tr('t1', { user_id: 'u1' }), slotOf('r1', 'audio')] })
    assert.equal(spy.n('snapshot'), 1, 'SD-ENTRY-TRK-SNAPSHOT — 입장 응답 하나에 ENTRY.snapshot 하나')
    assert.deepEqual(spy.calls['snapshot']![0]![0], { t2: 'ACTIVE', 'ptt-r1-audio': 'ACTIVE' }, 'SD-ENTRY-TRK-SNAPSHOT — 그 방 트랙 전부 · 내 개인 트랙은 받을 트랙이 아니다')
    await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t3')], 2))
    await note(r, Op.TRACK_STATE, { room_id: 'r1', track_id: 't3', muted: true, version: vers(3) })
    assert.equal(spy.n('snapshot'), 1, 'SD-ENTRY-TRK-SNAPSHOT — 통지(SDK 사건)로 넣는 곳 0')
    await note(r, Op.ROOM_EVENT, { type: 'sync_required', room_id: 'r1', reason: 'x' })
    await tick(); await tick()
    assert.equal(spy.n('snapshot'), 2, 'SD-ENTRY-TRK-SNAPSHOT — 재동기 응답 하나에 ENTRY.snapshot 하나')
    assert.deepEqual(Object.keys(spy.calls['snapshot']![1]![0] as object).sort(), ['ptt-r1-audio', 't2', 't9'], 'SD-ENTRY-TRK-SNAPSHOT — 재동기 스냅샷의 트랙으로 통째')
    assert.deepEqual([...r.core.rooms.get('r1')!.trk.entries.keys()].sort(), ['ptt-r1-audio', 't2', 't9'], 'SD-ENTRY-TRK-SNAPSHOT — 보관본도 통째로 갈아 끼운다')
    await r.c.close()
  } finally { spy.restore(); http.restore() }
})

test('SD-ENTRY-TRK-TRACK-EVENT — 방 상태기가 받은 트랙 통지의 항목마다 ENTRY.trackEvent 하나 · mine = 내 발행(media 가 그 track_id 를 든다) · 내 것의 remove 는 이음매 pub.revoked', async () => {
  const spy = spyOn(TB.ENTRY)
  try {
    assert.deepEqual(TRK.REACTS.trackEvent, ['ROOM:trk.delta'], 'SD-ENTRY-TRK-TRACK-EVENT — 위가 정한 부르는 곳 하나(ROOM trk.delta)')
    const r = await up()
    await join(r, 'r1')
    const room = r.core.rooms.get('r1')!
    const media = r.core.media
    let revoked = 0
    const mineTrack = { revoked: () => { revoked += 1 } } as unknown as LocalCore
    media.ownsTrack = (id: string) => id === 't-mine'
    media.byTrackId = (id: string) => (id === 't-mine' ? mineTrack : undefined)
    await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t2'), tr('t-mine', { user_id: 'u1' })], 2))
    assert.equal(spy.n('trackEvent'), 2, 'SD-ENTRY-TRK-TRACK-EVENT — 통지의 항목마다 ENTRY.trackEvent 하나')
    assert.deepEqual(spy.calls['trackEvent']!.map((a) => a[1]), [false, true], 'SD-ENTRY-TRK-TRACK-EVENT — mine 갈림: 남의 것 거짓 · 내 발행 참')
    assert.deepEqual([room.trk.entries.has('t2'), room.trk.entries.has('t-mine')], [true, false], 'SD-ENTRY-TRK-TRACK-EVENT — 위가 고친 것만 보관본에(내 발행은 받을 트랙이 아니다)')
    await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t5')], 2))
    assert.equal(spy.n('trackEvent'), 2, 'SD-ENTRY-TRK-TRACK-EVENT — 낡은 seq 의 통지는 방 상태기가 버린다(0)')
    await note(r, Op.TRACK_EVENT, trackEvent('remove', [tr('t-mine', { user_id: 'u1' })], 3))
    assert.equal(spy.n('trackEvent'), 3)
    assert.equal(revoked, 1, 'SD-ENTRY-TRK-TRACK-EVENT — 내 트랙의 remove 는 이음매 pub.revoked 로 그 발행에 닿는다')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-TRK-TRACK-STATE — 방 상태기가 받은 트랙 상태 통지 하나에 ENTRY.trackState 하나 · 인자는 track_id · muted', async () => {
  const spy = spyOn(TB.ENTRY)
  try {
    assert.deepEqual(TRK.REACTS.trackState, ['ROOM:trk.delta'], 'SD-ENTRY-TRK-TRACK-STATE — 위가 정한 부르는 곳 하나(ROOM trk.delta)')
    const r = await up()
    await join(r, 'r1', { tracks: [tr('t2')] })
    await note(r, Op.TRACK_STATE, { room_id: 'r1', track_id: 't2', muted: true, version: vers(2) })
    assert.equal(spy.n('trackState'), 1, 'SD-ENTRY-TRK-TRACK-STATE — 통지 하나에 ENTRY.trackState 하나')
    assert.deepEqual(spy.calls['trackState']![0]![0], { t: 'TRACK_STATE', muted: true, track_id: 't2' }, 'SD-ENTRY-TRK-TRACK-STATE — 키 = track_id')
    assert.equal(r.core.rooms.get('r1')!.trk.entries.get('t2')?.muted, true)
    await note(r, Op.TRACK_STATE, { room_id: 'r1', track_id: 't2', muted: false, version: vers(2) })
    assert.equal(spy.n('trackState'), 1, 'SD-ENTRY-TRK-TRACK-STATE — 낡은 seq 는 방 상태기가 버린다(0)')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-TRK-STORE-DROP — 방을 떠나면(위 이음매 store.drop) ENTRY.storeDrop 하나 · 보관본을 버린다 · 앱 조작 · 통지는 넣지 않는다', async () => {
  const spy = spyOn(TB.ENTRY)
  try {
    assert.deepEqual(TRK.REACTS.storeDrop, ['ROOM:store.drop'], 'SD-ENTRY-TRK-STORE-DROP — 위가 정한 부르는 곳 하나(ROOM store.drop)')
    const r = await up()
    const h = await join(r, 'r1', { tracks: [tr('t2')], mlines: [row('0', 't2')] })
    const room = r.core.rooms.get('r1')!
    await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t3')], 2))
    await h.tracks[0]!.setLayer({ paused: true })
    assert.equal(spy.n('storeDrop'), 0, 'SD-ENTRY-TRK-STORE-DROP — 통지 · 앱 조작(SDK 사건)으로 넣는 곳 0')
    const l = h.leave()
    await tick()
    r.ws.answer(leaveFrame(r.ws, 'r1'), {})
    await l
    assert.equal(spy.n('storeDrop'), 1, 'SD-ENTRY-TRK-STORE-DROP — 퇴장 응답 뒤 ENTRY.storeDrop 하나')
    assert.equal(room.trk.entries.size, 0, 'SD-ENTRY-TRK-STORE-DROP — 그 방 보관본을 버린다')
    await r.c.close()
  } finally { spy.restore() }
})

// ══ 입구 표 — 구독(SUB) ════════════════════════════════════════════════════

test('SD-ENTRY-TRK-READY — 입장 · 스냅샷 반영 뒤(위 이음매 ready.tracks) ENTRY.ready 하나 · 통지 · 앱 조작은 넣지 않는다', async () => {
  const spy = spyOn(UB.ENTRY)
  const http = httpMock(() => ({ status: 200, body: getRoom('r1', 9) }))
  try {
    assert.deepEqual(SUB.REACTS.ready, ['ROOM:ready.tracks'], 'SD-ENTRY-TRK-READY — 위가 정한 부르는 곳 하나(ROOM ready.tracks)')
    const r = await up()
    const h = await join(r, 'r1', { tracks: [tr('t2')], mlines: [row('0', 't2')] })
    assert.equal(spy.n('ready'), 1, 'SD-ENTRY-TRK-READY — 입장 응답 뒤 ENTRY.ready 하나')
    await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t3')], 2))
    await h.tracks[0]!.setLayer({ paused: false })
    assert.equal(spy.n('ready'), 1, 'SD-ENTRY-TRK-READY — 통지 · 앱 조작(SDK 사건)으로 넣는 곳 0')
    await note(r, Op.ROOM_EVENT, { type: 'sync_required', room_id: 'r1', reason: 'x' })
    await tick(); await tick()
    assert.equal(spy.n('ready'), 2, 'SD-ENTRY-TRK-READY — 재동기 스냅샷 반영 뒤 ENTRY.ready 하나')
    await r.c.close()
  } finally { spy.restore(); http.restore() }
})

test('SD-ENTRY-TRK-NEGO-OK · SD-ENTRY-TRK-NEGO-FAIL — 그 서버 협상 결과(위 이음매 sub.nego_ok · sub.nego_fail)가 그 서버의 방마다 하나 · 성공이면 READY{arev} · 실패면 READY 0', async () => {
  const spy = spyOn(UB.ENTRY)
  try {
    assert.deepEqual(SUB.REACTS.negoOk, ['LINK:sub.nego_ok'], 'SD-ENTRY-TRK-NEGO-OK — 위가 정한 부르는 곳 하나(LINK sub.nego_ok)')
    assert.deepEqual(SUB.REACTS.negoFail, ['LINK:sub.nego_fail'], 'SD-ENTRY-TRK-NEGO-FAIL — 위가 정한 부르는 곳 하나(LINK sub.nego_fail)')
    const r = await up()
    await join(r, 'r1')
    await join(r, 'r2')
    await join(r, 'rb', { sc: SB })
    const ok0 = spy.n('negoOk')
    const ready0 = r.ws.requests(Op.READY).length
    await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t2')], 2))
    assert.equal(spy.n('negoOk'), ok0, 'SD-ENTRY-TRK-NEGO-OK — 통지(SDK 사건)로 넣는 곳 0')
    rx(r, '0')
    const t0 = r.trace.length
    await table(r, 5, [row('0', 't2')])
    await drain(r)
    const okRes = r.trace.slice(t0).filter((t) => t.layer === 'LINK' && t.key === 'sfu-a' && t.label.startsWith('LINK.C.any.nego_ok')).length
    const perRoom = (cause: string) => r.trace.slice(t0).filter((t) => t.layer === 'SUB' && t.cause === cause).map((t) => t.key)
    assert.ok(okRes >= 1)
    assert.equal(spy.n('negoOk') - ok0, okRes * 2, 'SD-ENTRY-TRK-NEGO-OK — 협상 성공 하나에 그 서버의 방마다 ENTRY.negoOk 하나')
    assert.deepEqual([...new Set(perRoom('nego'))].sort(), ['r1', 'r2'], 'SD-ENTRY-TRK-NEGO-OK — 다른 서버 방(rb)에는 0')
    const sent = r.ws.requests(Op.READY).slice(ready0).map((f) => f.body as { room_id: string; arev: number })
    assert.deepEqual(sent.map((b) => b.room_id).sort(), ['r1', 'r2'], 'SD-ENTRY-TRK-NEGO-OK — 그 서버의 방마다 READY')
    assert.ok(sent.every((b) => b.arev === 5), 'SD-ENTRY-TRK-NEGO-OK — READY 는 그 협상에 쓴 표의 arev')
    const fail0 = spy.n('negoFail')
    const ready1 = r.ws.requests(Op.READY).length
    const t1 = r.trace.length
    await table(r, 6, [row('0', 't2'), row('1', undefined)])
    await drain(r, SA, false)
    const failRes = r.trace.slice(t1).filter((t) => t.layer === 'LINK' && t.key === 'sfu-a' && t.label.startsWith('LINK.C.any.nego_fail')).length
    assert.ok(failRes >= 1)
    assert.equal(spy.n('negoFail') - fail0, failRes * 2, 'SD-ENTRY-TRK-NEGO-FAIL — 협상 실패 하나에 그 서버의 방마다 ENTRY.negoFail 하나')
    assert.equal(r.ws.requests(Op.READY).length, ready1, 'SD-ENTRY-TRK-NEGO-FAIL — 실패했으면 READY 를 보내지 않는다')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-TRK-READY-RES — READY 응답 하나에 ENTRY.readyRes 하나 · 성공은 part res · 실패는 part fail', async () => {
  const spy = spyOn(UB.ENTRY)
  try {
    const r = await up()
    await join(r, 'r1')
    assert.equal(spy.n('readyRes'), 1, 'SD-ENTRY-TRK-READY-RES — 입장 협상 뒤 READY 의 응답 하나에 ENTRY.readyRes 하나')
    assert.deepEqual(spy.calls['readyRes']![0]![0], { part: 'res' }, 'SD-ENTRY-TRK-READY-RES — 성공 응답 part res')
    FakeWS.auto.delete(Op.READY)
    await table(r, 5, [row('0', undefined)])
    await drain(r)
    assert.equal(spy.n('readyRes'), 1, 'SD-ENTRY-TRK-READY-RES — 응답 전에는 0')
    r.ws.answer(r.ws.last(Op.READY), { code: 3002, name: 'NOT_IN_ROOM', permanent: false }, false)
    await tick()
    assert.equal(spy.n('readyRes'), 2, 'SD-ENTRY-TRK-READY-RES — 실패 응답 하나에 ENTRY.readyRes 하나')
    assert.deepEqual(spy.calls['readyRes']![1]![0], { part: 'fail' }, 'SD-ENTRY-TRK-READY-RES — 실패 응답 part fail')
    await r.c.close()
  } finally { spy.restore(); FakeWS.auto.set(Op.READY, {}) }
})

test('SD-ENTRY-TRK-TABLE-CHANGED · SD-ENTRY-TRK-TABLE-REBOUND — 배정표 통지가 SDP 재료를 바꾸면 그 서버의 방마다 ENTRY.tableChanged · 실린 트랙만 바뀌면 ENTRY.tableRebound(재조립 0 · 바로 READY)', async () => {
  const spy = spyOn(UB.ENTRY)
  try {
    assert.deepEqual(SUB.REACTS.tableChanged, ['LINK:sub.table_changed'], 'SD-ENTRY-TRK-TABLE-CHANGED — 위가 정한 부르는 곳 하나')
    assert.deepEqual(SUB.REACTS.tableRebound, ['LINK:sub.table_rebound'], 'SD-ENTRY-TRK-TABLE-REBOUND — 위가 정한 부르는 곳 하나')
    const r = await up()
    await join(r, 'r1', { tracks: [tr('t2'), tr('t3')], mlines: [row('0', 't2')] })
    await join(r, 'r2')
    await join(r, 'rb', { sc: SB })
    const peer = r.peers.get('sfu-a')!
    const c0 = spy.n('tableChanged')
    const b0 = spy.n('tableRebound')
    await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t4')], 2))
    assert.deepEqual([spy.n('tableChanged'), spy.n('tableRebound')], [c0, b0], '통지(SDK 사건)로 넣는 곳 0')
    // 줄이 늘었다 — SDP 재료가 바뀌었다
    const asm = peer.assembled
    await table(r, 7, [row('0', 't2'), row('1', 't3')])
    assert.equal(spy.n('tableChanged') - c0, 2, 'SD-ENTRY-TRK-TABLE-CHANGED — 그 서버의 방마다 ENTRY.tableChanged 하나(다른 서버 방 0)')
    await drain(r)
    assert.ok(peer.assembled > asm, 'SD-ENTRY-TRK-TABLE-CHANGED — 이음매 sdp.rebuild → 다시 짓는다')
    // 줄은 그대로 · 실린 트랙만 바뀌었다
    const ready0 = r.ws.requests(Op.READY).length
    const asm2 = peer.assembled
    await table(r, 8, [row('0', 't2'), row('1', 't4')])
    assert.equal(spy.n('tableRebound') - b0, 2, 'SD-ENTRY-TRK-TABLE-REBOUND — 그 서버의 방마다 ENTRY.tableRebound 하나')
    assert.equal(spy.n('tableChanged') - c0, 2, 'SD-ENTRY-TRK-TABLE-REBOUND — 실린 트랙만 바뀐 표는 tableChanged 가 아니다')
    await drain(r)
    assert.equal(peer.assembled, asm2, 'SD-ENTRY-TRK-TABLE-REBOUND — 재조립 0')
    assert.deepEqual(r.ws.requests(Op.READY).slice(ready0).map((f) => (f.body as { room_id: string; arev: number })).map((b) => `${b.room_id}:${b.arev}`).sort(), ['r1:8', 'r2:8'], 'SD-ENTRY-TRK-TABLE-REBOUND — 바로 READY{arev}')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-TRK-LAYER · SD-ENTRY-TRK-LAYER-RES — setLayer() · attach() 의 adaptiveStream 이 ENTRY.layer 하나 · SUBSCRIBE_LAYER 응답 하나에 ENTRY.layerRes 하나', async () => {
  const spy = spyOn(UB.ENTRY)
  const g = globalThis as unknown as { MediaStream?: unknown }
  const savedMS = g.MediaStream
  g.MediaStream = class { constructor(readonly tracks: unknown[]) {} }
  try {
    const r = await up({ adaptiveStreamSettleMs: 5 })
    const h = await join(r, 'r1', { tracks: [tr('t2', { scalability: 'L2T1' })], mlines: [row('0', 't2')] })
    assert.equal(spy.n('layer'), 0)
    const t = h.tracks[0]!
    await t.setLayer({ spatial: 0 })
    assert.equal(spy.n('layer'), 1, 'SD-ENTRY-TRK-LAYER — setLayer() 하나에 ENTRY.layer 하나')
    assert.equal(r.ws.requests(Op.SUBSCRIBE_LAYER).length, 1, 'SD-ENTRY-TRK-LAYER — 위가 낸 SUBSCRIBE_LAYER')
    assert.equal(spy.n('layerRes'), 1, 'SD-ENTRY-TRK-LAYER-RES — 응답 하나에 ENTRY.layerRes 하나')
    const el = { srcObject: null, autoplay: false, playsInline: false, muted: false, clientWidth: 960, play: async () => undefined } as unknown as HTMLVideoElement
    t.attach(el)
    await tick(20)
    assert.equal(spy.n('layer'), 2, 'SD-ENTRY-TRK-LAYER — attach() 의 adaptiveStream 이 묶음 뒤 ENTRY.layer 하나')
    assert.deepEqual((r.ws.last(Op.SUBSCRIBE_LAYER).body as { targets: unknown[] }).targets, [{ track_id: 't2', paused: false, priority: 200, spatial: 1 }], 'SD-ENTRY-TRK-LAYER — 보이는 큰 타일: 정지 해제 · 우선순위 200 · 가장 높은 공간 단')
    assert.equal(spy.n('layerRes'), 2, 'SD-ENTRY-TRK-LAYER-RES — 응답 하나에 ENTRY.layerRes 하나')
    t.detach(el)
    await r.c.close()
  } finally { spy.restore(); g.MediaStream = savedMS }
})

test('SD-ENTRY-TRK-DROP-ROOM — 방을 떠나면(위 이음매 sub.drop) ENTRY.dropRoom 하나 · 통지 · 앱 조작은 넣지 않는다', async () => {
  const spy = spyOn(UB.ENTRY)
  try {
    assert.deepEqual(SUB.REACTS.dropRoom, ['ROOM:sub.drop'], 'SD-ENTRY-TRK-DROP-ROOM — 위가 정한 부르는 곳 하나(ROOM sub.drop)')
    const r = await up()
    const h = await join(r, 'r1', { tracks: [tr('t2')], mlines: [row('0', 't2')] })
    await note(r, Op.TRACK_EVENT, trackEvent('remove', [tr('t2')], 2))
    assert.equal(spy.n('dropRoom'), 0, 'SD-ENTRY-TRK-DROP-ROOM — 통지(SDK 사건)로 넣는 곳 0')
    const l = h.leave()
    await tick()
    assert.equal(spy.n('dropRoom'), 1, 'SD-ENTRY-TRK-DROP-ROOM — 퇴장에 ENTRY.dropRoom 하나')
    assert.equal(r.core.rooms.get('r1')!.trk.sub.st.ready, 'NONE')
    r.ws.answer(leaveFrame(r.ws, 'r1'), {})
    await l
    await r.c.close()
  } finally { spy.restore() }
})

// ══ 효과 표 ═════════════════════════════════════════════════════════════════

test('SD-EFFECT-TRK-APP-BUG — 준비 알림 실패(위 효과 app.bug)는 room.on(error) 하나 · 받은 실패 코드 그대로', async () => {
  assert.equal(UB.effect('app.bug').event, 'error', 'SD-EFFECT-TRK-APP-BUG — 효과 표: app.bug → error')
  try {
    const r = await up()
    FakeWS.auto.delete(Op.READY)
    const p = r.c.join('r1')
    await tick()
    linkOf(r, SA)
    r.ws.answer(r.ws.last(Op.ROOM_JOIN), joinBody(r, 'r1'))
    await tick(); await drain(r)
    const h = await p
    const errs: OxLensError[] = []
    h.on('error', (e) => errs.push(e))
    r.ws.answer(r.ws.last(Op.READY), { code: 3001, name: 'NOT_JOINED', permanent: false }, false)
    await tick()
    assert.equal(errs.length, 1, 'SD-EFFECT-TRK-APP-BUG — room error 하나')
    assert.ok(errs[0] instanceof OxLensError && errs[0].code === 3001, 'SD-EFFECT-TRK-APP-BUG — 표면 오류형 · 받은 코드 그대로')
    assert.equal(r.core.rooms.get('r1')!.trk.sub.st.ready, 'NONE', '위가 판정(SUB.C.SENT.ready_fail)')
    await r.c.close()
  } finally { FakeWS.auto.set(Op.READY, {}) }
})

test('SD-EFFECT-TRK-APP-TRACK-STATE — 위 효과 app.track_state 는 그 핸들의 muted 하나 · duplex · live 형은 없다 · receiving 은 wire 로 바뀌지 않는다', async () => {
  assert.equal(TB.effect('app.track_state').event, 'muted', 'SD-EFFECT-TRK-APP-TRACK-STATE — 효과 표: app.track_state → muted')
  const r = await up()
  const h = await join(r, 'r1', { tracks: [tr('t2', { kind: 'audio' })], mlines: [row('0', 't2', 'audio')] })
  const t = h.tracks[0]!
  const seen: boolean[] = []
  t.on('muted', (m) => seen.push(m))
  await note(r, Op.TRACK_STATE, { room_id: 'r1', track_id: 't2', muted: true, version: vers(2) })
  assert.deepEqual([seen, t.muted], [[true], true], 'SD-EFFECT-TRK-APP-TRACK-STATE — muted 하나 · 핸들 값도 따라간다')
  assert.ok(!('duplex' in t) && !('live' in t), 'SD-EFFECT-TRK-APP-TRACK-STATE — duplex · live 형 0(구독자는 발행자의 duplex 를 모른다)')
  assert.equal(t.receiving, false, 'SD-EFFECT-TRK-APP-TRACK-STATE — receiving 은 로컬 관측이라 통지로 바뀌지 않는다')
  await r.c.close()
})

test('SD-EFFECT-TRK-APP-TRACKS — 위 효과 app.tracks: 장착 가능하면 track · 줄이 없으면 trackUnreachable · 빠지면 ended · 같은 트랙 교체는 같은 핸들의 active', async () => {
  assert.equal(TB.effect('app.tracks').event, 'track', 'SD-EFFECT-TRK-APP-TRACKS — 효과 표: app.tracks → track')
  const r = await up()
  const h = await join(r, 'r1')
  const got: RemoteTrack[] = []
  const unreachable: string[] = []
  h.on('track', (t) => got.push(t))
  h.on('trackUnreachable', (i) => unreachable.push(i.id))
  rx(r, '0')
  await table(r, 2, [row('0', 't2')])
  await drain(r)
  await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t2'), tr('t3')], 2))
  assert.deepEqual(got.map((t) => t.id), ['t2'], 'SD-EFFECT-TRK-APP-TRACKS — 추가: 줄이 있는 트랙은 track')
  assert.deepEqual(unreachable, ['t3'], 'SD-EFFECT-TRK-APP-TRACKS — 추가: 줄이 없으면 trackUnreachable')
  const t2 = got[0]!
  const act: { active: boolean }[] = []
  let ended = 0
  t2.on('active', (a) => act.push({ active: a.active }))
  t2.on('ended', () => { ended += 1 })
  await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t2', { active: false })], 3))
  assert.deepEqual(act, [{ active: false }], 'SD-EFFECT-TRK-APP-TRACKS — 같은 트랙 교체: 같은 핸들의 active 하나')
  assert.equal(got.length, 1, 'SD-EFFECT-TRK-APP-TRACKS — 교체로 새 핸들 0')
  await note(r, Op.TRACK_EVENT, trackEvent('remove', [tr('t2')], 4))
  assert.equal(ended, 1, 'SD-EFFECT-TRK-APP-TRACKS — 빠짐: ended 하나')
  assert.deepEqual(h.tracks.map((t) => t.id), [], 'SD-EFFECT-TRK-APP-TRACKS — 빠진 트랙은 room.tracks 에 없다')
  await r.c.close()
})

// ══ 표면 ═══════════════════════════════════════════════════════════════════

test('SD-API-ROOM-ON-TRACK — client.on(track) 을 join 전에 걸면 초기 트랙을 받는다 · join 뒤 await 를 둔 방 리스너는 놓치고 room.tracks 로 전부 본다 · 뒤에 온 트랙은 방 리스너로', async () => {
  const r = await up()
  const early: string[] = []
  r.c.on('track', (room, t) => early.push(`${room.id}/${t.id}`))
  const h = await join(r, 'r1', { tracks: [tr('t2'), slotOf('r1', 'audio')], mlines: [row('0', 'ptt-r1-audio', 'audio'), row('1', 't2')] })
  await tick()
  const late: string[] = []
  h.on('track', (t) => late.push(t.id))
  await tick()
  assert.deepEqual(early.sort(), ['r1/ptt-r1-audio', 'r1/t2'], 'SD-API-ROOM-ON-TRACK — join 전에 건 client.on(track) 은 초기 트랙을 다 받는다')
  assert.deepEqual(late, [], 'SD-API-ROOM-ON-TRACK — join 뒤 await 를 두고 건 방 리스너는 초기 트랙을 놓친다')
  assert.deepEqual(h.tracks.map((t) => t.id).sort(), ['ptt-r1-audio', 't2'], 'SD-API-ROOM-ON-TRACK — room.tracks 는 장착 가능한 트랙 전부')
  rx(r, '2')
  await table(r, 2, [row('0', 'ptt-r1-audio', 'audio'), row('1', 't2'), row('2', 't3')])
  await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t3')], 2))
  await drain(r)
  assert.deepEqual(late, ['t3'], 'SD-API-ROOM-ON-TRACK — 뒤에 온 트랙은 방 리스너로 하나')
  assert.equal(early.filter((x) => x === 'r1/t3').length, 1, 'SD-API-ROOM-ON-TRACK — client.on(track) 도 하나')
  await r.c.close()
})

test('SD-API-ROOM-ON-TRACK-UNREACHABLE — 표에 줄 없이 온 항목만 trackUnreachable 하나(내 트랙 · 쉬는 트랙 0) · 페이로드는 정체만(핸들 0) · 줄이 오면 track 하나', async () => {
  const r = await up()
  const h = await join(r, 'r1', { tracks: [tr('t2')], mlines: [row('0', 't2')] })
  const un: unknown[] = []
  const got: string[] = []
  h.on('trackUnreachable', (i) => un.push(i))
  h.on('track', (t) => got.push(t.id))
  await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t9', { scalability: 'L2T1' }), tr('t1', { user_id: 'u1' }), tr('t8', { active: false })], 2))
  assert.equal(un.length, 1, 'SD-API-ROOM-ON-TRACK-UNREACHABLE — 줄 없이 온 받을 트랙 하나만(내 트랙 · 쉬는 트랙 0)')
  assert.deepEqual(un[0], { id: 't9', type: 'individual', kind: 'video', userId: 'u2', scalability: 'L2T1' }, 'SD-API-ROOM-ON-TRACK-UNREACHABLE — 페이로드는 RemoteTrackInfo(id · type · kind · userId? · scalability?)')
  assert.ok(!(un[0] instanceof RemoteTrack) && typeof (un[0] as { attach?: unknown }).attach === 'undefined', 'SD-API-ROOM-ON-TRACK-UNREACHABLE — 핸들이 아니다')
  await note(r, Op.TRACK_STATE, { room_id: 'r1', track_id: 't9', muted: true, version: vers(3) })
  assert.equal(un.length, 1, 'SD-API-ROOM-ON-TRACK-UNREACHABLE — 같은 트랙은 다시 내지 않는다')
  rx(r, '1')
  await table(r, 3, [row('0', 't2'), row('1', 't9')])
  await drain(r)
  assert.deepEqual(got, ['t9'], 'SD-API-ROOM-ON-TRACK-UNREACHABLE — 서버가 줄을 주면 track 하나')
  await r.c.close()
})

test('SD-API-REMOTE-TRACK — type 은 트랙 층 type 그대로(파싱 0 · userId 로 추론 0) · receiving 은 로컬 첫 프레임(wire 필드 0) · 복귀로 줄이 바뀌면 active payload 의 mediaStreamTrack 이 새 트랙', async () => {
  const r = await up()
  const looksSlot = { ...tr('ptt-r1-x'), live: true, receiving: true } as TrackEntry
  const noUser: TrackEntry = { type: 'individual', room_id: 'r1', track_id: 't-anon', kind: 'video' }
  const h = await join(r, 'r1', { tracks: [looksSlot, slotOf('r1', 'video'), noUser], mlines: [row('0', 'ptt-r1-x'), row('1', 'ptt-r1-video'), row('2', 't-anon')] })
  const by = new Map(h.tracks.map((t) => [t.id, t]))
  assert.deepEqual([by.get('ptt-r1-x')!.type, by.get('ptt-r1-video')!.type, by.get('t-anon')!.type], ['individual', 'slot', 'individual'], 'SD-API-REMOTE-TRACK — type 은 wire type 그대로(track_id 를 파싱하지 않는다 · userId 가 없어도 individual)')
  assert.deepEqual([by.get('ptt-r1-x')!.userId, by.get('ptt-r1-video')!.userId], ['u2', undefined], 'SD-API-REMOTE-TRACK — userId 는 individual 만')
  const a = by.get('ptt-r1-x')!
  assert.equal(a.receiving, false, 'SD-API-REMOTE-TRACK — wire 의 live · receiving 칸은 receiving 을 정하지 않는다')
  let rcv = 0
  a.on('receiving', () => { rcv += 1 })
  ;(a.mediaStreamTrack as unknown as FakeTrack).unmute()
  assert.deepEqual([a.receiving, rcv], [true, 1], 'SD-API-REMOTE-TRACK — receiving 은 로컬 첫 디코딩 프레임(수신 트랙 unmute)에서만')
  // 쉼(줄을 놓는다) → 복귀(다른 mid 의 줄)
  const act: { active: boolean; mediaStreamTrack: MediaStreamTrack | null }[] = []
  a.on('active', (x) => act.push(x))
  const old = a.mediaStreamTrack
  await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('ptt-r1-x', { active: false })], 2))
  await table(r, 2, [row('0', undefined), row('1', 'ptt-r1-video'), row('2', 't-anon')])
  await drain(r)
  const fresh = rx(r, '3')
  await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('ptt-r1-x')], 3))
  await table(r, 3, [row('0', undefined), row('1', 'ptt-r1-video'), row('2', 't-anon'), row('3', 'ptt-r1-x')])
  await drain(r)
  assert.deepEqual(act.map((x) => x.active), [false, true], 'SD-API-REMOTE-TRACK — 쉼 · 복귀가 같은 핸들의 active')
  assert.equal(act[0]!.mediaStreamTrack, old)
  assert.ok(act[1]!.mediaStreamTrack === (fresh as unknown as MediaStreamTrack) && a.mediaStreamTrack === act[1]!.mediaStreamTrack, 'SD-API-REMOTE-TRACK — 복귀로 mid 가 바뀌면 active payload 의 mediaStreamTrack 은 새 트랜시버의 트랙')
  await r.c.close()
})

test('SD-API-REMOTE-TRACK-ON-ENDED①②③④ — remove 는 ended · 항목 교체는 같은 핸들 active(새 핸들 0 · mid 가 바뀌면 트랙 교체) · TRACK_STATE 는 muted · receiving 은 로컬 첫 프레임에서만', async () => {
  const r = await up()
  const h = await join(r, 'r1', { tracks: [tr('t2'), tr('t3', { kind: 'audio' })], mlines: [row('0', 't2'), row('1', 't3', 'audio')] })
  const handles: string[] = []
  h.on('track', (t) => handles.push(t.id))
  const by = new Map(h.tracks.map((t) => [t.id, t]))
  const t2 = by.get('t2')!
  const t3 = by.get('t3')!
  let ended = 0
  t3.on('ended', () => { ended += 1 })
  // ① remove
  await note(r, Op.TRACK_EVENT, trackEvent('remove', [tr('t3', { kind: 'audio' })], 2))
  assert.equal(ended, 1, 'SD-API-REMOTE-TRACK-ON-ENDED① — remove 에 ended 하나')
  // ② 항목 교체 — 쉼 → 복귀(새 mid)
  const act: { active: boolean; mediaStreamTrack: MediaStreamTrack | null }[] = []
  t2.on('active', (x) => act.push(x))
  await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t2', { active: false })], 3))
  assert.deepEqual(act.map((x) => x.active), [false], 'SD-API-REMOTE-TRACK-ON-ENDED② — 쉼: 같은 핸들의 active 하나')
  await table(r, 2, [row('0', undefined), row('1', undefined, 'audio')])
  await drain(r)
  const fresh = rx(r, '2')
  await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t2')], 4))
  assert.equal(act.length, 1, 'SD-API-REMOTE-TRACK-ON-ENDED② — 복귀했는데 줄이 아직 없으면 active 를 미룬다(트랙 없는 payload 0)')
  await table(r, 3, [row('0', undefined), row('1', undefined, 'audio'), row('2', 't2')])
  await drain(r)
  assert.deepEqual(act.map((x) => x.active), [false, true], 'SD-API-REMOTE-TRACK-ON-ENDED② — 복귀: 같은 핸들의 active 하나')
  assert.equal(act[1]!.mediaStreamTrack, fresh as unknown as MediaStreamTrack, 'SD-API-REMOTE-TRACK-ON-ENDED② — 복귀로 mid 가 바뀌면 payload 의 mediaStreamTrack 교체')
  assert.deepEqual([handles, h.tracks.find((t) => t.id === 't2') === t2], [[], true], 'SD-API-REMOTE-TRACK-ON-ENDED② — 새 핸들 0(track 이벤트 0 · 같은 핸들)')
  // ③ TRACK_STATE
  const muted: boolean[] = []
  t2.on('muted', (m) => muted.push(m))
  await note(r, Op.TRACK_STATE, { room_id: 'r1', track_id: 't2', muted: true, version: vers(5) })
  assert.deepEqual(muted, [true], 'SD-API-REMOTE-TRACK-ON-ENDED③ — TRACK_STATE{muted} 에 muted 하나')
  // ④ receiving
  let rcv = 0
  t2.on('receiving', () => { rcv += 1 })
  await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t2', { muted: true })], 6))
  await note(r, Op.TRACK_STATE, { room_id: 'r1', track_id: 't2', muted: false, version: vers(7) })
  assert.equal(rcv, 0, 'SD-API-REMOTE-TRACK-ON-ENDED④ — 통지로는 receiving 0')
  fresh.unmute()
  assert.deepEqual([rcv, t2.receiving], [1, true], 'SD-API-REMOTE-TRACK-ON-ENDED④ — receiving 은 로컬 첫 디코딩 프레임에서 하나')
  await r.c.close()
})

test('SD-API-REMOTE-TRACK-SET-LAYER — 값은 상한 · scalability 밖의 값은 보내지 않는다(범위 밖 0 · 생략한 칸은 싣지 않는다) · priority 1~255', async () => {
  {
    const r = await up()
    const h = await join(r, 'r1', { tracks: [tr('t2', { scalability: 'L2T3' }), tr('t3')], mlines: [row('0', 't2'), row('1', 't3')] })
    const by = new Map(h.tracks.map((t) => [t.id, t]))
    const last = (): unknown => (r.ws.last(Op.SUBSCRIBE_LAYER).body as { targets: unknown[] }).targets
    await by.get('t2')!.setLayer({ spatial: 5, temporal: 9, priority: 999 })
    assert.deepEqual(last(), [{ track_id: 't2', spatial: 1, temporal: 2, priority: 255 }], 'SD-API-REMOTE-TRACK-SET-LAYER — L2T3 이면 spatial 0~1 · temporal 0~2 · priority 상한 255')
    await by.get('t2')!.setLayer({ spatial: -3, priority: 0 })
    assert.deepEqual(last(), [{ track_id: 't2', spatial: 0, priority: 1 }], 'SD-API-REMOTE-TRACK-SET-LAYER — 아래로도 범위 안 · 생략한 칸(temporal)은 싣지 않는다')
    await by.get('t3')!.setLayer({ spatial: 2, temporal: 1, paused: true })
    assert.deepEqual(last(), [{ track_id: 't3', paused: true }], 'SD-API-REMOTE-TRACK-SET-LAYER — scalability 가 없으면 레이어 칸은 범위가 없다(싣지 않는다) · paused 는 별개 축')
    const all = r.ws.requests(Op.SUBSCRIBE_LAYER).flatMap((f) => (f.body as { targets: { spatial?: number; temporal?: number }[] }).targets)
    assert.equal(all.filter((x) => (x.spatial ?? 0) > 1 || (x.spatial ?? 0) < 0 || (x.temporal ?? 0) > 2 || (x.temporal ?? 0) < 0).length, 0, 'SD-API-REMOTE-TRACK-SET-LAYER — 범위 밖 0')
    await r.c.close()
  }
})

test('SD-API-ROOM-ON-ERROR — 재조립 협상 실패 · READY 실패 · 재동기 HTTP 실패가 각각 room.on(error) 로 OxLensError 하나 · 내 요청(setLayer)의 실패는 reject 로(여기 0)', async () => {
  let fails = 0
  const http = httpMock(() => { fails += 1; return { status: 500, body: { code: 5003, name: 'INTERNAL_ERROR', permanent: false } } })
  try {
    const r = await up()
    const h = await join(r, 'r1', { tracks: [tr('t2')], mlines: [row('0', 't2')] })
    const errs: OxLensError[] = []
    h.on('error', (e) => errs.push(e))
    // 재조립 협상 실패
    await table(r, 2, [row('0', 't2'), row('1', undefined)])
    await drain(r, SA, false)
    assert.equal(errs.length, 1, 'SD-API-ROOM-ON-ERROR — 재조립 협상 실패(입장 중이 아닌 방도) room error 하나')
    assert.ok(errs[0] instanceof OxLensError && errs[0].category === 'negotiation', 'SD-API-ROOM-ON-ERROR — 협상 실패는 negotiation 분류')
    // READY 실패
    FakeWS.auto.delete(Op.READY)
    await table(r, 3, [row('0', 't2'), row('1', undefined), row('2', undefined)])
    await drain(r)
    r.ws.answer(r.ws.last(Op.READY), { code: 3002, name: 'NOT_IN_ROOM', permanent: false }, false)
    await tick()
    assert.equal(errs.length, 2, 'SD-API-ROOM-ON-ERROR — READY 실패 room error 하나')
    assert.equal(errs[1]!.code, 3002)
    // 내 요청의 실패 — setLayer 는 reject · room error 0
    FakeWS.auto.delete(Op.SUBSCRIBE_LAYER)
    const p = h.tracks[0]!.setLayer({ paused: true }).then(() => null, (x: unknown) => x)
    await tick()
    r.ws.answer(r.ws.last(Op.SUBSCRIBE_LAYER), { code: 3002, name: 'NOT_IN_ROOM', permanent: false }, false)
    const e = await p
    assert.ok(e instanceof OxLensError && e.code === 3002, 'SD-API-ROOM-ON-ERROR — 내 요청(setLayer)의 실패는 Promise reject')
    assert.equal(errs.length, 2, 'SD-API-ROOM-ON-ERROR — 내 요청의 실패는 room error 0')
    // 재동기 HTTP 실패 — 사다리를 다 밟아도 실패면 하나
    await note(r, Op.ROOM_EVENT, { type: 'sync_required', room_id: 'r1', reason: 'x' })
    await tick(1800)
    assert.ok(fails >= 3, '재동기를 사다리대로 다시 던졌다')
    assert.equal(errs.length, 3, 'SD-API-ROOM-ON-ERROR — 재동기 HTTP 실패 room error 하나(로그만 남기고 삼키지 않는다)')
    assert.equal(errs[2]!.code, 5003)
    await r.c.close()
  } finally { http.restore(); FakeWS.auto.set(Op.READY, {}); FakeWS.auto.set(Op.SUBSCRIBE_LAYER, {}) }
})

test('K-sym-IMPL-TRK-RECEIVE-1 — 다방 지령대: 받는 트랙마다 roomId 가 있고 그 트랙을 낸 방과 같다(두 서버 · 같은 track_id 꼴의 슬롯도 방으로 갈린다)', async () => {
  const r = await up()
  const seen: [string, string, string][] = []
  r.c.on('track', (room, t) => seen.push([room.id, t.roomId, t.id]))
  await join(r, 'r1', { tracks: [slotOf('r1', 'audio'), tr('t2')], mlines: [row('0', 'ptt-r1-audio', 'audio'), row('1', 't2')] })
  await join(r, 'rb', { sc: SB, tracks: [slotOf('rb', 'audio'), tr('t7', { room_id: 'rb', user_id: 'u7' })], mlines: [row('0', 'ptt-rb-audio', 'audio', 'rb'), row('1', 't7', 'video', 'rb')] })
  await tick()
  assert.equal(seen.length, 4)
  assert.ok(seen.every(([room, rid]) => typeof rid === 'string' && rid === room), `K-sym-IMPL-TRK-RECEIVE-1 — 트랙마다 roomId 존재 · 낸 방과 같다: ${JSON.stringify(seen)}`)
  for (const id of ['r1', 'rb']) {
    const h = r.c.rooms.get(id)!
    assert.ok(h.tracks.length === 2 && h.tracks.every((t) => t.roomId === id), `K-sym-IMPL-TRK-RECEIVE-1 — ${id}.tracks 의 roomId 는 그 방`)
  }
  await r.c.close()
})
