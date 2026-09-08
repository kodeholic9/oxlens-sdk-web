// author: kodeholic (powered by Claude)
// ★갈래B — 연§9-10 규칙 1(언제나 서버 offer)이 무엇에 매여 있는지 못박는다.
// 딱 하나만 어긴다 — 산 연결에서 브라우저에게 자기 offer 를 내게 한다.
// 시험 항목서 `C-sym-9-10-2` · `C-cond-idx-13`.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../../fixtures/scope.js'
import { TrackStat } from '../../fixtures/delta.js'

const S = new Scope('faultonepc')
const ROOM = S.room()
const peerAudio = (t: TrackStat): boolean => t.kind === 'audio' && !t.id.startsWith('ptt-')

interface Attempt { refused: boolean; message: string; mids: string[] }

test.afterEach(async () => { await S.teardown() })

test('FAULT-1PC-01 받기 audio 가 둘이면 브라우저는 자기 offer 를 못 만든다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('FA'), pcMode: '1pc' })
  await a.call('join', ROOM, 'talk')

  // 대조군 — 지금은 받기 audio 가 무전 슬롯 하나뿐이다. 같은 위반이 통과한다.
  const one = await a.call<Attempt>('forceBrowserOffer')
  expect(one.refused, '받기가 하나면 브라우저 offer 가 선다 — 무전만 쓰는 형상이 이것이다').toBe(false)

  // 남이 들어와 개인 오디오가 붙는다 — 받기 audio 가 둘이 되는 순간이 갈림이다.
  const b = await S.open(ctx, { userId: S.user('FB'), pcMode: '1pc' })
  await b.call('join', ROOM, 'talk')
  await b.call('enableMic')
  await expect.poll(() => a.call<TrackStat[]>('trackStats').then((s) => s.filter(peerAudio).length), {
    message: '상대 오디오가 붙는다',
  }).toBe(1)

  const two = await a.call<Attempt>('forceBrowserOffer')
  expect(two.refused, '받기가 둘이 되면 브라우저가 자기 offer 를 거부한다').toBe(true)
  expect(two.message, '거부 사유는 demuxer 기준 등록 실패다 — 연§9-10 규칙 1 의 근거')
    .toMatch(/demuxer criteria/i)
})
