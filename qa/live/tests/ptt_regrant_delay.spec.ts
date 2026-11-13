// author: kodeholic (powered by Claude)
// 같은 사람이 무전 발언권을 놓고 1초 쉬었다 다시 받아 말하기를 되풀이한다 — 받는 쪽 지연이 부풀지 않는다.
// ★브라우저 송신기는 말을 쉬는 동안 RTP ts 를 멈춘다. 서버가 재허가를 출처 전환으로 잇지 않으면 그 ts 가 그대로 나가
//   받는 쪽 NetEQ 가 쉰 시간만큼 늦은 도착으로 보고 최소 지연을 약 1초로 키운다(재현 20261113 — 930 → 1,040ms · 메움 10%).
//   서버는 무전 슬롯의 출처를 허가 일화로 짓는다(정:IMPL-FWD-SOURCE-SWITCH · context 202611/20261113g).
import { test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../fixtures/scope.js'
import { TrackStat } from '../fixtures/delta.js'

const S = new Scope('ptt_regrant_delay')
const ROOM = S.room()
const ROUNDS = 4
const TALK_MS = 3_000
const PAUSE_MS = 1_000
/** 고친 서버 실측 수십 ms · 고치기 전 930 ~ 1,040ms — 그 사이 */
const MIN_DELAY_MAX_MS = 300

test.afterEach(async () => { await S.teardown() })

const phase = (p: Participant): Promise<string> => p.call<{ phase: string }>('ptt', ROOM).then((s) => s.phase)
const slotAudio = async (p: Participant): Promise<TrackStat> => {
  const t = (await p.call<TrackStat[]>('trackStats')).find((x) => x.id.startsWith('ptt-') && x.kind === 'audio')
  expect(t, '오디오 슬롯이 있다').toBeDefined()
  return t!
}

test('PTT-R1 같은 화자 재발언 — 받는 쪽 최소 지연이 부풀지 않는다', { annotation: { type: 'spec', description: 'S-sym-IMPL-FWD-SOURCE-SWITCH-6②' } }, async ({ browser }) => {
  test.setTimeout(60_000)
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const speaker = await S.open(ctx, { userId: S.user('U01') })
  await speaker.call('join', ROOM, 'talk')
  const listener = await S.open(ctx, { userId: S.user('U02') })
  await listener.call('join', ROOM, 'listen')

  let before: TrackStat | null = null
  for (let i = 0; i < ROUNDS; i++) {
    if (i === ROUNDS - 1) before = await slotAudio(listener)
    await speaker.call('press', ROOM)
    await expect.poll(() => phase(speaker), { message: '허가가 난다' }).toBe('has_permission')
    await new Promise((r) => setTimeout(r, TALK_MS))
    await speaker.call('release', ROOM)
    await expect.poll(() => phase(speaker)).toBe('no_permission')
    if (i < ROUNDS - 1) await new Promise((r) => setTimeout(r, PAUSE_MS))
  }
  const after = await slotAudio(listener)
  const emitted = (after.jbEmitted ?? 0) - (before!.jbEmitted ?? 0)
  expect(emitted, '마지막 발화 동안 받는 쪽이 표본을 내보냈다(분모 0 이면 판정 못 함)').toBeGreaterThan(0)
  const minMs = (((after.jbMinimum ?? 0) - (before!.jbMinimum ?? 0)) / emitted) * 1000
  const avgMs = (((after.jbDelay ?? 0) - (before!.jbDelay ?? 0)) / emitted) * 1000
  test.info().annotations.push({ type: 'measure', description: `마지막 발화 받는 쪽 최소 지연 ${minMs.toFixed(0)}ms · 평균 ${avgMs.toFixed(0)}ms` })
  expect(minMs, `★같은 화자가 ${PAUSE_MS}ms 쉬었다 다시 말할 때 받는 쪽 NetEQ 최소 지연 — 1초 근처면 멈춘 ts 가 그대로 나간 것이다`).toBeLessThan(MIN_DELAY_MAX_MS)
})
