// author: kodeholic (powered by Claude)
// 연§11 codec — 판정 근거는 규격 벡터 정본(oxlens-spec/vectors/mbcp.json)이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DC_MAX_PAYLOAD, Tlv, Type, byte, decode, encode, frame, short, str, text, u16, u8, unframe,
} from '../src/internal/mbcp.js'

declare const __SPEC_VECTORS__: string

interface Vector {
  readonly name: string
  readonly hex: string
  readonly expect: {
    type?: number
    ack?: boolean
    tlvs?: { id: number; hex: string }[]
    drop?: boolean
    reencode?: boolean
  }
}

const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))
const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

test('규격 벡터 전량 — 하나라도 빠지면 실패다', () => {
  const doc = JSON.parse(readFileSync(join(__SPEC_VECTORS__, 'mbcp.json'), 'utf8')) as { cases: Vector[] }
  assert.ok(doc.cases.length > 0)
  for (const c of doc.cases) {
    const raw = bytes(c.hex)
    const got = decode(raw)
    if (c.expect.drop) {
      assert.equal(got, null, `${c.name}: 버려야 하는데 읽었다`)
      continue
    }
    assert.ok(got, `${c.name}: 읽어야 하는데 버렸다`)
    assert.equal(got.type, c.expect.type, `${c.name}: type`)
    assert.equal(got.ack, c.expect.ack, `${c.name}: A 비트`)
    assert.deepEqual(
      got.fields.map((f) => ({ id: f.id, hex: hexOf(f.value) })),
      c.expect.tlvs,
      `${c.name}: TLV`,
    )
    if (c.expect.reencode !== false) {
      assert.equal(hexOf(encode(got)), c.hex, `${c.name}: 다시 실으면 같은 바이트다`)
    }
  }
})

test('A 비트와 Type 은 한 바이트에 나눠 담긴다', () => {
  const granted = encode({ type: Type.Granted, ack: true, fields: [] })
  assert.equal(granted[0], 0x11, '합치면 원문의 5비트 subtype 이다')
  assert.equal(encode({ type: Type.Taken, ack: false, fields: [] })[0], 0x02)
})

test('모르는 TLV 는 버리지 않고 그대로 담는다', () => {
  const msg = decode(bytes('0002400201021d027231'))!
  assert.deepEqual(msg.fields.map((f) => f.id), [0x40, Tlv.Room])
  assert.equal(text(msg, Tlv.Room), 'r1', '필드를 더해도 구버전이 안 깨진다')
})

test('순서는 계약이 아니다', () => {
  const a = decode(bytes('00021d027231000105'))!
  assert.equal(text(a, Tlv.Room), 'r1')
  assert.equal(u8(a, Tlv.Priority), 5)
})

test('잘렸으면 거기까지 읽고 멈춘다', () => {
  const msg = decode(bytes('020308020007040275321d02'))!
  assert.equal(u16(msg, Tlv.Seq), 7)
  assert.equal(text(msg, Tlv.Speaker), 'u2')
  assert.equal(text(msg, Tlv.Room), undefined, '잘린 것은 없는 것이다')
})

test('우리가 안 쓰는 종류와 다른 버전은 버린다', () => {
  assert.equal(decode(bytes('0700')), null, '미채택 번호를 다른 뜻으로 읽지 않는다')
  assert.equal(decode(bytes('4000')), null)
  assert.equal(decode(bytes('0b00')), null)
  assert.equal(decode(Uint8Array.of(0x00)), null)
})

test('필드 도우미는 형을 지킨다', () => {
  const msg = decode(encode({
    type: Type.Granted, ack: true,
    fields: [short(Tlv.Duration, 30), byte(Tlv.Priority, 7), str(Tlv.Room, 'r1')],
  }))!
  assert.equal(u16(msg, Tlv.Duration), 30)
  assert.equal(u8(msg, Tlv.Priority), 7)
  assert.equal(text(msg, Tlv.Room), 'r1')
  assert.equal(u16(msg, Tlv.Priority), undefined, '한 바이트를 u16 으로 읽지 않는다')
})

test('TLV 값은 255바이트 이하다', () => {
  assert.throws(() => encode({ type: Type.Request, ack: false, fields: [str(Tlv.Room, 'x'.repeat(256))] }),
    RangeError, 'len 이 1바이트라 그 위는 실을 수가 없다')
})

test('DC 프레임은 ver·svc·len 뒤에 payload 다', () => {
  const payload = encode({ type: Type.Request, ack: false, fields: [str(Tlv.Room, 'r1')] })
  const wire = frame(payload)
  assert.deepEqual([...wire.subarray(0, 4)], [1, 1, 0, payload.length])
  const back = unframe(wire)!
  assert.equal(back.svc, 1)
  assert.deepEqual([...back.payload], [...payload])
})

test('잘린 DC 프레임은 조용히 버린다', () => {
  assert.equal(unframe(Uint8Array.of(1, 1, 0)), null, '예외를 던지지 않는다')
  assert.equal(unframe(Uint8Array.of(1, 1, 0, 9, 1, 2)), null)
  assert.equal(unframe(Uint8Array.of(2, 1, 0, 0)), null, 'ver 이 다르면 우리 것이 아니다')
})

test('DC payload 상한을 넘으면 보내는 쪽이 거부한다', () => {
  assert.throws(() => frame(new Uint8Array(DC_MAX_PAYLOAD + 1)), RangeError)
})
