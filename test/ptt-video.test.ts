import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPreferenceForTest } from '../src/internal/transport/link.js'

interface Cap { mimeType: string; sdpFmtpLine?: string }

function stand(caps: Cap[]): { set: Cap[][]; t: { setCodecPreferences(c: readonly Cap[]): void } } {
  const set: Cap[][] = []
  return { set, t: { setCodecPreferences: (c) => { set.push([...c]) } } }
}

const CAPS: Cap[] = [
  { mimeType: 'video/VP8' },
  { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
  { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=640c1f' },
  { mimeType: 'video/VP9' },
]

test('슬롯 코덱을 맨 앞으로 민다 — 빼지 않고 순서만 바꾼다', () => {
  const { set, t } = stand(CAPS)
  applyPreferenceForTest(t as never, CAPS, { codec: 'H264' })
  assert.equal(set.length, 1)
  assert.ok(set[0]![0]!.mimeType.endsWith('/H264'))
  assert.equal(set[0]!.length, CAPS.length, '빼면 협상이 통째로 실패할 수 있다')
})

test('fmtp 까지 맞는 것이 먼저다 — H264 는 프로파일에서 갈린다', () => {
  const { set, t } = stand(CAPS)
  applyPreferenceForTest(t as never, CAPS, { codec: 'H264', fmtp: 'profile-level-id=640c1f' })
  assert.equal(set[0]![0]!.sdpFmtpLine, 'profile-level-id=640c1f')
})

test('그 코덱이 능력표에 없으면 손대지 않는다 — 서버 순서를 따른다', () => {
  const { set, t } = stand(CAPS)
  applyPreferenceForTest(t as never, CAPS, { codec: 'AV1' })
  assert.equal(set.length, 0)
})

test('능력표가 없으면 조용히 넘긴다', () => {
  const { set, t } = stand([])
  applyPreferenceForTest(t as never, null, { codec: 'H264' })
  assert.equal(set.length, 0)
})

test('브라우저가 선호 설정을 안 주면 조용히 넘긴다', () => {
  applyPreferenceForTest({} as never, CAPS, { codec: 'H264' })
})
