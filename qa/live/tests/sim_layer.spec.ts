// author: kodeholic (powered by Claude)
// ★3층의 몫 — 실 인코더의 시뮬캐스트 h 층이 기본 형상(SDK 층 기본값 · 서버 업링크 상한 정책 기본값)에서 실제로 흐르고,
//   층을 바꿔도 실 디코더가 멎지 않는가. 2층 봇은 인코더가 없어 상한에 묶인 h 를 못 본다(봇은 정해진 만큼 보낸다).
//   20261028 3층 실측 — 업링크 상한(정책 media.max_bitrate_bps)이 800,000 이면 발행자 송신 추정이 거기 묶여 h 가 20초에 6프레임이었다
//   (층 합 1,900,000 보다 작다) → 결재로 기본 2,000,000 · 교차 규칙 `bitrate-layers`(대장 C-111 — 서버가 따라온 뒤 이 시험을 짓는다).
import { test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../fixtures/scope.js'

const S = new Scope('sim_layer')
const ROOM = S.room()

test.afterEach(async () => { await S.teardown() })

interface Enc { rid: string | null; framesEncoded: number | null; frameWidth?: number | null }
interface In { id: string; kind: string; framesDecoded: number | null; keyFramesDecoded: number | null; freezeCount: number | null; frameWidth: number | null }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const byRid = (es: Enc[]) => Object.fromEntries(es.map((e) => [e.rid ?? '-', e])) as Record<string, Enc>
const video = async (p: Participant) => (await p.call<In[]>('trackStats')).find((s) => s.kind === 'video' && !s.id.startsWith('ptt-'))

test('SIM-LAYER-01 기본 형상에서 h 층이 흐르고 층을 바꿔도 디코딩이 멎지 않는다', { annotation: { type: 'spec', description: 'PL-KEY-MEDIA-MAX-BITRATE-BPS · 정:IMPL-SIM-SWITCH' } }, async ({ browser }) => {
  const pubCtx = await browser.newContext()
  const subCtx = await browser.newContext()
  await ensureRoom(ROOM)
  const pub = await S.open(pubCtx, { userId: S.user('P01') })
  await pub.call('join', ROOM, 'talk')
  // ★SDK adaptiveStream 은 타일 폭 480px 미만이면 가장 낮은 층을 다시 보낸다(SDK:IMPL-TRK-RECEIVE) — 이 시험의 setLayer 를 덮지 않게 끈다.
  const sub = await S.open(subCtx, { userId: S.user('S01'), adaptiveStream: false })
  await sub.call('join', ROOM, 'talk')
  const cam = await pub.call<{ simulcast: boolean }>('enableCamera', { simulcast: true })
  expect(cam.simulcast, '시뮬캐스트로 발행됐다(아니면 층 시험이 공허하다)').toBe(true)

  await expect.poll(async () => (await video(sub))?.framesDecoded ?? 0, { timeout: 25_000, message: '구독자가 영상을 디코딩한다' }).toBeGreaterThan(10)
  await expect.poll(async () => Object.keys(byRid(await pub.call<Enc[]>('encodings'))).filter((r) => r === 'h' || r === 'l').length,
    { timeout: 15_000, message: '발행자 인코딩 h · l 둘이 선다' }).toBe(2)
  const tid = (await video(sub))!.id

  // ① 기본 형상에서 h 가 흐른다 — 업링크 상한이 층 합보다 작으면 발행자 송신 추정이 거기 묶여 h 가 몇 초에 한 프레임이 된다.
  await wait(3_000)
  const e0 = byRid(await pub.call<Enc[]>('encodings'))
  await wait(4_000)
  const e1 = byRid(await pub.call<Enc[]>('encodings'))
  const dh = (e1.h!.framesEncoded ?? 0) - (e0.h!.framesEncoded ?? 0)
  expect(dh, `기본 형상에서 h 층이 4초에 ${dh}프레임 — 업링크 상한에 묶였다(정책 media.max_bitrate_bps 가 층 합보다 작다 · 대장 C-111)`).toBeGreaterThan(40)
  const hWidth = e1.h!.frameWidth ?? null

  // ② 구독자에게도 h 가 선다 — 실효 층 = 수동 상한과 자동 판단의 min(정:RULE-SIM-TICK). 자동 층(이 서버 형상 정책 `auto_layer = v2`)은
  //   추정 300 kbps 에서 시작해 clean 유지 + backoff 15s 뒤 승격하므로 첫 h 는 그 뒤다(20261031 실측 14.4초 — 그동안 h 에 PLI 0 이 맞다).
  //   ★상한에 묶이면 승격이 영영 안 온다(발행자 h 가 서지 않으므로) — 30초 안에 서야 한다.
  expect(hWidth, 'h 층 인코딩 폭을 못 읽었다 · 판정 불가').toBeTruthy()
  await sub.call('setLayer', tid, { spatial: 1 })
  const t0 = Date.now()
  await expect.poll(async () => (await video(sub))?.frameWidth ?? 0, { timeout: 30_000, intervals: [250], message: '구독자에게 h 층이 30초 안에 안 선다' }).toBe(hWidth)
  process.stdout.write(`\n  [sim_layer] 첫 h(자동 층 승격 포함) ${Date.now() - t0}ms\n`)

  // ③ 그 뒤 수동 전환은 키프레임에서 바로 선다 — 길어야 스로틀 창 + 인코딩 지연(정:IMPL-SIM-SWITCH ④ · h 스로틀 1초 + 여유 → 3초) ·
  //   디코딩이 이어지고 새 층의 키프레임이 온다(target 층 키프레임 도착 = 전환 확정).
  let a = (await video(sub))!
  for (const [step, spatial] of [['→l', 0], ['→h', 1], ['→l', 0], ['→h', 1]] as const) {
    await sub.call('setLayer', tid, { spatial })
    const s0 = Date.now()
    await expect.poll(async () => { const w = (await video(sub))?.frameWidth ?? 0; return spatial === 1 ? w === hWidth : w < (hWidth ?? 0) },
      { timeout: 15_000, intervals: [250], message: `${step} 수신 폭이 그 층으로 안 바뀐다` }).toBe(true)
    const took = Date.now() - s0
    process.stdout.write(`\n  [sim_layer] ${step} 폭 바뀜까지 ${took}ms\n`)
    expect(took, `${step} 가 ${took}ms 만에 섰다 — 키프레임 요청 · 전환 확정이 늦다(정:IMPL-SIM-SWITCH ④)`).toBeLessThanOrEqual(3_000)
    await wait(3_000)
    const b = (await video(sub))!
    const dDec = (b.framesDecoded ?? 0) - (a.framesDecoded ?? 0)
    const dKey = (b.keyFramesDecoded ?? 0) - (a.keyFramesDecoded ?? 0)
    process.stdout.write(`\n  [sim_layer] ${step} 폭 ${a.frameWidth} → ${b.frameWidth}(h ${hWidth}) · 디코딩 Δ${dDec} · 키프레임 Δ${dKey} · 얼어붙음 Δ${(b.freezeCount ?? 0) - (a.freezeCount ?? 0)}\n`)
    expect(dDec, `${step} 뒤 3초 동안 디코딩 ${dDec}프레임 — 층 전환에서 멎었다`).toBeGreaterThan(20)
    expect(dKey, `${step} 뒤 새 층의 키프레임이 안 왔다(정:IMPL-SIM-SWITCH)`).toBeGreaterThanOrEqual(1)
    if (hWidth) {
      if (spatial === 1) expect(b.frameWidth, `${step} 뒤 수신 폭이 h 층 폭이 아니다`).toBe(hWidth)
      else expect(b.frameWidth ?? 0, `${step} 뒤 수신 폭이 h 층보다 작지 않다`).toBeLessThan(hWidth)
    }
    a = b
  }
})
