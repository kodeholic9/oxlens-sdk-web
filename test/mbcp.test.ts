// author: kodeholic (powered by Claude)
// 연:TRN.frame.DC · 연:RULE-FLR-HEADER~TLV — 판정 근거는 규격 벡터(oxlens-spec/vectors/mbcp.json)와 생성 codec 이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as C from '../src/internal/wire/floor_codec.js'
import * as Mbcp from '../src/internal/mbcp.js'

declare const __SPEC_VECTORS__: string

interface Vector {
  readonly name: string
  readonly hex: string
  readonly expect: { type?: number; ack?: boolean; tlvs?: { id: number; hex: string }[]; drop?: boolean; reencode?: boolean }
}

const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))
const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

test('규격 벡터 전량 — 생성 codec 이 읽고 다시 싣는다', () => {
  const doc = JSON.parse(readFileSync(join(__SPEC_VECTORS__, 'mbcp.json'), 'utf8')) as { cases: Vector[] }
  assert.ok(doc.cases.length > 0)
  for (const c of doc.cases) {
    const got = C.decode(bytes(c.hex))
    if (c.expect.drop) { assert.equal(got, null, c.name); continue }
    assert.ok(got, c.name)
    assert.equal(got.type, c.expect.type, `${c.name}: type`)
    assert.equal(got.ack, c.expect.ack, `${c.name}: A`)
    assert.deepEqual(got.fields.map((f) => ({ id: f.id, hex: hexOf(f.value) })), c.expect.tlvs, `${c.name}: TLV`)
    if (c.expect.reencode !== false) assert.equal(hexOf(C.encode(got)), c.hex, `${c.name}: 왕복`)
  }
})

test('연:TRN.frame.DC — ver · svc 0x01 · len(BE) · 잘린 프레임은 조용히 버린다', () => {
  const f = Mbcp.release('r1')
  assert.equal(hexOf(f.subarray(0, 4)), '01010006')
  assert.equal(Mbcp.unwrap(f.subarray(0, 5)), null)
  assert.equal(Mbcp.unwrap(Uint8Array.of(1, 2, 0, 0)), null, '발언권 svc 만 푼다')
})

test('연:RULE-FLR-TLV — 우선순위 0(보통)은 싣지 않는다 · 실으면 값 + 예비', () => {
  assert.equal(hexOf(Mbcp.unwrap(Mbcp.request('r1', 0))!), '00011d027231')
  assert.equal(hexOf(Mbcp.unwrap(Mbcp.request('r1', 5))!), '00021d0272310002' + '0500')
})

test('연:RULE-FLR-ROOM-KEY — 방 키는 0x1D 단일 · 없으면 버린다', () => {
  const taken = Mbcp.wrap(C.encode(C.buildTaken({ speaker: 'u2', seq: 7, room: 'ch-3' })))
  assert.deepEqual(Mbcp.parse(taken), { room: 'ch-3', rx: { t: 'TAKEN', ack: true, speaker: 'u2', seq: 7 } })
  const noRoom = Mbcp.wrap(C.encode({ type: C.Type.TAKEN, ack: true, fields: [{ id: C.TlvId.SPEAKER, value: Uint8Array.of(0x75) }, { id: C.TlvId.SEQ, value: Uint8Array.of(0, 7) }] }))
  assert.equal(Mbcp.parse(noRoom), null)
})

test('연:RULE-FLR-MSG-TYPES — ACK 은 받은 종류 · 일련번호를 되돌린다', () => {
  const m = C.decode(Mbcp.unwrap(Mbcp.ack('r1', 'GRANTED', 9))!)!
  assert.equal(m.type, C.Type.ACK)
  assert.deepEqual(C.readAck(m).value, { of: C.Type.GRANTED, seq: 9, room: 'r1' })
})
