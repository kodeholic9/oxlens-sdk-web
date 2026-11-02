// author: kodeholic (powered by Claude)
// SDK:IMPL-AFF-SPEAKING-ROOM — 소속(발언 방) 영역 1층. 위가 지은 소속 클라 상태기 둘레의 손 결합(입구 표 · 효과 표 · 이음매)을 잰다.
// ★입구는 위 결합(aff_binding)의 ENTRY 를 지나는지 · 표면은 효과 표(effect)대로 나는지를 AFF 단위(SD-ENTRY-AFF-* · SD-EFFECT-AFF-* · SD-API-*)마다 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 진짜 연결 상태기에 가짜 PeerLink(test/_rig).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tick, type Frame } from './_ws.js'
import { SA, SB, up, linkOf, drain, enter, joinBody, joinFrame, leaveFrame, type Rig } from './_rig.js'
import * as AFF from '../src/domain/gen/aff_client.js'
import * as AB from '../src/domain/gen/aff_binding.js'
import * as C from '../src/internal/wire/floor_codec.js'
import * as Mbcp from '../src/internal/mbcp.js'
import { Op } from '../src/internal/wire/ws.js'
import { OxLensError, type Room } from '../src/index.js'

/** 위 결합 ENTRY 의 입구마다 불린 인자(상태 뒤) · 위가 받았나(null 아님) — SDK 사건이 결합 코드를 지났나를 잰다 */
function spyOn(entry: object): { calls: Record<string, unknown[][]>; took: Record<string, boolean[]>; n(k: string): number; restore(): void } {
  const E = entry as Record<string, (...a: unknown[]) => unknown>
  const saved = { ...E }
  const calls: Record<string, unknown[][]> = {}
  const took: Record<string, boolean[]> = {}
  for (const k of Object.keys(saved)) {
    calls[k] = []
    took[k] = []
    E[k] = (...a: unknown[]) => { calls[k]!.push(a.slice(1)); const s = saved[k]!(...a); took[k]!.push(s !== null); return s }
  }
  return { calls, took, n: (k) => calls[k]?.length ?? 0, restore: () => { Object.assign(E, saved) } }
}

/** 지금 걸린 AFFILIATION 요청에 답한다 */
async function affReply(r: Rig, body: unknown, ok = true): Promise<Frame> {
  await tick()
  const f = r.ws.last(Op.AFFILIATION)
  r.ws.answer(f, body, ok)
  await tick()
  return f
}

const speakingId = (r: Rig): string | null => r.c.speakingRoom?.id ?? null
const affs = (r: Rig): number => r.ws.requests(Op.AFFILIATION).length
const res = (sub_rooms: string[], pub_room: string | null): unknown => ({ sub_rooms, pub_room, cause: 'user' })

/** 그 서버 PeerLink 가 DC 로 낸 발언권 메시지 종류 */
function dcSent(r: Rig, sfu: string): number[] {
  const sent: number[] = []
  const peer = r.peers.get(sfu) as unknown as { sendDc(b: Uint8Array): boolean }
  peer.sendDc = (b) => { const m = C.decode(Mbcp.unwrap(b)!); if (m) sent.push(m.type); return true }
  return sent
}

/** 듣는 방 셋 — r1 · r2 는 서버 A · r3 은 서버 B */
async function three(r: Rig): Promise<void> {
  await enter(r, 'r1')
  await enter(r, 'r2')
  await enter(r, 'r3', { sc: SB })
}

// ══ 입구 표 ════════════════════════════════════════════════════════════

test('SD-ENTRY-AFF-SELECT — setSpeakingRoom(id) · press() 의 발언 방 단계가 ENTRY.select 하나 · r = 그 방 · same = 지금 발언 방과 같은 서버', async () => {
  const spy = spyOn(AB.ENTRY)
  try {
    assert.equal(AB.ENTRY_ALL.select, true)
    const r = await up()
    await three(r)
    const p1 = r.c.setSpeakingRoom('r1')
    await tick()
    assert.equal(spy.n('select'), 1, 'SD-ENTRY-AFF-SELECT — setSpeakingRoom(id) 하나에 ENTRY.select 하나')
    assert.deepEqual(spy.calls['select']![0], ['r1', false], 'SD-ENTRY-AFF-SELECT — r = 그 방 · 발언 방이 없으면 same 거짓')
    await affReply(r, res(['r1', 'r2'], 'r1'))
    await p1
    const p2 = r.c.setSpeakingRoom('r2')
    await tick()
    assert.deepEqual(spy.calls['select']![1], ['r2', true], 'SD-ENTRY-AFF-SELECT — 같은 서버의 발언 방 → same 참')
    await affReply(r, res(['r1', 'r2'], 'r2'))
    await p2
    const p3 = r.c.setSpeakingRoom('r3')
    await tick()
    assert.deepEqual(spy.calls['select']![2], ['r3', false], 'SD-ENTRY-AFF-SELECT — 다른 서버의 발언 방 → same 거짓')
    await affReply(r, res(['r1', 'r2'], null))
    await affReply(r, res(['r3'], 'r3'))
    await p3
    await r.c.setSpeakingRoom('r3')
    assert.equal(spy.n('select'), 3, 'SD-ENTRY-AFF-SELECT — 이미 발언 방이면 입구 0')
    // press() 의 발언 방 단계 — 반이중 발행은 이미 끝난 것으로 둔다
    const media = r.core.media as unknown as { ensureHalfMic(): Promise<void> }
    media.ensureHalfMic = async () => undefined
    const floor = r.core.rooms.get('r1')!.floor
    await floor.press()
    await tick()
    assert.equal(spy.n('select'), 4, 'SD-ENTRY-AFF-SELECT — press() 의 발언 방 단계가 ENTRY.select 하나')
    assert.deepEqual(spy.calls['select']![3], ['r1', false], 'SD-ENTRY-AFF-SELECT — press 한 방 · 서버 B 발언 방에서 → same 거짓')
    await floor.release()
    await affReply(r, res(['r3'], null))
    await affReply(r, res(['r1', 'r2'], 'r1'))
    assert.equal(r.c.speakingRoom?.id, 'r1')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-AFF-DESELECT — setSpeakingRoom(null) 이 ENTRY.deselect 하나 · pub_deselect 만 · 발언 방이 없으면 입구 0', async () => {
  const spy = spyOn(AB.ENTRY)
  try {
    assert.equal(AB.ENTRY_ALL.deselect, true)
    const r = await up()
    await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
    assert.equal(r.c.speakingRoom?.id, 'r1')
    const d = r.c.setSpeakingRoom(null)
    await tick()
    assert.equal(spy.n('deselect'), 1, 'SD-ENTRY-AFF-DESELECT — setSpeakingRoom(null) 하나에 ENTRY.deselect 하나')
    const f = await affReply(r, res(['r1'], null))
    assert.deepEqual(f.body, { pub_deselect: 'r1' }, 'SD-ENTRY-AFF-DESELECT — 지금 발언 방을 빼는 요청 하나')
    await d
    assert.equal(r.c.speakingRoom, null)
    await r.c.setSpeakingRoom(null)
    assert.equal(spy.n('deselect'), 1, 'SD-ENTRY-AFF-DESELECT — 발언 방이 없으면 입구 0(요청 0)')
    assert.equal(affs(r), 1)
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-AFF-RES — 소속 응답마다 ENTRY.res 하나 · ok · p · onPub · onWant(응답한 서버가 지금 발언 방 · 옮겨 갈 방의 서버다)', async () => {
  const spy = spyOn(AB.ENTRY)
  try {
    assert.equal(AB.ENTRY_ALL.res, true)
    const r = await up()
    await three(r)
    const p1 = r.c.setSpeakingRoom('r1')
    await affReply(r, res(['r1', 'r2'], 'r1'))
    await p1
    assert.equal(spy.n('res'), 1, 'SD-ENTRY-AFF-RES — 응답 하나에 ENTRY.res 하나')
    assert.deepEqual(spy.calls['res']![0], [true, 'r1', false, true], 'SD-ENTRY-AFF-RES — 성공 · p = 응답의 pub_room · 발언 방 없음(onPub 거짓) · 옮겨 갈 방의 서버(onWant 참)')
    // 서버를 건너는 전환 — 옛 서버 해제 응답 · 새 서버 선택 응답
    const p3 = r.c.setSpeakingRoom('r3')
    await affReply(r, res(['r1', 'r2'], null))
    assert.deepEqual(spy.calls['res']![1], [true, 'NONE', true, false], 'SD-ENTRY-AFF-RES — 옛 서버 응답: p 없음 · onPub 참 · onWant 거짓')
    await affReply(r, res(['r3'], 'r3'))
    await p3
    assert.deepEqual(spy.calls['res']![2], [true, 'r3', false, true], 'SD-ENTRY-AFF-RES — 새 서버 응답: p = r3 · onWant 참')
    // 실패 응답 · pub_room ⊄ sub_rooms 응답 — 둘 다 ok 거짓
    const p4 = r.c.setSpeakingRoom('r1').catch(() => undefined)
    await affReply(r, res(['r3'], null))
    await affReply(r, { code: 2006, name: 'NOT_AUTHORIZED', permanent: false }, false)
    await p4
    assert.deepEqual(spy.calls['res']![4], [false, 'NONE', false, false], 'SD-ENTRY-AFF-RES — 실패 응답은 ok 거짓')
    const p5 = r.c.setSpeakingRoom('r2').catch((x: unknown) => x)
    await affReply(r, res(['r1'], 'r2'))
    const e = await p5
    assert.deepEqual(spy.calls['res']![5], [false, 'NONE', false, false], 'SD-ENTRY-AFF-RES — pub_room ⊄ sub_rooms 응답은 반영하지 않는다(ok 거짓)')
    assert.ok(e instanceof OxLensError && e.category === 'server', 'SD-ENTRY-AFF-RES — 그 응답은 server 로 던진다(negotiation 아님)')
    assert.equal(spy.n('res'), affs(r), 'SD-ENTRY-AFF-RES — 요청 하나에 응답 입구 하나')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-AFF-JOIN-SELECT①② — 발언 방 · 전환이 없을 때 talk 입장은 ENTRY.joinSelect(select:true) · 있으면 select:false 입장 뒤 setSpeakingRoom(r)(실패해도 방에 남는다)', async () => {
  const spy = spyOn(AB.ENTRY)
  try {
    assert.equal(AB.ENTRY_ALL.joinSelect, true)
    const r = await up()
    // ① 발언 방 없음 · 전환 없음
    const p = r.c.join('ra', { mode: 'talk' })
    await tick()
    assert.deepEqual([spy.calls['joinSelect']!.at(-1), spy.took['joinSelect']!.at(-1)], [['ra'], true], 'SD-ENTRY-AFF-JOIN-SELECT① — 입구 joinSelect 하나 · r = 그 방 · 위가 받는다')
    assert.equal((joinFrame(r.ws, 'ra').body as { select: boolean }).select, true, 'SD-ENTRY-AFF-JOIN-SELECT① — select:true 입장')
    assert.deepEqual([r.core.rooms.aff.st.wait, r.core.rooms.aff.st.want], ['JOIN', 'ra'], 'SD-ENTRY-AFF-JOIN-SELECT① — 입장 응답까지 전환이 떠 있다')
    linkOf(r, SA)
    r.ws.answer(joinFrame(r.ws, 'ra'), joinBody(r, 'ra', { pub: 'ra' }))
    await tick(); await drain(r)
    await p
    assert.deepEqual(spy.calls['implicit']!.at(-1)!.slice(0, 2), ['ra', true], 'SD-ENTRY-AFF-JOIN-SELECT① — 그 응답이 implicit(sel 참)')
    assert.deepEqual([r.core.rooms.aff.st.wait, r.c.speakingRoom?.id], ['NONE', 'ra'], 'SD-ENTRY-AFF-JOIN-SELECT① — implicit 가 기다림을 푼다 · 발언 방 = 그 방')
    assert.equal(affs(r), 0, 'SD-ENTRY-AFF-JOIN-SELECT① — 소속 요청 0')
    // ② 발언 방 있음 — select:false 입장 뒤 setSpeakingRoom(rb) · 전환 실패에도 방에 남는다
    const failed: unknown[] = []
    r.c.on('speakingRoomFailed', (x) => failed.push(x))
    const pb = r.c.join('rb', { mode: 'talk' })
    await tick()
    assert.equal(spy.took['joinSelect']!.at(-1), false, 'SD-ENTRY-AFF-JOIN-SELECT② — 발언 방이 있으면 위가 joinSelect 를 받지 않는다')
    assert.equal((joinFrame(r.ws, 'rb').body as { select: boolean }).select, false, 'SD-ENTRY-AFF-JOIN-SELECT② — select:false 입장')
    r.ws.answer(joinFrame(r.ws, 'rb'), joinBody(r, 'rb', { pub: 'ra' }))
    await tick(); await drain(r)
    const f = await affReply(r, { code: 1006, name: 'CODEC_MISMATCH', permanent: true }, false)
    assert.deepEqual(f.body, { pub_deselect: 'ra', pub_select: 'rb' }, 'SD-ENTRY-AFF-JOIN-SELECT② — 입장 뒤 setSpeakingRoom(rb)')
    const hb = await pb
    assert.deepEqual([hb.state, r.c.speakingRoom?.id, failed.length], ['joined', 'ra', 1], 'SD-ENTRY-AFF-JOIN-SELECT② — 전환이 실패해도 방에 남는다 · 발언 방 그대로 · speakingRoomFailed')
    // ② 전환이 떠 있음 — 응답 전 talk 입장은 select:false
    const sw = r.c.setSpeakingRoom(null)
    await tick()
    const pc = r.c.join('rc', { mode: 'talk' })
    await tick()
    assert.equal(spy.took['joinSelect']!.at(-1), false, 'SD-ENTRY-AFF-JOIN-SELECT② — 전환이 떠 있으면 위가 joinSelect 를 받지 않는다')
    // 시그널링 창 1 — 입장 요청은 소속 응답 뒤에 나간다(본문은 이미 정해졌다)
    await affReply(r, res(['ra', 'rb'], null))
    await sw
    assert.equal((joinFrame(r.ws, 'rc').body as { select: boolean }).select, false, 'SD-ENTRY-AFF-JOIN-SELECT② — 전환이 떠 있으면 select:false')
    r.ws.answer(joinFrame(r.ws, 'rc'), joinBody(r, 'rc'))
    await tick(); await drain(r)
    await affReply(r, res(['ra', 'rb', 'rc'], 'rc'))
    await pc
    assert.equal(r.c.speakingRoom?.id, 'rc', 'SD-ENTRY-AFF-JOIN-SELECT② — 입장 뒤 전환으로 발언 방이 된다')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-AFF-IMPLICIT①② — 입장 응답(위 이음매 aff.implicit)마다 ENTRY.implicit 하나 · p 는 sub_rooms 에 있을 때만 · onPub · 발언 방이 응답만큼 바뀐다(다른 서버의 발언 방은 안 지운다)', async () => {
  const spy = spyOn(AB.ENTRY)
  try {
    assert.deepEqual(AFF.REACTS.implicit, ['ROOM:aff.implicit'], 'SD-ENTRY-AFF-IMPLICIT① — 위가 정한 부르는 곳 하나(ROOM aff.implicit)')
    const r = await up()
    const seen: (string | null)[] = []
    r.c.on('speakingRoom', (x) => seen.push(x?.id ?? null))
    // select:true 입장 — 옛 발언 방 없음
    await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
    assert.equal(spy.n('implicit'), 1, 'SD-ENTRY-AFF-IMPLICIT① — 입장 응답 하나에 ENTRY.implicit 하나')
    assert.deepEqual(spy.calls['implicit']![0], ['r1', true, 'r1', false], 'SD-ENTRY-AFF-IMPLICIT① — r · sel 참 · p = 응답 pub_room · onPub 거짓(발언 방 없음)')
    // 다른 서버 방 select:false 입장 — 그 서버는 발언 방을 모른다
    await enter(r, 'r3', { sc: SB })
    assert.deepEqual(spy.calls['implicit']![1], ['r3', false, 'NONE', false], 'SD-ENTRY-AFF-IMPLICIT① — 다른 서버: p 없음 · onPub 거짓')
    assert.equal(r.c.speakingRoom?.id, 'r1', 'SD-ENTRY-AFF-IMPLICIT② — 다른 서버의 응답은 발언 방을 안 지운다')
    // 같은 서버 select:false 입장 — 응답이 옛 발언 방을 그대로 말한다
    await enter(r, 'r2', { pub: 'r1' })
    assert.deepEqual(spy.calls['implicit']![2], ['r2', false, 'r1', true], 'SD-ENTRY-AFF-IMPLICIT① — 같은 서버의 옛 발언 방 있음: p = r1 · onPub 참')
    assert.equal(r.c.speakingRoom?.id, 'r1', 'SD-ENTRY-AFF-IMPLICIT② — 같은 값이면 그대로')
    // sub_rooms 밖의 pub_room 은 p 가 아니다 · 같은 서버가 발언 방 없음을 말하면 지운다
    await enter(r, 'r4', { pub: 'r9' })
    assert.deepEqual(spy.calls['implicit']![3], ['r4', false, 'NONE', true], 'SD-ENTRY-AFF-IMPLICIT① — pub_room 이 sub_rooms 에 없으면 p 없음')
    assert.equal(r.c.speakingRoom, null, 'SD-ENTRY-AFF-IMPLICIT② — 같은 서버가 발언 방이 없다고 하면 응답만큼 바뀐다')
    // 같은 서버 응답이 다른 방을 발언 방으로 말한다
    await enter(r, 'r5', { pub: 'r2' })
    assert.equal(speakingId(r), 'r2', 'SD-ENTRY-AFF-IMPLICIT② — 응답이 말한 발언 방으로')
    assert.deepEqual(seen, ['r1', null, 'r2'], 'SD-ENTRY-AFF-IMPLICIT② — 바뀐 만큼만 speakingRoom')
    assert.equal(affs(r), 0, 'SD-ENTRY-AFF-IMPLICIT② — 소속 요청 0(입장이 곁들여 바꾼다)')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-AFF-JOIN-FAILED①② — 입장 실패(위 이음매 aff.join_failed)가 ENTRY.joinFailed 하나 · select:true 입장이면 기다림을 풀고 speakingRoomFailed · select:false 면 소속 그대로', async () => {
  const spy = spyOn(AB.ENTRY)
  try {
    assert.deepEqual(AFF.REACTS.joinFailed, ['ROOM:aff.join_failed'], 'SD-ENTRY-AFF-JOIN-FAILED① — 위가 정한 부르는 곳 하나(ROOM aff.join_failed)')
    const r = await up()
    await enter(r, 'r1')
    const failed: OxLensError[] = []
    r.c.on('speakingRoomFailed', (x) => failed.push(x))
    // ① select:true 입장이 권한 실패
    const p = r.c.join('ra', { mode: 'talk' }).catch(() => undefined)
    await tick()
    assert.equal(r.core.rooms.aff.st.wait, 'JOIN')
    r.ws.answer(joinFrame(r.ws, 'ra'), { code: 2006, name: 'NOT_AUTHORIZED', permanent: true }, false)
    await tick()
    await p.catch(() => undefined)
    assert.deepEqual(spy.calls['joinFailed']!.at(-1), ['ra'], 'SD-ENTRY-AFF-JOIN-FAILED① — 입구 joinFailed 하나 · r = 그 방')
    assert.equal(r.core.rooms.aff.st.wait, 'NONE', 'SD-ENTRY-AFF-JOIN-FAILED① — 기다림이 풀린다')
    assert.deepEqual(failed.map((x) => x.code), [2006], 'SD-ENTRY-AFF-JOIN-FAILED① — speakingRoomFailed 하나 · 입장 실패 코드')
    // ① 코덱 실패도 같은 꼴
    const pc = r.c.join('rc', { mode: 'talk' }).catch(() => undefined)
    await tick()
    r.ws.answer(joinFrame(r.ws, 'rc'), { code: 1006, name: 'CODEC_MISMATCH', permanent: true }, false)
    await tick()
    await pc.catch(() => undefined)
    assert.deepEqual([r.core.rooms.aff.st.wait, failed.map((x) => x.code)], ['NONE', [2006, 1006]], 'SD-ENTRY-AFF-JOIN-FAILED① — 코덱 실패: 기다림이 풀리고 speakingRoomFailed')
    const s = r.c.setSpeakingRoom('r1')
    await tick()
    assert.equal(affs(r), 1, 'SD-ENTRY-AFF-JOIN-FAILED① — 다음 setSpeakingRoom() 이 막히지 않는다')
    await affReply(r, res(['r1'], 'r1'))
    await s
    // ② select:false 입장이 실패 — 소속 그대로
    const n = spy.n('joinFailed')
    const pb = r.c.join('rb').catch(() => undefined)
    await tick()
    r.ws.answer(joinFrame(r.ws, 'rb'), { code: 2006, name: 'NOT_AUTHORIZED', permanent: true }, false)
    await tick()
    await pb.catch(() => undefined)
    assert.equal(spy.n('joinFailed'), n + 1, 'SD-ENTRY-AFF-JOIN-FAILED② — select:false 입장 실패도 입구 joinFailed 하나')
    assert.deepEqual([r.core.rooms.aff.st, failed.length], [{ pub: 'r1', wait: 'NONE', want: 'NONE' }, 2], 'SD-ENTRY-AFF-JOIN-FAILED② — 소속 그대로 · speakingRoomFailed 0')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-AFF-LEFT — 듣던 방 떠남(위 이음매 aff.leave)이 ENTRY.left 하나 · SDK 사건으로 넣는 곳 0 · select:true 로 들어가던 방이 응답 전에 내려가면 기다림이 풀린다', async () => {
  const spy = spyOn(AB.ENTRY)
  try {
    assert.deepEqual(AFF.REACTS.left, ['ROOM:aff.leave'], 'SD-ENTRY-AFF-LEFT — 위가 정한 부르는 곳 하나(ROOM aff.leave)')
    const r = await up()
    const ha = await enter(r, 'ra', { mode: 'talk', pub: 'ra' })
    await enter(r, 'rb', { pub: 'ra' })
    const d = r.c.setSpeakingRoom(null)
    await affReply(r, res(['ra', 'rb'], null))
    await d
    const s = r.c.setSpeakingRoom('ra')
    await affReply(r, res(['ra', 'rb'], 'ra'))
    await s
    assert.equal(spy.n('left'), 0, 'SD-ENTRY-AFF-LEFT — SDK 사건(입장 · setSpeakingRoom)으로 넣는 곳 0')
    const l = ha.leave()
    await tick()
    assert.deepEqual(spy.calls['left'], [['ra']], 'SD-ENTRY-AFF-LEFT — 발언 방을 떠나면 입구 left 하나 · r = 그 방')
    assert.equal(r.c.speakingRoom, null, 'SD-ENTRY-AFF-LEFT — 그 방이 발언 방이면 함께 풀린다')
    r.ws.answer(leaveFrame(r.ws, 'ra'), {})
    await l
    assert.equal(spy.n('left'), 1, 'SD-ENTRY-AFF-LEFT — 퇴장 응답으로 다시 넣지 않는다')
    // select:true 로 들어가던 방이 응답 전에 내려감(세션 끝 — rooms.close_all)
    const failed: OxLensError[] = []
    r.c.on('speakingRoomFailed', (x) => failed.push(x))
    const p = r.c.join('rc', { mode: 'talk' }).catch(() => undefined)
    await tick()
    assert.equal(r.core.rooms.aff.st.wait, 'JOIN')
    await r.c.close()
    await p.catch(() => undefined)
    assert.ok(spy.calls['left']!.some((a) => a[0] === 'rc'), 'SD-ENTRY-AFF-LEFT — 내려간 입장 방도 입구 left')
    assert.deepEqual([r.core.rooms.aff.st.wait, failed.length], ['NONE', 1], 'SD-ENTRY-AFF-LEFT — 기다림이 풀린다(AFF.C.any.left_join · speakingRoomFailed)')
  } finally { spy.restore() }
})

// ══ 효과 표 ════════════════════════════════════════════════════════════

test('SD-EFFECT-AFF-APP-AFFILIATION — 위 효과 app.affiliation 은 speakingRoom 이벤트 · client.speakingRoom 갱신 · 기다리던 setSpeakingRoom() resolve(전환이 끝났을 때)', async () => {
  assert.equal(AB.effect('app.affiliation').event, 'speakingRoom', 'SD-EFFECT-AFF-APP-AFFILIATION — 효과 표: app.affiliation → speakingRoom')
  assert.deepEqual(AB.plan(AFF.res({ pub: 'NONE', wait: 'SELECT', want: 'r1' }, true, 'r1', false, true)).events, ['speakingRoom'], 'SD-EFFECT-AFF-APP-AFFILIATION — 결합 코드 plan() 이 낸다')
  const r = await up()
  await enter(r, 'r1')
  await enter(r, 'r3', { sc: SB })
  const seen: (string | null)[] = []
  r.c.on('speakingRoom', (x) => seen.push(x === r.c.speakingRoom ? (x?.id ?? null) : 'stale'))
  let done = false
  const p = r.c.setSpeakingRoom('r1').then(() => { done = true })
  await affReply(r, res(['r1'], 'r1'))
  await p
  assert.deepEqual([seen, done], [['r1'], true], 'SD-EFFECT-AFF-APP-AFFILIATION — speakingRoom 하나(그때 client.speakingRoom 도 그 방) · resolve')
  // 서버를 건너면 — 옛 서버 해제 응답의 app.affiliation 은 이벤트만(전환이 안 끝났다)
  done = false
  const q = r.c.setSpeakingRoom('r3').then(() => { done = true })
  await affReply(r, res(['r1'], null))
  assert.deepEqual([seen, done], [['r1', null], false], 'SD-EFFECT-AFF-APP-AFFILIATION — 옛 서버 해제: speakingRoom(null) · 아직 resolve 안 함')
  await affReply(r, res(['r3'], 'r3'))
  await q
  assert.deepEqual([seen, done, r.c.speakingRoom?.id], [['r1', null, 'r3'], true, 'r3'], 'SD-EFFECT-AFF-APP-AFFILIATION — 새 서버 선택 뒤 resolve')
  await r.c.close()
})

test('SD-EFFECT-AFF-APP-AFF-FAILED — 위 효과 app.aff_failed 는 speakingRoomFailed · 기다리던 setSpeakingRoom() reject · speakingRoom 은 응답이 바꾼 만큼만 · 입장이 건 기다림이면 이벤트만', async () => {
  assert.equal(AB.effect('app.aff_failed').event, 'speakingRoomFailed', 'SD-EFFECT-AFF-APP-AFF-FAILED — 효과 표: app.aff_failed → speakingRoomFailed')
  assert.deepEqual(AB.plan(AFF.res({ pub: 'NONE', wait: 'SELECT', want: 'r1' }, false, 'NONE', false, false)).events, ['speakingRoomFailed'], 'SD-EFFECT-AFF-APP-AFF-FAILED — 결합 코드 plan() 이 낸다')
  const r = await up()
  await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
  await enter(r, 'r2', { pub: 'r1' })
  await enter(r, 'r3', { sc: SB })
  const failed: OxLensError[] = []
  const seen: (string | null)[] = []
  r.c.on('speakingRoomFailed', (x) => failed.push(x))
  r.c.on('speakingRoom', (x) => seen.push(x?.id ?? null))
  // 같은 서버 전환 실패 — 그대로
  const p = r.c.setSpeakingRoom('r2').catch((x: unknown) => x)
  await affReply(r, { code: 1006, name: 'CODEC_MISMATCH', permanent: true }, false)
  const e = await p
  assert.ok(e instanceof OxLensError && e.code === 1006, 'SD-EFFECT-AFF-APP-AFF-FAILED — 기다리던 setSpeakingRoom() 이 그 실패로 reject')
  assert.deepEqual([failed.map((x) => x.code), r.c.speakingRoom?.id, seen], [[1006], 'r1', []], 'SD-EFFECT-AFF-APP-AFF-FAILED — speakingRoomFailed 하나 · 응답이 안 바꿨으니 발언 방 그대로')
  // 서버를 건너다 옛 서버 해제에서 멈춤(응답이 아직 발언 방을 말한다) — 그대로
  const q = r.c.setSpeakingRoom('r3').catch(() => undefined)
  await affReply(r, res(['r1', 'r2'], 'r1'))
  await q
  assert.deepEqual([failed.length, r.c.speakingRoom?.id], [2, 'r1'], 'SD-EFFECT-AFF-APP-AFF-FAILED — 옛 서버 해제에서 멈춤: reject · 발언 방 그대로')
  // 옛 서버 해제는 됐고 새 서버 선택이 실패 — 해제만큼 바뀐다
  const w = r.c.setSpeakingRoom('r3').catch(() => undefined)
  await affReply(r, res(['r1', 'r2'], null))
  await affReply(r, { code: 2006, name: 'NOT_AUTHORIZED', permanent: true }, false)
  await w
  assert.deepEqual([failed.length, r.c.speakingRoom, seen], [3, null, [null]], 'SD-EFFECT-AFF-APP-AFF-FAILED — 응답이 바꾼 만큼만(해제는 반영)')
  // 입장(joinSelect)이 건 기다림 — 이벤트만 · join() 은 입장 결과대로 resolve
  const pj = r.c.join('r4', { mode: 'talk' })
  await tick()
  r.ws.answer(joinFrame(r.ws, 'r4'), joinBody(r, 'r4', { pub: null }))
  await tick(); await drain(r)
  const h: Room = await pj
  assert.deepEqual([h.state, failed.length, r.c.speakingRoom], ['joined', 4, null], 'SD-EFFECT-AFF-APP-AFF-FAILED — 입장이 건 기다림: speakingRoomFailed 만 · join() resolve')
  await r.c.close()
})

// ══ 표면 ══════════════════════════════════════════════════════════════

test('SD-API-CLIENT-SPEAKING-ROOM — pub_room 이 바뀔 때마다 speakingRoom 이벤트 하나 · client.speakingRoom 은 그 방 핸들 · 안 바뀌면 0(서버를 건너도)', async () => {
  const r = await up()
  await three(r)
  const seen: (Room | null)[] = []
  r.c.on('speakingRoom', (x) => seen.push(x))
  assert.equal(r.c.speakingRoom, null)
  const p1 = r.c.setSpeakingRoom('r1')
  await affReply(r, res(['r1', 'r2'], 'r1'))
  await p1
  assert.deepEqual([seen.length, r.c.speakingRoom === r.c.rooms.get('r1'), seen[0] === r.c.rooms.get('r1')], [1, true, true], 'SD-API-CLIENT-SPEAKING-ROOM — 바뀜 하나에 이벤트 하나 · 그 방 핸들')
  const p3 = r.c.setSpeakingRoom('r3')
  await affReply(r, res(['r1', 'r2'], null))
  await affReply(r, res(['r3'], 'r3'))
  await p3
  assert.deepEqual(seen.map((x) => x?.id ?? null), ['r1', null, 'r3'], 'SD-API-CLIENT-SPEAKING-ROOM — 서버 건너기: 바뀜(해제 · 선택)마다 하나')
  r.c.off('speakingRoom')
  const again: unknown[] = []
  r.c.on('speakingRoom', (x) => again.push(x))
  await r.c.setSpeakingRoom('r3')
  assert.deepEqual([again.length, affs(r)], [0, 3], 'SD-API-CLIENT-SPEAKING-ROOM — 안 바뀌면 이벤트 0 · 요청 0')
  await r.c.close()
})

test('SD-API-CLIENT-SET-SPEAKING-ROOM — 전환은 AFFILIATION 만(발언권 REQUEST 0) · 옛 방 has_permission 이면 클라 RELEASE 0(pub_select 가 대신) · 응답 뒤 그 방 no_permission · lastEnd moved', async () => {
  const r = await up()
  const h1 = await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
  await enter(r, 'r2', { pub: 'r1' })
  const media = r.core.media as unknown as { hasHalfMic(): boolean }
  media.hasHalfMic = () => true
  const dc = dcSent(r, SA.sfu_id)
  const floor = r.core.rooms.get('r1')!.floor
  floor.st = { ...floor.st, cs: 'PERM' }
  floor.surface()
  assert.equal(h1.ptt.state.phase, 'has_permission')
  const before = r.ws.frames().filter((x) => x.kind === 'request').length
  const p = r.c.setSpeakingRoom('r2')
  await tick()
  assert.equal(h1.ptt.state.phase, 'has_permission', 'SD-API-CLIENT-SET-SPEAKING-ROOM — SDK 가 먼저 release() 를 내지 않는다(응답 전 그대로)')
  const f = await affReply(r, res(['r1', 'r2'], 'r2'))
  await p
  assert.deepEqual(f.body, { pub_deselect: 'r1', pub_select: 'r2' }, 'SD-API-CLIENT-SET-SPEAKING-ROOM — 같은 서버면 소속 요청 하나')
  const sent = r.ws.frames().filter((x) => x.kind === 'request').slice(before).map((x) => x.op)
  assert.deepEqual(sent, [Op.AFFILIATION], 'SD-API-CLIENT-SET-SPEAKING-ROOM — WS 요청은 AFFILIATION 만(재발행 · 재협상 0)')
  assert.ok(!dc.includes(C.Type.REQUEST) && !dc.includes(C.Type.RELEASE), 'SD-API-CLIENT-SET-SPEAKING-ROOM — 발언권 REQUEST 0 · 클라 RELEASE 0')
  assert.deepEqual([h1.ptt.state.phase, h1.ptt.state.lastEnd], ['no_permission', 'moved'], "SD-API-CLIENT-SET-SPEAKING-ROOM — 응답 뒤 옛 방 no_permission · lastEnd:'moved'")
  assert.equal(r.core.rooms.get('r2')!.floor.st.isPub, true, 'SD-API-CLIENT-SET-SPEAKING-ROOM — 새 방이 발언 방(이음매 floor.pub_select)')
  const e = await r.c.setSpeakingRoom('nowhere').catch((x: unknown) => x)
  assert.ok(e instanceof OxLensError && e.category === 'state', 'SD-API-CLIENT-SET-SPEAKING-ROOM — 들어가 있지 않은 방은 state 로 reject')
  await r.c.close()
})

test('연:RULE-ROOM-JOIN-START 2 — select:true 입장이 떠 있는 동안의 setSpeakingRoom() 은 그 입장 응답을 기다렸다가 낸다(옛 결합은 받지 않는 사건으로 버리고 요청 없이 resolve 했다)', async () => {
  const r = await up()
  await enter(r, 'r1')
  const p = r.c.join('ra', { mode: 'talk' })
  await tick()
  assert.equal(r.core.rooms.aff.st.wait, 'JOIN')
  let done = false
  const s = r.c.setSpeakingRoom('r1').then(() => { done = true })
  await tick()
  assert.deepEqual([affs(r), done], [0, false], '입장 응답 전에는 소속 요청 0 · 기다린다')
  r.ws.answer(joinFrame(r.ws, 'ra'), joinBody(r, 'ra', { pub: 'ra' }))
  await tick(); await drain(r)
  await p
  const f = await affReply(r, res(['r1', 'ra'], 'r1'))
  await s
  assert.deepEqual([f.body, done, r.c.speakingRoom?.id], [{ pub_deselect: 'ra', pub_select: 'r1' }, true, 'r1'], '입장이 정한 발언 방에서 고른 방으로 옮긴다')
  await r.c.close()
})
