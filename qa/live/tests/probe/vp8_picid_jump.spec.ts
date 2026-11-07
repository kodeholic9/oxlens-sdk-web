// author: kodeholic (powered by Claude)
// ★실측(probe) — 출처 전환에서 VP8 PictureID 를 이어 쓰지 않는 우리 재기록기(정:IMPL-FWD-SOURCE-SWITCH 「페이로드 원본 그대로」)가
//   크로미움의 낡은 갈래 `WebRTC-LegacyFrameIdJumpBehavior`(기본 켬 · 만료 표시 2024-04-01)에 기대는가(context 202611/20261107e E-1).
//   근거 사실: libwebrtc `api/video/frame_buffer.cc:74-98` — 이미 복호한 id 이하의 프레임은 버린다 · 갈래가 켜져 있고 키프레임이며
//   ts 가 앞이면 버퍼를 비우고 받는다. VP8 프레임 id = PictureID(`rtp_vp8_ref_finder.cc:70`) · 시뮬캐스트 층마다 PictureID 가 따로 오르므로
//   두 층의 차는 거의 일정하다 → l↔h 두 방향 중 한쪽은 늘 「id 가 뒤로 간 키프레임」이다.
//   한 축만 바꾼다 — ★구독자 브라우저의 그 갈래(기본 · Disabled). 대조 축 — 코덱(VP8 · H264: H264 는 프레임 id 가 seq 라 해당 없음).
//   판정이 아니라 수치다 — 정규 게이트 밖(chromium-probe).
import { chromium, test, type Browser } from '@playwright/test'
import { Participant, Scope, expect, userToken } from '../../fixtures/scope.js'
import { BASE, userFor } from '../../fixtures/env.js'

const S = new Scope('picid_jump')
const MEDIA = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]
const LEGACY_OFF = '--force-fieldtrials=WebRTC-LegacyFrameIdJumpBehavior/Disabled/'

test.afterEach(async () => { await S.teardown() })

interface Enc { rid: string | null; framesEncoded: number | null; frameWidth?: number | null }
interface In { id: string; kind: string; framesDecoded: number | null; keyFramesDecoded: number | null; freezeCount: number | null; pliCount: number | null; frameWidth: number | null }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const byRid = (es: Enc[]) => Object.fromEntries(es.map((e) => [e.rid ?? '-', e])) as Record<string, Enc>
const video = async (p: Participant) => (await p.call<In[]>('trackStats')).find((s) => s.kind === 'video' && !s.id.startsWith('ptt-'))

/** 방을 그 코덱으로 짓는다 — 이미 있으면 상세로 코덱을 확인한다(고정 이름 · 3-1). */
async function roomWith(roomId: string, video: string): Promise<void> {
  const auth = { Authorization: `Bearer ${await userToken('qa-admin')}` }
  const res = await fetch(`${BASE}/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ room_id: roomId, name: roomId, media_codecs: { video } }),
  })
  if (res.status !== 409 && !res.ok) throw new Error(`POST /rooms ${roomId}: ${res.status} ${await res.text()}`)
  const got = res.ok ? await res.json() : await (await fetch(`${BASE}/rooms/${roomId}`, { headers: auth })).json()
  const codec = (got as { media_codecs?: { video?: string } }).media_codecs?.video
  expect(codec?.toUpperCase(), `방 ${roomId} 의 video 코덱`).toBe(video.toUpperCase())
}

async function measure(defaultBrowser: Browser, codec: 'VP8' | 'H264', legacyOff: boolean): Promise<void> {
  const label = `${codec}·${legacyOff ? 'off' : 'default'}`
  const room = S.room(`${codec.toLowerCase()}_${legacyOff ? 'off' : 'on'}`)
  await roomWith(room, codec)
  const subBrowser = await chromium.launch({ args: legacyOff ? [...MEDIA, LEGACY_OFF] : MEDIA })
  try {
    const pub = await S.open(await defaultBrowser.newContext(), { userId: userFor('picid_jump', `P_${codec}_${legacyOff ? 'off' : 'on'}`) })
    await pub.call('join', room, 'talk')
    const sub = await S.open(await subBrowser.newContext(), { userId: userFor('picid_jump', `S_${codec}_${legacyOff ? 'off' : 'on'}`), adaptiveStream: false })
    await sub.call('join', room, 'talk')
    const cam = await pub.call<{ simulcast: boolean }>('enableCamera', { simulcast: true })
    expect(cam.simulcast, `${label} 시뮬캐스트로 발행됐다`).toBe(true)
    await expect.poll(async () => (await video(sub))?.framesDecoded ?? 0, { timeout: 25_000, message: `${label} 구독자가 영상을 디코딩한다` }).toBeGreaterThan(10)
    await expect.poll(async () => Object.keys(byRid(await pub.call<Enc[]>('encodings'))).filter((r) => r === 'h' || r === 'l').length,
      { timeout: 15_000, message: `${label} 발행자 인코딩 h · l` }).toBe(2)
    const tid = (await video(sub))!.id
    await wait(3_000)
    const hWidth = byRid(await pub.call<Enc[]>('encodings')).h!.frameWidth ?? 0
    await sub.call('setLayer', tid, { spatial: 1 })
    await expect.poll(async () => (await video(sub))?.frameWidth ?? 0, { timeout: 30_000, intervals: [250], message: `${label} 첫 h` }).toBe(hWidth)
    await wait(2_000)

    const rows: string[] = []
    let a = (await video(sub))!
    for (const [step, spatial] of [['→l', 0], ['→h', 1], ['→l', 0], ['→h', 1]] as const) {
      await sub.call('setLayer', tid, { spatial })
      await wait(6_000)
      const b = (await video(sub))!
      const d = (k: keyof In) => ((b[k] as number | null) ?? 0) - ((a[k] as number | null) ?? 0)
      const widthOk = spatial === 1 ? b.frameWidth === hWidth : (b.frameWidth ?? 0) < hWidth
      rows.push(`  [picid] ${label.padEnd(12)} ${step} 폭 ${a.frameWidth}→${b.frameWidth}(목표 ${spatial === 1 ? hWidth : `<${hWidth}`} ${widthOk ? '도달' : '★미도달'}) · 6초 디코딩 Δ${d('framesDecoded')} · 키프레임 Δ${d('keyFramesDecoded')} · PLI Δ${d('pliCount')} · 얼어붙음 Δ${d('freezeCount')}`)
      a = b
    }
    process.stdout.write(`\n${rows.join('\n')}\n`)
  } finally {
    await S.teardown()
    await subBrowser.close()
  }
}

/**
 * ★짝 판 — 한 발행자에 구독자 둘(갈래 기본 · Disabled)을 붙여 같은 순간에 같은 층으로 바꾼다.
 *   PictureID 시작값은 판마다 무작위라 따로 돈 두 판은 「어느 방향이 뒤로 뛰나」를 짝지을 수 없다 — 같은 발행자면 같다.
 */
async function measurePair(defaultBrowser: Browser, round: number): Promise<void> {
  const room = S.room(`vp8_pair`)
  await roomWith(room, 'VP8')
  const offBrowser = await chromium.launch({ args: [...MEDIA, LEGACY_OFF] })
  try {
    const pub = await S.open(await defaultBrowser.newContext(), { userId: userFor('picid_jump', `P_pair${round}`) })
    await pub.call('join', room, 'talk')
    const subs = {
      default: await S.open(await defaultBrowser.newContext(), { userId: userFor('picid_jump', `S_pair${round}_on`), adaptiveStream: false }),
      off: await S.open(await offBrowser.newContext(), { userId: userFor('picid_jump', `S_pair${round}_off`), adaptiveStream: false }),
    }
    for (const s of Object.values(subs)) await s.call('join', room, 'talk')
    const cam = await pub.call<{ simulcast: boolean }>('enableCamera', { simulcast: true })
    expect(cam.simulcast, '시뮬캐스트로 발행됐다').toBe(true)
    for (const [k, s] of Object.entries(subs)) {
      await expect.poll(async () => (await video(s))?.framesDecoded ?? 0, { timeout: 25_000, message: `짝${round} ${k} 디코딩` }).toBeGreaterThan(10)
    }
    await expect.poll(async () => Object.keys(byRid(await pub.call<Enc[]>('encodings'))).filter((r) => r === 'h' || r === 'l').length, { timeout: 15_000 }).toBe(2)
    await wait(3_000)
    const hWidth = byRid(await pub.call<Enc[]>('encodings')).h!.frameWidth ?? 0
    const tids = { default: (await video(subs.default))!.id, off: (await video(subs.off))!.id }
    await Promise.all(Object.entries(subs).map(([k, s]) => s.call('setLayer', tids[k as 'default' | 'off'], { spatial: 1 })))
    for (const [k, s] of Object.entries(subs)) {
      await expect.poll(async () => (await video(s))?.frameWidth ?? 0, { timeout: 30_000, intervals: [250], message: `짝${round} ${k} 첫 h` }).toBe(hWidth)
    }
    await wait(2_000)
    const rows: string[] = []
    let a = { default: (await video(subs.default))!, off: (await video(subs.off))! }
    for (const [step, spatial] of [['→l', 0], ['→h', 1], ['→l', 0], ['→h', 1]] as const) {
      await Promise.all(Object.entries(subs).map(([k, s]) => s.call('setLayer', tids[k as 'default' | 'off'], { spatial })))
      await wait(6_000)
      const b = { default: (await video(subs.default))!, off: (await video(subs.off))! }
      for (const k of ['default', 'off'] as const) {
        const d = (f: keyof In) => ((b[k][f] as number | null) ?? 0) - ((a[k][f] as number | null) ?? 0)
        const widthOk = spatial === 1 ? b[k].frameWidth === hWidth : (b[k].frameWidth ?? 0) < hWidth
        rows.push(`  [picid] 짝${round} ${k.padEnd(7)} ${step} 폭 ${a[k].frameWidth}→${b[k].frameWidth}(${widthOk ? '도달' : '★미도달'}) · 6초 디코딩 Δ${d('framesDecoded')} · 키프레임 Δ${d('keyFramesDecoded')} · PLI Δ${d('pliCount')} · 얼어붙음 Δ${d('freezeCount')}`)
      }
      a = b
    }
    process.stdout.write(`\n${rows.join('\n')}\n`)
  } finally {
    await S.teardown()
    await offBrowser.close()
  }
}

test.describe.configure({ mode: 'serial' })
for (const round of [1, 2, 3]) {
  test(`PICID-JUMP VP8 짝 ${round}`, { annotation: { type: 'spec', description: '정:IMPL-FWD-SOURCE-SWITCH · 연:RULE-LINK-SOURCE-SWITCH' } }, async ({ browser }) => {
    test.setTimeout(150_000)
    await measurePair(browser, round)
  })
}
for (const codec of ['VP8', 'H264'] as const) {
  for (const legacyOff of [false, true]) {
    test(`PICID-JUMP ${codec} · 갈래 ${legacyOff ? 'Disabled' : '기본'}`, { annotation: { type: 'spec', description: '정:IMPL-FWD-SOURCE-SWITCH · 연:RULE-LINK-SOURCE-SWITCH' } }, async ({ browser }) => {
      test.setTimeout(150_000)
      await measure(browser, codec, legacyOff)
    })
  }
}
