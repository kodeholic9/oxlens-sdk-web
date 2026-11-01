// author: kodeholic (powered by Claude)
// SDK:IMPL-FLR-EXPOSE · SDK:IMPL-FLR-TRUST — 발언권 결합. 받은 DC 바이트 → 해석 → 위가 지은 클라 상태기 → ACK · speaker 이벤트를 잰다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/internal/wire/floor_codec.js'
import * as Mbcp from '../src/internal/mbcp.js'
import * as FLR from '../src/domain/gen/floor_client.js'
import { RoomCore } from '../src/domain/rooms.js'
import type { Core } from '../src/domain/session.js'

interface Rig { room: RoomCore; speakers: (string | null)[]; acks: { of: number; seq?: number }[]; rx(m: C.Message): void }

function rig(): Rig {
  const acks: { of: number; seq?: number }[] = []
  const peer = {
    sendDc: (b: Uint8Array) => {
      const m = C.decode(Mbcp.unwrap(b)!)!
      if (m.type === C.Type.ACK) { const a = C.readAck(m).value!; acks.push(a.seq === undefined ? { of: a.of! } : { of: a.of!, seq: a.seq }) }
      return true
    },
  }
  const core = {
    cfg: { wakeDetectMs: 1000 },
    record: () => undefined,
    impossible: (layer: string, key: string, from: string, entry: string) => { throw new Error(`받지 않는 사건 ${layer} ${key} ${from} ${entry}`) },
    linkFor: () => ({ peer }),
    log: { debug: () => undefined, warn: () => undefined, error: () => undefined },
    media: { hasHalfMic: () => true, halfMicCold: () => false, floorClose: () => undefined, floorOpen: () => undefined },
  } as unknown as Core
  const room = new RoomCore(core, 'ch-3', {})
  const speakers: (string | null)[] = []
  room.floor.events.on('speaker', (s) => speakers.push(s.userId))
  return {
    room, speakers, acks,
    rx: (m) => { const got = Mbcp.parse(Mbcp.wrap(C.encode(m)))!; room.floor.receive(got.rx) },
  }
}

const taken = (speaker: string, seq: number): C.Message => C.buildTaken({ speaker, seq, room: 'ch-3' })
const idle = (seq: number): C.Message => C.buildIdle({ seq, room: 'ch-3' })
const granted = (seq: number): C.Message => C.buildGranted({ priority: 0, duration: 30, seq, room: 'ch-3' })

test('연:DEV-FLR-SEQ-DISPLAY · 연:DEV-FLR-ACK-SEQ — 화자 표시는 새 번호만 · 낡은 TAKEN 에도 ACK 은 그 번호로(대장 C-29)', () => {
  const r = rig()
  r.rx(taken('u2', 5))
  r.rx(taken('u3', 3))
  r.rx(idle(4))
  assert.deepEqual(r.speakers, ['u2'], '낡은 TAKEN · IDLE 은 표시에 쓰지 않는다')
  assert.deepEqual(r.acks, [{ of: C.Type.TAKEN, seq: 5 }, { of: C.Type.TAKEN, seq: 3 }])
  r.rx(idle(6))
  assert.deepEqual(r.speakers, ['u2', null])
  for (const [u, q] of [['u4', 30000], ['u5', 60000], ['u6', 65535], ['u7', 2]] as const) r.rx(taken(u, q))
  assert.deepEqual(r.speakers, ['u2', null, 'u4', 'u5', 'u6', 'u7'], '감김(65535 → 2)은 새것이다')
  r.rx(taken('u8', 65534))
  assert.equal(r.speakers.at(-1), 'u7', '감김 너머의 옛 번호(65534)는 낡았다')
  r.room.floor.dispose()
})

test('연:DEV-FLR-GRANTED-SEQ · 연:DEV-FLR-T21-SAME-SEQ — GRANTED 의 번호를 본 번호로 삼고 · 반환 중 이미 본 번호의 TAKEN 은 반환 확인이 아니다(ACK 만 · 대장 C-29)', async () => {
  const r = rig()
  r.rx(taken('u2', 5))
  r.room.floor.st = { ...r.room.floor.st, cs: 'PREQ', want: true }
  r.rx(granted(9))
  assert.equal(r.room.floor.st.seen, 9)
  await r.room.floor.release()
  assert.equal(r.room.floor.st.cs, 'PREL')
  r.rx(taken('u3', 8))
  assert.equal(r.room.floor.st.cs, 'PREL', '옛 TAKEN 으로 반환이 끝나지 않는다')
  assert.deepEqual(r.acks.at(-1), { of: C.Type.TAKEN, seq: 8 })
  r.rx(taken('u3', 10))
  assert.equal(r.room.floor.st.cs, 'NOPERM')
  assert.equal(r.speakers.at(-1), 'u3')
  r.room.floor.dispose()
})

test('연:FLR.C.PREQ.rx_GRANTED — 허가를 받으면 앞 화자 표시를 내린다(대장 C-31 ①)', () => {
  const r = rig()
  r.rx(taken('u2', 5))
  r.room.floor.st = { ...r.room.floor.st, cs: 'PREQ', want: true }
  r.rx(granted(5))
  assert.deepEqual(r.speakers, ['u2', null])
  r.room.floor.dispose()
})

test('연:FLR.C.QUEUED.rx_GRANTED · 연:DEV-FLR-T132-DISPLAY — 대기 중 승계 허가에 화자 표시를 내린다(대장 C-31 ①)', () => {
  const r = rig()
  r.rx(taken('u2', 5))
  r.room.floor.st = { ...r.room.floor.st, cs: 'QUEUED', sub: 'WAIT', want: true }
  r.rx(granted(5))
  assert.deepEqual(r.speakers, ['u2', null])
  assert.equal(r.room.floor.st.sub, 'GRANTED')
  r.room.floor.flrStep('intent', FLR.intent(r.room.floor.st), 'press')
  assert.equal(r.room.floor.st.cs, 'PERM')
  assert.deepEqual(r.speakers, ['u2', null], '수락은 표시를 다시 바꾸지 않는다')
  r.room.floor.dispose()
})

test('연:FLR.C.any.pub_away — 발행 방을 떠나도 그 방 화자 표시는 그대로다(대장 C-31 ②)', () => {
  const r = rig()
  r.rx(taken('u2', 5))
  r.room.floor.pubAway()
  assert.equal(r.room.floor.st.shown, 'u2')
  assert.deepEqual(r.speakers, ['u2'])
  r.room.floor.dispose()
})
