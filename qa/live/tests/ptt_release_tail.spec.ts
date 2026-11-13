// author: kodeholic (powered by Claude)
// 같은 사람이 짧게 말하고 놓고 1초 뒤 다시 누르기를 되풀이한다 — 누를 때마다 허가가 난다.
// ★SDK 가 RELEASE 를 먼저 보내고 송출을 뒤에 닫으면 놓기 뒤 꼬리 RTP 가 서버에 닿아 회수(사유 3)가 나고, 클라는 이미 허가 없음이라 회수를 버려
//   다음 누름이 답 없이 버려졌다(실기기 폰 20261113 · 놓기 83 번 중 4 번). 지금 SDK 는 송출을 멈춘 뒤 RELEASE 를 보낸다(연:RULE-FLR-MSG-RELEASE ·
//   context 202611/20261113h) · 서버는 놓기보다 먼저 받은 RTP 를 회수로 알리지 않고(정:IMPL-FLR-RTP-OBSERVE) · 회수가 나도 C8 × T8 뒤 다시 맞춘다(연:DEV-FLR-T8-GIVEUP).
import { test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../fixtures/scope.js'

const S = new Scope('ptt_release_tail')
const ROOM = S.room()
const ROUNDS = 25
const TALK_MS = 400
const PAUSE_MS = 1_000

test.afterEach(async () => { await S.teardown() })

const phase = (p: Participant): Promise<string> => p.call<{ phase: string }>('ptt', ROOM).then((s) => s.phase)

test('PTT-R2 놓고 1초 뒤 다시 누름 — 매번 허가가 난다(꼬리 RTP 회수로 버튼이 안 먹지 않는다)', { annotation: { type: 'spec', description: 'S-sym-IMPL-FLR-RTP-OBSERVE-5' } }, async ({ browser }) => {
  test.setTimeout(120_000)
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const speaker = await S.open(ctx, { userId: S.user('U01') })
  await speaker.call('join', ROOM, 'talk')
  const listener = await S.open(ctx, { userId: S.user('U02') })
  await listener.call('join', ROOM, 'listen')

  const missed: number[] = []
  for (let i = 0; i < ROUNDS; i++) {
    await speaker.call('press', ROOM)
    const granted = await expect.poll(() => phase(speaker), { timeout: 2_000 }).toBe('has_permission').then(() => true, () => false)
    if (!granted) missed.push(i)
    else await new Promise((r) => setTimeout(r, TALK_MS))
    await speaker.call('release', ROOM)
    await expect.poll(() => phase(speaker), { timeout: 5_000 }).toBe('no_permission')
    await new Promise((r) => setTimeout(r, PAUSE_MS))
  }
  test.info().annotations.push({ type: 'measure', description: `${ROUNDS} 번 중 허가 못 받음 ${missed.length}(${missed.join(',')})` })
  expect(missed, `★누름 ${ROUNDS} 번 중 2초 안에 허가가 안 난 차례 — 놓기 뒤 꼬리 RTP 회수로 요청이 버려진 것이다`).toEqual([])
})
