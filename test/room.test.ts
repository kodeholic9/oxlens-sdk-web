// author: kodeholic (powered by Claude)
// SDK:IMPL-ROOM-API — 방 결합. 위가 지은 방 상태기 둘레의 손 결합(보관본 · 보내는 몸통)을 잰다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as ROOM from '../src/domain/gen/room_client.js'
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
