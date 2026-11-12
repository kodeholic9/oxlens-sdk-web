// author: kodeholic (powered by Claude)
// ★3층의 몫 — AI 에이전트 브리지(SDK:RULE-PLAT-AGENT · context 202611/20261112a)를 실 인코더 · 실 디코더로 지난다.
//   브라우저(크로뮴 가짜 장치 — 실 Opus 인코더)가 누르고 말한다 → 브리지가 Opus 를 PCM 으로 풀어 가짜 AI(되울림)로 → AI 가 그 PCM 을 reply 로 되돌린다
//   → 브리지가 다시 Opus 로 지어 발언권을 잡고 낸다 → 청취 브라우저가 에이전트 목소리를 실제로 디코드한다(샘플 차분 · 은닉 비율).
//   턴 경계 · 순번 축 · reply 결과의 셈은 2층 labs(bridge_*)가 본다 — 여기는 디코더가 판정을 바꾸는 것만.
import { test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../fixtures/scope.js'
import { TrackStat } from '../fixtures/delta.js'
import { startEchoAi } from '../fixtures/fakeai.js'
import { buildPeer, runPeer } from '../fixtures/oxpeer.js'

const S = new Scope('peer_bridge')

test.beforeAll(() => { buildPeer() })
test.afterEach(async () => { await S.teardown() })

interface Ptt { phase: string }
const slot = (t: TrackStat): boolean => t.kind === 'audio' && t.id.startsWith('ptt-')
const speakerSeen = (p: Participant): Promise<string | null> =>
  p.call<{ detail: { userId: string | null } }[]>('events', 'speaker').then((e) => e.at(-1)?.detail.userId ?? null)
const slotSamples = async (p: Participant): Promise<{ got: number; hid: number }> => {
  const s = (await p.call<TrackStat[]>('trackStats')).find(slot)
  return { got: s?.samplesReceived ?? 0, hid: s?.concealed ?? 0 }
}

test('PEER-BRIDGE-01 누르고 말한 음성이 에이전트 목소리로 돌아와 디코드된다', { annotation: { type: 'spec', description: 'SDK:RULE-PLAT-AGENT-TURN · SDK:RULE-PLAT-AGENT-REPLY · SDK:RULE-PLAT-AGENT-AUDIO' } }, async ({ browser }) => {
  const ROOM = S.room('echo')
  await ensureRoom(ROOM)
  const ai = await startEchoAi()
  const AGENT = S.user('AGENT')
  try {
    const ctx = await browser.newContext()
    const speaker = await S.open(ctx, { userId: S.user('U01') })
    await speaker.call('join', ROOM, 'talk')
    const listener = await S.open(ctx, { userId: S.user('U02') })
    await listener.call('join', ROOM, 'listen')
    const br = runPeer('oxbridge', ['--room', ROOM, '--ai-url', ai.url, '--secs', '16', '--user', AGENT])
    await br.joined

    await speaker.call('press', ROOM)
    await expect.poll(() => speaker.call<Ptt>('ptt', ROOM).then((s) => s.phase), { message: '사람이 허가를 받는다' }).toBe('has_permission')
    await new Promise((r) => setTimeout(r, 2_500))
    await speaker.call('release', ROOM)

    // 브리지가 턴 끝(발언권 Idle + 닫기 유예)을 받아 AI 로 · AI 가 되돌린 reply 로 발언권을 잡는다 — 청취자에게 화자가 에이전트로 뜬다
    await expect.poll(() => speakerSeen(listener), { message: '에이전트가 발언권을 잡는다(화자 통지)', timeout: 10_000 }).toBe(AGENT)
    const s0 = await slotSamples(listener)
    await new Promise((r) => setTimeout(r, 1_500))
    const s1 = await slotSamples(listener)
    const got = s1.got - s0.got
    const hid = s1.hid - s0.hid
    expect(got, '에이전트 목소리를 디코드한 샘플 차분(48kHz · 1.5초 ≈ 72000) — 패킷이 와도 디코드가 안 되면 0').toBeGreaterThan(50_000)
    expect(hid, '은닉 샘플이 받은 것의 10% 를 넘지 않는다 — 브리지 송신 시계가 고르게 낸다').toBeLessThan(got / 10)
    await expect.poll(() => speakerSeen(listener), { message: 'reply 가 끝나면 발언권을 놓는다', timeout: 10_000 }).toBe(null)

    const sum = await br.done
    const replies = sum.replies as Record<string, number>
    expect(sum.turns, '사람 발언 하나 = 턴 하나').toBe(1)
    expect(replies.done, 'reply 가 정상 끝났다').toBe(1)
    expect(sum.decode_errors, '실 인코더 Opus 를 브리지가 디코드한다').toBe(0)
    expect(Number(sum.frames_sent), '송출 프레임(2.5초 발언 되울림 ≈ 125)').toBeGreaterThan(100)
    expect(Number(sum.orphan_sourced) + Number(sum.orphan_sourceless), '버그 계수(유예 창 밖 프레임) 0').toBe(0)
    const states = ai.events.filter((e) => e.type === 'reply.state').map((e) => e.state)
    expect(states, 'AI 가 받은 reply 결과').toEqual(['floor_granted', 'done'])
    expect(ai.events.find((e) => e.type === 'mark')?.status, 'mark 는 송출 뒤 played').toBe('played')
    expect(ai.events.find((e) => e.type === 'turn.start')?.speaker, '턴 화자 = 누른 브라우저').toEqual({ user_id: S.user('U01') })
  } finally {
    await ai.close()
  }
})
