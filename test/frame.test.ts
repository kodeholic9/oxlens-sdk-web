// author: kodeholic (powered by Claude)
// 연§3-1 codec — 판정 근거는 규격 벡터 정본(oxlens-spec/vectors/frame.json)이다.
// 자기 왕복만 보면 두 구현이 나란히 틀려도 초록이라, 바깥 벡터로 못박는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decode, encode, FrameError, Kind, MAX_FRAME, PidCounter } from '../src/internal/frame.js'

interface Vector {
  readonly name: string
  readonly hex?: string
  readonly expect: { kind?: string; op?: number; pid?: number; reserved?: number; body?: unknown; error?: boolean }
}

declare const __SPEC_VECTORS__: string
const VECTORS = join(__SPEC_VECTORS__, 'frame.json')
const KIND_OF: Record<string, number> = { msg: Kind.Request, ok: Kind.Ok, fail: Kind.Fail }

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))
}

test('규격 벡터 전량 — 하나라도 빠지면 실패다', () => {
  const doc = JSON.parse(readFileSync(VECTORS, 'utf8')) as { cases: Vector[] }
  assert.ok(doc.cases.length > 0, '벡터 파일이 비었다')
  let checked = 0
  for (const c of doc.cases) {
    const raw = bytes(c.hex!)
    if (c.expect.error) {
      assert.throws(() => decode(raw), FrameError, `${c.name}: 끊어야 하는데 통과했다`)
      checked += 1
      continue
    }
    const f = decode(raw)
    assert.equal(f.kind, KIND_OF[c.expect.kind!], `${c.name}: kind`)
    assert.equal(f.op, c.expect.op, `${c.name}: op`)
    assert.equal(f.pid, c.expect.pid, `${c.name}: pid`)
    assert.equal(f.reserved, c.expect.reserved ?? 0, `${c.name}: reserved`)
    assert.deepEqual(f.body, c.expect.body, `${c.name}: body`)
    checked += 1
  }
  assert.equal(checked, doc.cases.length)
})

test('빈 body 는 0바이트로 나가고 {} 로 돌아온다', () => {
  const wire = encode(Kind.Ok, 0x0701, 42)
  assert.equal(wire.length, 8, 'ACK 은 머리뿐이다')
  assert.deepEqual(decode(wire).body, {})
  assert.equal(encode(Kind.Request, 0x0103, 1, {}).length, 8, '{} 도 같게 나간다')
})

test('예약 비트는 왕복에서 보존된다', () => {
  const f = decode(bytes('01a40101ffffffff'))
  assert.equal(f.reserved, 0xa4, '파서가 bit2-7 원본을 버리면 안 된다')
  assert.equal(f.pid, 0xffffffff, 'pid 는 u32 전폭이다')
})

test('상한 초과는 encode 에서도 끊는 사유다', () => {
  const big = { pad: 'x'.repeat(MAX_FRAME) }
  assert.throws(() => encode(Kind.Request, 0x0501, 0, big), (e) => {
    assert.ok(e instanceof FrameError)
    assert.equal(e.closeCode, 4000)
    assert.equal(e.closeReason, 'PROTOCOL_ERROR')
    return true
  })
})

test('pid 는 하나씩 오르고 u32 를 넘으면 0 으로 감긴다', () => {
  const c = new PidCounter()
  assert.deepEqual([c.take(), c.take(), c.take()], [0, 1, 2])
  const wrap = new PidCounter() as unknown as { next: number }
  wrap.next = 0xffffffff
  assert.equal((wrap as unknown as PidCounter).take(), 0xffffffff)
  assert.equal((wrap as unknown as PidCounter).take(), 0, '감긴다')
})
