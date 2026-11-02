// author: kodeholic (powered by Claude)
// SDK:IMPL-FLR-EXPOSE · SDK:IMPL-FLR-TRUST — 발언권 결합. 받은 DC 바이트 → 해석 → 위가 지은 클라 상태기 → ACK · speaker 이벤트를 잰다.
// 모형 한계(연:ASM-FLR-DELIVER-FIRST — 모형은 「사람 동작은 통이 빈 뒤에만」 아래서 화자 표시를 잰다) 밖의 창은 여기서 잰다 — 받아들인 경주의 결말.
// 다른 모형 한계(연:ASM-FLR-HUMAN-SPEED · 연:ASM-FLR-STALE-GUARD · 연:ASM-FLR-T20-OVER-RTP · 연:ASM-FLR-TIMER-EMPTY)가 깨질 때 클라가 하는 일도 여기서 잰다(서버 쪽 결말은 oxlens-sfu tests/flr_limits.rs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/internal/wire/floor_codec.js'
import * as Mbcp from '../src/internal/mbcp.js'
import * as FLR from '../src/domain/gen/floor_client.js'
import { RoomCore } from '../src/domain/room/core.js'
import type { Core } from '../src/domain/ses/core.js'

interface Rig { room: RoomCore; speakers: (string | null)[]; acks: number[]; sent: number[]; rx(m: C.Message): void }

function rig(): Rig {
  const acks: number[] = []
  const sent: number[] = []
  const peer = {
    sendDc: (b: Uint8Array) => {
      const m = C.decode(Mbcp.unwrap(b)!)!
      sent.push(m.type)
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
    room, speakers, acks, sent,
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

test('연:RACE-FLR-LATE-BCAST-IDLE · 연:RACE-FLR-UNICAST-OVERTAKES-BROADCAST · 연:RACE-FLR-LATE-CONFIRM-IDLE — 대기 중 늦은 IDLE 에 대기를 떠나고(받아들인다) · 그 뒤 허가는 버린다', () => {
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

const revoke = (): C.Message => C.buildRevoke({ cause: 4, room: 'ch-3' })
const expire = (r: Rig, t: FLR.TimerName): void => r.room.floor.flrStep(`expire.${t}`, FLR.expire(r.room.floor.st, t), 'timer')

test('연:ASM-FLR-T20-OVER-RTP · 연:ASM-FLR-TIMER-EMPTY — 발언 중에 다시 온 GRANTED(T20 · 재요청 응답)는 ACK 만 하고 상태를 두지 않는다', () => {
  const r = rig()
  r.room.floor.st = { ...r.room.floor.st, cs: 'PREQ', want: true }
  r.rx(granted())
  assert.equal(r.room.floor.st.cs, 'PERM')
  const before = r.acks.length
  r.rx(granted())
  assert.equal(r.room.floor.st.cs, 'PERM')
  assert.deepEqual(r.acks.slice(before), [C.Type.GRANTED])
  r.room.floor.dispose()
})

test('연:RACE-FLR-TAP-OVERTAKE · 연:ASM-FLR-HUMAN-SPEED — 반환 확인 뒤 늦은 요청의 GRANTED 는 버린다(서버는 T1 으로 푼다)', () => {
  const r = rig()
  r.room.floor.st = { ...r.room.floor.st, cs: 'PREL' }
  r.rx(idle(3))
  assert.equal(r.room.floor.st.cs, 'NOPERM')
  const before = r.sent.length
  r.rx(granted())
  assert.equal(r.room.floor.st.cs, 'NOPERM', '원문 6.2.4.3 — has no permission 은 GRANTED 를 받지 않는다')
  assert.equal(r.sent.length, before, 'ACK 도 하지 않는다')
  r.room.floor.dispose()
})

test('연:RACE-FLR-T101-OVERTAKE · 연:ASM-FLR-STALE-GUARD — T101 이 REQUEST 를 다시 보낸 뒤 떼면 반환으로 가고 · 늦은 GRANTED 는 버린다', () => {
  const r = rig()
  r.room.floor.st = { ...r.room.floor.st, cs: 'PREQ', want: true, c101: 1 }
  expire(r, 'T101')
  assert.equal(r.sent.at(-1), C.Type.REQUEST, 'T101 이 REQUEST 를 다시 보낸다')
  r.room.floor.flrStep('release', FLR.release(r.room.floor.st), 'user')
  assert.equal(r.room.floor.st.cs, 'PREL')
  assert.equal(r.sent.at(-1), C.Type.RELEASE)
  r.rx(idle(4))
  r.rx(granted())
  assert.equal(r.room.floor.st.cs, 'NOPERM')
  r.room.floor.dispose()
})

test('연:RACE-FLR-LATE-GRANTED — 다시 누른 뒤 닿은 옛 GRANTED 를 새 요청의 답으로 읽는다(받아들인다 — 요청 식별자가 없다)', () => {
  const r = rig()
  r.room.floor.st = { ...r.room.floor.st, cs: 'PREQ', want: true }
  r.rx(granted())
  assert.equal(r.room.floor.st.cs, 'PERM', '원문 6.2.4.4.2')
  r.room.floor.dispose()
})

test('연:RACE-FLR-T132-PREEMPT — 승계 의지 대기 중 REVOKE 는 버리고(원문 6.2.4.9 에 절 없음) · 수락 뒤 다시 온 REVOKE 로 반환한다', () => {
  const r = rig()
  r.room.floor.st = { ...r.room.floor.st, cs: 'QUEUED', sub: 'GRANTED', want: true }
  r.rx(revoke())
  assert.equal(r.room.floor.st.cs, 'QUEUED', 'REVOKE 를 버린다')
  r.room.floor.flrStep('intent', FLR.intent(r.room.floor.st), 'press')
  assert.equal(r.room.floor.st.cs, 'PERM')
  r.rx(revoke())
  assert.equal(r.room.floor.st.cs, 'PREL', 'T8 재전송 REVOKE 가 닿으면 반환한다(ASM-FLR-T8-OVER-T132 — 마지막 재전송은 T132 뒤)')
  assert.equal(r.sent.at(-1), C.Type.RELEASE)
  r.room.floor.dispose()
})

test('연:RACE-FLR-LOST-GRANTED-PREEMPT · 연:RACE-FLR-LATE-RELEASE — 서버 대기열에서 빠진 대기 클라는 REVOKE 를 버리고 · TAKEN 에 화자만 바꾸고 · 다음 IDLE 에 대기를 떠난다', () => {
  const r = rig()
  r.room.floor.st = { ...r.room.floor.st, cs: 'QUEUED', sub: 'WAIT', want: true }
  r.rx(revoke())
  assert.equal(r.room.floor.st.cs, 'QUEUED')
  r.rx(taken('u3', 7))
  assert.equal(r.room.floor.st.cs, 'QUEUED')
  assert.equal(r.speakers.at(-1), 'u3')
  r.rx(idle(8))
  assert.equal(r.room.floor.st.cs, 'NOPERM', '다음 IDLE 이 푼다')
  r.room.floor.dispose()
})

test('연:RACE-FLR-DC-STALE — DC 만 끊긴 사이 회수를 놓친 발언자는 앱에 믿을 수 없음을 알리고 · 다시 열려도 발언 중으로 남다가 · 떼면 풀린다', () => {
  const r = rig()
  r.room.floor.st = { ...r.room.floor.st, cs: 'PERM', want: true }
  r.room.floor.dcDown()
  assert.equal(r.room.floor.snapshot().trusted, false, 'app.floor_unreliable')
  r.room.floor.dcUp()
  assert.equal(r.room.floor.snapshot().trusted, true)
  assert.equal(r.room.floor.st.cs, 'PERM', '회수를 모른 채 남는다(받아들인다)')
  r.room.floor.flrStep('release', FLR.release(r.room.floor.st), 'user')
  assert.equal(r.room.floor.st.cs, 'PREL')
  r.rx(idle(9))
  assert.equal(r.room.floor.st.cs, 'NOPERM', '서버의 반환 확인 IDLE 이 푼다')
  r.room.floor.dispose()
})
