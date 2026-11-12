// author: kodeholic (powered by Claude)
// 갈래B — PEER-MIX-02 의 「디코드했다」가 ★진짜 코덱 본문에 매여 있는지(context 202611/20261108d R9).
//   어기는 것 하나: 에이전트가 코덱 본문이 아닌 표지 프레임(beacon — 2층 재료)을 낸다. 나머지(입장 · 발행 · 패킷 흐름)는 그대로라
//   패킷은 오는데(대조군) 디코드한 프레임 차분은 0 이어야 한다 — 0 이 아니면 정규 시험의 프레임 차분이 본문과 무관하게 초록이다.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../../fixtures/scope.js'
import { flowOf, TrackStat } from '../../fixtures/delta.js'
import { buildPeer, runPeer } from '../../fixtures/oxpeer.js'

const S = new Scope('peer_mixed_fault')

test.beforeAll(() => { buildPeer() })
test.afterEach(async () => { await S.teardown() })

test('PEER-MIX-B1 코덱이 아닌 본문이면 패킷은 와도 디코드한 프레임은 없다', { annotation: { type: 'spec', description: 'SDK:RULE-PLAT-SERVER' } }, async ({ browser }) => {
  const ROOM = S.room('beacon')
  await ensureRoom(ROOM)
  const ctx = await browser.newContext()
  const b = await S.open(ctx, { userId: S.user('U02') })
  await b.call('join', ROOM, 'talk')
  const ag = runPeer('agent_echo', ['--room', ROOM, '--secs', '9', '--user', S.user('AGENT'), '--mode', 'beacon', '--video'])
  await ag.joined
  const video = (t: TrackStat): boolean => t.kind === 'video' && !t.id.startsWith('ptt-')
  await expect.poll(() => b.call<TrackStat[]>('trackStats').then((s) => s.filter(video).length), { message: '에이전트 영상 트랙이 붙는다' }).toBe(1)
  const vf = await flowOf(b, video)
  expect(vf, '트랙이 사라지면 0 과 구별한다').not.toBeNull()
  expect(vf!.packets, '대조군 — 패킷은 흐른다(입장 · 발행 · 전달은 정상)').toBeGreaterThan(30)
  expect(vf!.frames, '★표지 본문은 디코드되지 않는다 — 0 이 아니면 PEER-MIX-02 의 프레임 차분은 이빨이 없다').toBe(0)
  await ag.done
})
