import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedByOf, DeviceError, reasonOf } from '../src/platform/media.js'
import { toOxLensError } from '../src/api/errors.js'

test('이름은 표준 예외에서만 짓는다 — 메시지로 이름을 정하지 않는다', () => {
  const names = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError', 'SecurityError', 'TypeError']
  assert.deepEqual(names.map(reasonOf),
    ['permission_denied', 'not_found', 'in_use', 'overconstrained', 'other', 'other', 'other'])
})

test('blockedBy 는 메시지 → permissions.query → unknown 순이다', () => {
  assert.equal(blockedByOf('Permission dismissed', 'prompt'), 'dismissed')
  assert.equal(blockedByOf('Permission denied by system', 'granted'), 'system', '"denied by system" 이 "denied" 를 품는다')
  assert.equal(blockedByOf('Permission denied', 'prompt'), 'user')
  assert.equal(blockedByOf('The request is not allowed by the user agent', 'denied'), 'user')
  assert.equal(blockedByOf('The request is not allowed by the user agent', 'unknown'), 'unknown')
  assert.equal(blockedByOf(undefined, 'prompt'), 'unknown', '문자열이 바뀌면 오판하지 않고 unknown 으로 떨어진다')
})

test('표면 오류는 DEVICE_* 이름 · kind audio/video · blockedBy · constraint · cause 를 싣는다', () => {
  const cause = new Error('x')
  const e = toOxLensError(new DeviceError('microphone', 'permission_denied', '막힘', { blockedBy: 'dismissed', cause }))
  assert.deepEqual([e.category, e.name, e.permanent], ['device', 'DEVICE_PERMISSION_DENIED', false])
  assert.deepEqual(e.details, { kind: 'audio', blockedBy: 'dismissed' })
  assert.equal(e.cause, cause)

  const u = toOxLensError(new DeviceError('camera', 'permission_denied', '막힘', { blockedBy: 'user' }))
  assert.equal(u.permanent, true, '사이트 차단은 재호출이 소용없다')

  const o = toOxLensError(new DeviceError('camera', 'overconstrained', '제약', { constraint: 'deviceId' }))
  assert.equal(o.name, 'DEVICE_OVERCONSTRAINED')
  assert.deepEqual(o.details, { kind: 'video', constraint: 'deviceId' })

  const t = toOxLensError(new DeviceError('screen', 'timeout', '늦음'))
  assert.equal(t.name, 'DEVICE_TIMEOUT')
  assert.deepEqual(t.details, { kind: 'video' }, 'blockedBy 는 PERMISSION_DENIED 에만 실린다')

  const n = toOxLensError(new DeviceError('microphone', 'not_found', '없음'))
  assert.equal(n.name, 'DEVICE_NOT_FOUND')
  const i = toOxLensError(new DeviceError('microphone', 'in_use', '잠김'))
  assert.equal(i.name, 'DEVICE_IN_USE')
})
