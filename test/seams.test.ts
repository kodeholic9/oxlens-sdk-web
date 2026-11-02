// author: kodeholic (powered by Claude)
// SDK:IMPL-MOD-TABLE 영역 사이 이음매 — 위(생성 상태기)가 낸 이음매 효과가 손 결합에서 받는 영역의 입구에 닿는가.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as ROOM from '../src/domain/gen/room_client.js'
import * as FLR from '../src/domain/gen/floor_client.js'
import { RoomCore } from '../src/domain/rooms.js'
import type { Core } from '../src/domain/ses/core.js'

function fakeCore(): Core {
  return {
    cfg: { wakeDetectMs: 1000 },
    record: () => undefined,
    impossible: (layer: string, key: string, from: string, entry: string) => { throw new Error(`받지 않는 사건 ${layer} ${key} ${from} ${entry}`) },
    linkFor: () => undefined,
    log: { debug: () => undefined, warn: () => undefined, error: () => undefined },
    media: { hasHalfMic: () => false, halfMicCold: () => true, floorClose: () => undefined, floorOpen: () => undefined },
  } as unknown as Core
}

type Seamed = { roomSeam(fx: ROOM.SeamFx, label: string): void }

test('연:FLR.C.any.join — ROOM 이 발언권으로 보내는 이음매는 전부 발언권 입구에 닿는다(대장 C-53 ②)', () => {
  const toFloor = Object.entries(ROOM.SEAMS).filter(([, s]) => s.to === 'FLR') as [ROOM.SeamFx, { react: readonly (keyof typeof FLR.PROC_ENTRY)[] }][]
  assert.ok(toFloor.some(([fx]) => fx === 'floor.join'), '위가 floor.join 을 낸다')
  for (const [fx, s] of toFloor) {
    const room = new RoomCore(fakeCore(), 'r1', {})
    const entries: string[] = []
    const step = room.floor.flrStep.bind(room.floor)
    room.floor.flrStep = (entry, st, cause) => { entries.push(entry); step(entry, st, cause) }
    ;(room as unknown as Seamed).roomSeam(fx, 'test')
    assert.deepEqual(entries, s.react.map((r) => FLR.PROC_ENTRY[r]), `${fx} 를 받는 자리가 없다`)
  }
})

test('연:FLR.C.any.join — 떠난 방에 다시 들면 그 방 발언권 클라가 떠난 채로 남지 않는다', () => {
  const room = new RoomCore(fakeCore(), 'r1', {})
  const seam = (room as unknown as Seamed).roomSeam.bind(room)
  seam('floor.leave', 'ROOM.C.JOINED.not_in_sub_rooms')
  assert.equal(room.floor.st.left, true)
  seam('floor.join', 'ROOM.C.JOINING.join_ok')
  assert.equal(room.floor.st.left, false)
})
