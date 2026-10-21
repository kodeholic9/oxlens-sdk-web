// author: kodeholic (powered by Claude)
// 순수 단위 — 능력표 · 기본값 병합 · 배정표 지문 · quality · 오류형 · 장치 실패 이름
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, familyOf } from '../src/platform/capability.js'
import { settle } from '../src/domain/defaults.js'
import { DEFAULTS } from '../src/domain/gen/sdk_defaults.js'
import { TableStore } from '../src/domain/store.js'
import { grade, worst } from '../src/internal/probe.js'
import { Fault, categoryOf, fromFailure } from '../src/platform/fault.js'
import { toError, OxLensError } from '../src/api/errors.js'
import { capture } from '../src/platform/env.js'
import { ROWS } from './_fixtures.js'

test('SDK:RULE-PLAT-PC-MODE — 표에 없는(모르는) 브라우저는 2pc · 앱 지정이 이긴다', () => {
  assert.equal(decide('auto', 'Mozilla/5.0 HeadlessChrome/153.0.8010.12 Safari/537.36'), '1pc')
  assert.equal(decide('auto', 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36'), '2pc')
  assert.equal(decide('auto', 'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15'), '2pc')
  assert.equal(decide('auto', 'Mozilla/5.0 Firefox/155.0'), '1pc')
  assert.equal(decide('2pc', 'Mozilla/5.0 HeadlessChrome/153.0.8010.12'), '2pc')
  assert.equal(familyOf('weird'), null)
})

test('정책:sdk — 안 준 칸(undefined · null)은 기본값 · 묶음은 묶음마다 병합 · 주입이 이긴다', () => {
  const s = settle({ base: 'https://x', token: 't', wobblyGraceMs: null, publishDefaults: { screenShare: { maxFramerate: 5 } }, dcReopen: { tries: 9 } })
  assert.equal(s.wobblyGraceMs, DEFAULTS.wobblyGraceMs)
  assert.equal(s.screenShare.maxFramerate, 5)
  assert.equal(s.screenShare.contentHint, 'detail')
  assert.deepEqual(s.dcReopen, { tries: 9, intervalMs: DEFAULTS.dcReopen.intervalMs })
  assert.deepEqual(s.simulcastLayers.map((l) => l.rid), ['l', 'h'])
  assert.equal(s.playoutDelayMs, null)
  assert.equal(s.adaptiveStream, true)
  assert.equal(s.disconnectOnPageLeave, true)
})

test('연:RULE-SUB-TABLE-PROC — 실린 트랙만 바뀌면 SDP 재료는 그대로 · 줄의 튜플이 바뀌면 다르다', () => {
  const a = TableStore.materials(ROWS)
  const moved = ROWS.map((r, i) => (i === 2 ? { ...r, track_id: 't-u9-cam', room_id: 'r2' } : r))
  assert.equal(TableStore.materials(moved), a)
  const retuple = ROWS.map((r, i) => (i === 0 ? { ...r, pt: 109 } : r))
  assert.notEqual(TableStore.materials(retuple), a)
  assert.notEqual(TableStore.materials([...ROWS, { ...ROWS[0]!, mid: '3', ssrc: 9 }]), a)
})

test('SDK:RULE-DIAG-QUALITY — 4단 문턱 · 여러 서버면 최악값', () => {
  const th = DEFAULTS.quality
  const s = (lost: number, received: number, rtt: number | null) => ({ lost, received, rttMs: rtt, outgoingBps: null })
  assert.equal(grade(s(0, 0, null), s(1, 999, 100), true, th), 'excellent')
  assert.equal(grade(s(0, 0, null), s(30, 970, 100), true, th), 'good')
  assert.equal(grade(s(0, 0, null), s(100, 900, 100), true, th), 'poor')
  assert.equal(grade(null, s(0, 0, 500), true, th), 'poor')
  assert.equal(grade(null, s(0, 0, null), false, th), 'lost')
  assert.equal(worst('good', 'poor'), 'poor')
})

test('SDK:IMPL-ERR-TYPE — wire 코드는 그대로 · 앞자리가 분류 · wire 아닌 실패는 code 0', () => {
  assert.equal(categoryOf(1003), 'bug')
  assert.equal(categoryOf(2006), 'auth')
  assert.equal(categoryOf(3001), 'state')
  assert.equal(categoryOf(4009), 'limit')
  assert.equal(categoryOf(5002), 'server')
  const e = toError(fromFailure({ code: 1006, name: 'CODEC_MISMATCH', permanent: true, details: { codec: 'H264' } }))
  assert.ok(e instanceof OxLensError)
  assert.deepEqual([e.code, e.name, e.category, e.permanent, e.details], [1006, 'CODEC_MISMATCH', 'bug', true, { codec: 'H264' }])
  const s = toError(new Fault({ code: 0, name: 'STATE_NO_SPEAKING_ROOM', category: 'state' }))
  assert.deepEqual([s.code, s.category], [0, 'state'])
})

test('SDK:RULE-ERR-DEVICE — 표준 예외 이름 → DEVICE_* · blockedBy 는 Chromium 메시지 층부터', async () => {
  const g = globalThis as unknown as { navigator?: unknown }
  const saved = g.navigator
  const fail = (name: string, message = ''): Error => Object.assign(new Error(message), { name })
  const run = async (err: unknown): Promise<Fault> => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => Promise.reject(err) } } })
    try { await capture({ kind: 'audio', timeoutMs: 1000 }); throw new Error('통과했다') } catch (e) { return e as Fault }
  }
  try {
    const a = await run(fail('NotAllowedError', 'Permission dismissed'))
    assert.deepEqual([a.name, a.category, a.details], ['DEVICE_PERMISSION_DENIED', 'device', { kind: 'audio', blockedBy: 'dismissed' }])
    assert.equal((await run(fail('NotAllowedError', 'Permission denied by system'))).details?.['blockedBy'], 'system')
    assert.equal((await run(fail('NotAllowedError', 'nope'))).details?.['blockedBy'], 'unknown')
    assert.equal((await run(fail('NotFoundError'))).name, 'DEVICE_NOT_FOUND')
    assert.equal((await run(fail('NotReadableError'))).name, 'DEVICE_IN_USE')
    const oc = await run(Object.assign(fail('OverconstrainedError'), { constraint: 'width' }))
    assert.deepEqual([oc.name, oc.details?.['constraint']], ['DEVICE_OVERCONSTRAINED', 'width'])
    assert.equal((await run(fail('AbortError'))).name, 'DEVICE_OTHER')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise(() => undefined) } } })
    await assert.rejects(capture({ kind: 'video', timeoutMs: 20 }), (e: unknown) => e instanceof Fault && e.name === 'DEVICE_TIMEOUT')
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: saved })
  }
})
