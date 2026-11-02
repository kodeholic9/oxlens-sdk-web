// author: kodeholic (powered by Claude)
// SDK:IMPL-ROOM-API — 방 결합. 위가 지은 방 상태기 둘레의 손 결합(보관본 · 보내는 몸통)을 잰다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as ROOM from '../src/domain/gen/room_client.js'
import * as AFF from '../src/domain/gen/aff_client.js'
import { RoomCore } from '../src/domain/rooms.js'
import type { MemberInfo, Permission, RoomSnapshot } from '../src/internal/wire/ws.js'
import type { Core } from '../src/domain/session.js'

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
  joined(core).sendReady()
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
  Object.assign(f.core, { aff: AFF.initial(), affStep: () => undefined, rooms: new Map(), roomsOn: () => [], linkFor: () => undefined })
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
  assert.equal(room.trk.lay['tA' as never], undefined)
  room.delta('TRACK_EVENT', track(4))
  assert.equal(room.trk.lay['tA' as never], 'ACTIVE')
})
