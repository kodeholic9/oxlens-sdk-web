// author: kodeholic (powered by Claude)
// 연:TRN.frame.WS codec — 판정 근거는 규격 벡터(oxlens-spec/vectors/frame.json)다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeFrame, encodeFrame, FrameError, MAX_FRAME } from '../src/internal/signaling.js'

declare const __SPEC_VECTORS__: string

interface Vector {
  readonly name: string
  readonly hex: string
  readonly expect: { kind?: string; op?: number; pid?: number; reserved?: number; body?: unknown; error?: boolean }
}

const KIND: Record<string, string> = { msg: 'request', ok: 'ok', fail: 'fail' }
const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))

test('규격 벡터 전량 — 하나라도 빠지면 실패다', () => {
  const doc = JSON.parse(readFileSync(join(__SPEC_VECTORS__, 'frame.json'), 'utf8')) as { cases: Vector[] }
  assert.ok(doc.cases.length > 0)
  for (const c of doc.cases) {
    if (c.expect.error) { assert.throws(() => decodeFrame(bytes(c.hex)), FrameError, c.name); continue }
    const f = decodeFrame(bytes(c.hex))
    assert.equal(f.kind, KIND[c.expect.kind!], `${c.name}: kind`)
    assert.equal(f.op, c.expect.op, `${c.name}: op`)
    assert.equal(f.pid, c.expect.pid, `${c.name}: pid`)
    assert.equal(f.reserved, c.expect.reserved ?? 0, `${c.name}: reserved`)
    assert.deepEqual(f.body, c.expect.body, `${c.name}: body`)
  }
})

test('연:TRN.frame.WS — 빈 body 는 0바이트로 나가고 {} 로 돌아온다', () => {
  const ack = encodeFrame('ok', 0x0701, 42)
  assert.equal(ack.length, 8)
  assert.deepEqual(decodeFrame(ack).body, {})
  assert.equal(encodeFrame('request', 0x0103, 1, {}).length, 8)
})

test('연:TRN.frame.WS — 예약 비트(bit2-7)는 파서가 원본을 보존한다 · pid 는 u32 전폭', () => {
  const f = decodeFrame(bytes('01a40101ffffffff'))
  assert.equal(f.reserved, 0xa4)
  assert.equal(f.pid, 0xffffffff)
})

test('연:RULE-TRN-CLOSE — 크기 초과 · 8바이트 미만 · ver≠1 · flags 11 은 끊는 사유다', () => {
  assert.throws(() => encodeFrame('request', 0x0501, 1, { pad: 'x'.repeat(MAX_FRAME) }), FrameError)
  assert.throws(() => decodeFrame(bytes('01000103')), FrameError)
  assert.throws(() => decodeFrame(bytes('0200010300000001')), FrameError)
  assert.throws(() => decodeFrame(bytes('0103010300000001')), FrameError)
  assert.throws(() => decodeFrame(Uint8Array.of(1, 0, 1, 3, 0, 0, 0, 1, 0x7b)), FrameError)
})
