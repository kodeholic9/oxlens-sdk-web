// author: kodeholic (powered by Claude)
// SDK:IMPL-MOD-TABLE domain/links — 위가 지은 미디어 연결 복구 상태기. 모형 한계 밖의 받아들인 경주(연:RACE-LINK-STALE-SUSPECT)의 결말을 잰다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as LINK from '../src/domain/gen/link_client.js'

test('연:RACE-LINK-STALE-SUSPECT — ICE 가 스스로 회복한 뒤 닿은 같은 세대의 suspect 는 복구를 한 번 더 시작한다(받아들인다 — 쓸데없는 ICE 재시작 한 번)', () => {
  let s = LINK.initial()
  s = LINK.iceDisc(s, false).s
  assert.equal(s.ls, 'WAIT')
  s = LINK.iceBack(s)!.s
  assert.equal(s.ls, 'OK', 'ICE 가 스스로 풀렸다 — 재시작이 없어 세대(ufrag)는 그대로다')
  const late = LINK.linkEvent(s, { ufrag: s.gen })
  assert.equal(late.label, 'LINK.C.OK.link_event', '흔들리던 때 낸 suspect 가 세대 견주기를 지난다')
  assert.deepEqual(late.out, [{ ws: 'HEARTBEAT', part: 'req' }])
  const alive = LINK.hbRes(late.s, {})
  assert.deepEqual(alive.out, [{ ws: 'ICE_RESTART', part: 'req' }], '멀쩡한 연결에 ICE 재시작 한 번')
  assert.equal(alive.s.dc, true, 'DTLS · 발언권 채널은 그대로다')
  assert.equal(alive.s.assoc, true)
  const older = LINK.linkEvent({ ...s, gen: s.gen + 1 }, { ufrag: s.gen })
  assert.equal(older.label, 'LINK.C.any.link_event_stale', 'ICE 재시작을 거친 세대의 옛 suspect 는 버린다 — 세대가 가르는 것은 이것뿐이다')
})
