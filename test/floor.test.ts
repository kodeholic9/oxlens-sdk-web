// author: kodeholic (powered by Claude)
// SDK:IMPL-FLR-EXPOSE · SDK:IMPL-FLR-TRUST — 발언권 결합. 받은 DC 바이트 → 해석 → 위가 지은 클라 상태기 → ACK · speaker 이벤트를 잰다.
// 모형 한계(연:ASM-FLR-DELIVER-FIRST — 모형은 「사람 동작은 통이 빈 뒤에만」 아래서 화자 표시를 잰다) 밖의 창은 여기서 잰다 — 받아들인 경주의 결말.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/internal/wire/floor_codec.js'
import * as Mbcp from '../src/internal/mbcp.js'
import * as FLR from '../src/domain/gen/floor_client.js'
import { RoomCore } from '../src/domain/rooms.js'
import type { Core } from '../src/domain/session.js'

interface Rig { room: RoomCore; speakers: (string | null)[]; acks: number[]; rx(m: C.Message): void }

function rig(): Rig {
  const acks: number[] = []
  const peer = {
    sendDc: (b: Uint8Array) => {
      const m = C.decode(Mbcp.unwrap(b)!)!
      if (m.type === C.Type.ACK) acks.push(C.readAck(m).value!.of!)
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
const granted = (): C.Message => C.buildGranted({ priority: 0, duration: 30, room: 'ch-3' })

test('연:RULE-FLR-SEQ — 클라는 일련번호를 보지 않는다: 받은 차례대로 화자 표시에 쓰고 · ACK 은 종류만 싣는다', () => {
  const r = rig()
  r.rx(taken('u2', 40000))
  r.rx(taken('u3', 3))
  r.rx(idle(2))
  assert.deepEqual(r.speakers, ['u2', 'u3', null], '번호(40000 · 3 · 2)와 상관없이 닿은 차례대로')
  assert.deepEqual(r.acks, [C.Type.TAKEN, C.Type.TAKEN])
  r.room.floor.dispose()
})

test('연:RACE-FLR-LATE-TAKEN — 늦게 닿은 TAKEN 은 화면을 앞 화자로 되돌리고(받아들인다) · 다음 IDLE 이 바로잡는다', () => {
  const r = rig()
  r.rx(taken('u2', 5))
  r.rx(idle(6))
  r.rx(taken('u2', 5))
  assert.deepEqual(r.speakers, ['u2', null, 'u2'], '늦은 TAKEN 이 앞 화자를 다시 보인다')
  r.rx(idle(7))
  assert.deepEqual(r.speakers, ['u2', null, 'u2', null], '다음 사건이 바로잡는다')
  r.room.floor.dispose()
})

test('연:RACE-FLR-T21-COPY — 반환 중에 닿은 옛 TAKEN 사본은 반환 확인이다(받아들인다) · 다음 TAKEN 이 바로잡는다', async () => {
  const r = rig()
  r.rx(taken('u2', 5))
  r.room.floor.st = { ...r.room.floor.st, cs: 'PREQ', want: true }
  r.rx(granted())
  await r.room.floor.release()
  assert.equal(r.room.floor.st.cs, 'PREL')
  r.rx(taken('u2', 5))
  assert.equal(r.room.floor.st.cs, 'NOPERM', '사본(번호도 같은 TAKEN)을 반환 확인으로 쓴다')
  assert.equal(r.speakers.at(-1), 'u2', '앞 화자가 보인다 — 직전 화자에게는 IDLE 이 가지 않는다')
  r.rx(taken('u4', 9))
  assert.equal(r.speakers.at(-1), 'u4')
  r.room.floor.dispose()
})

test('연:RACE-FLR-LATE-BCAST-IDLE · 연:RACE-FLR-UNICAST-OVERTAKES-BROADCAST — 대기 중 늦은 IDLE 에 대기를 떠나고(받아들인다) · 그 뒤 허가는 버린다', () => {
  const r = rig()
  r.rx(taken('u2', 5))
  r.room.floor.st = { ...r.room.floor.st, cs: 'QUEUED', sub: 'WAIT', want: true }
  r.rx(idle(4))
  assert.equal(r.room.floor.st.cs, 'NOPERM', '원문 6.2.4.9.8 — 대기를 떠난다')
  assert.equal(r.speakers.at(-1), null)
  const before = r.acks.length
  r.rx(granted())
  assert.equal(r.room.floor.st.cs, 'NOPERM', '서버가 차례에 준 허가를 버린다 — 채널은 서버의 T20 · T1 이 푼다(서버 1층 flr_limits)')
  assert.equal(r.acks.length, before)
  r.room.floor.dispose()
})

test('연:FLR.C.PREQ.rx_GRANTED — 허가를 받으면 앞 화자 표시를 내린다(대장 C-31 ①)', () => {
  const r = rig()
  r.rx(taken('u2', 5))
  r.room.floor.st = { ...r.room.floor.st, cs: 'PREQ', want: true }
  r.rx(granted())
  assert.deepEqual(r.speakers, ['u2', null])
  r.room.floor.dispose()
})

test('연:FLR.C.QUEUED.rx_GRANTED · 연:DEV-FLR-T132-DISPLAY — 대기 중 승계 허가에 화자 표시를 내린다(대장 C-31 ①)', () => {
  const r = rig()
  r.rx(taken('u2', 5))
  r.room.floor.st = { ...r.room.floor.st, cs: 'QUEUED', sub: 'WAIT', want: true }
  r.rx(granted())
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

test('연:FLR.C.any.down · 연:DEV-FLR-DOWN-FRESH — 재구축은 앱에 화자 없음을 알린다(DC 가 없어 통지가 오지 않는다)', () => {
  const r = rig()
  r.rx(taken('u2', 20000))
  r.room.floor.down()
  assert.deepEqual(r.speakers, ['u2', null], '재구축 앞의 화자가 앱에 남지 않는다')
  r.rx(taken('u3', 3))
  assert.deepEqual(r.speakers, ['u2', null, 'u3'])
  r.room.floor.dispose()
})
