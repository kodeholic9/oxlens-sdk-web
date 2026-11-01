// author: kodeholic (powered by Claude)
// ★실측(probe) — 시뮬캐스트 발행자 엔진이 층 PLI 에 어떻게 키프레임을 내나(202610/20261028c R2 — 「실측 먼저 · 협상은 그 뒤」).
//   판정이 아니라 수치다 — 정규 게이트 밖(chromium-probe). 근거 사실: libwebrtc `video/encoder_rtcp_feedback.cc`
//   (300ms 안의 요청은 버린다 · `x-google-per-layer-pli` 가 없으면 타이머 하나 · 받아들이면 모든 층이 키프레임).
//   한 축만 바꾼다 — 발행자 쪽 remote SDP 의 video fmtp 에 `x-google-per-layer-pli=1` 이 있는 판과 없는 판.
//   SDK 는 시뮬캐스트 발행 answer 에 그것을 싣는다(연:RULE-LINK-SDP-PUB-MLINE 예외 둘) — 없는 판은 그것을 걷어 낸다.
import { test, type BrowserContext } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../../fixtures/scope.js'

const S = new Scope('pli_layer')
const LAYERS = [{ rid: 'l', scaleResolutionDownBy: 2, maxBitrate: 150_000, maxFramerate: 15 }, { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 500_000, maxFramerate: 30 }]

test.afterEach(async () => { await S.teardown() })

interface Enc { rid: string | null; keyFramesEncoded: number | null; pliCount: number | null; framesEncoded: number | null; fmtp: string | null }
interface In { id: string; kind: string; framesDecoded: number | null; keyFramesDecoded: number | null; freezeCount: number | null; pliCount: number | null; frameWidth: number | null }

/** ★발행자 페이지에만 — remote SDP 의 video 코덱마다 fmtp 에 그 손잡이를 단다 · on 이 아니면 걷어 낸다(브라우저 엔진은 송신 코덱 파라미터를 상대 SDP 에서 읽는다). */
async function perLayerPli(ctx: BrowserContext, on: boolean): Promise<void> {
  await ctx.addInitScript((on: boolean) => {
    const strip = (sdp: string): string => sdp.split('\r\n')
      .filter((l) => !/^a=fmtp:\d+ x-google-per-layer-pli=1$/.test(l))
      .map((l) => (l.startsWith('a=fmtp:') ? l.replace(';x-google-per-layer-pli=1', '') : l))
      .join('\r\n')
    const munge = (sdp: string): string => {
      if (!on) return strip(sdp)
      const out: string[] = []
      let video = false
      let pts: string[] = []
      const lines = sdp.split('\r\n')
      const fm = new Set<string>()
      for (const l of lines) {
        if (l.startsWith('m=')) { video = l.startsWith('m=video'); pts = video ? l.split(' ').slice(3) : [] }
        if (video && l.startsWith('a=fmtp:')) fm.add(l.slice(7).split(' ')[0]!)
      }
      video = false
      for (const l of lines) {
        if (l.startsWith('m=')) { video = l.startsWith('m=video'); pts = video ? l.split(' ').slice(3) : [] }
        if (video && l.startsWith('a=fmtp:') && !l.includes('x-google-per-layer-pli')) { out.push(`${l};x-google-per-layer-pli=1`); continue }
        out.push(l)
        const m = video ? /^a=rtpmap:(\d+) /.exec(l) : null
        if (m && pts.includes(m[1]!) && !fm.has(m[1]!)) out.push(`a=fmtp:${m[1]} x-google-per-layer-pli=1`)
      }
      return out.join('\r\n')
    }
    const orig = RTCPeerConnection.prototype.setRemoteDescription
    RTCPeerConnection.prototype.setRemoteDescription = function (this: RTCPeerConnection, d?: RTCSessionDescriptionInit) {
      return orig.call(this, d && d.sdp ? { type: d.type, sdp: munge(d.sdp) } : d)
    } as typeof orig
  }, on)
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const byRid = (es: Enc[]) => Object.fromEntries(es.map((e) => [e.rid ?? '-', e])) as Record<string, Enc>

async function measure(browser: import('@playwright/test').Browser, perLayer: boolean) {
  const room = S.room(perLayer ? 'on' : 'off')
  const pubCtx = await browser.newContext()
  await perLayerPli(pubCtx, perLayer)
  const subCtx = await browser.newContext()
  await ensureRoom(room)
  // ★두 층이 다 흘러야 잴 수 있다 — 서버 REMB 상한(정책 media.max_bitrate_bps 기본 800k)이 업링크 전체를 묶어 기본 h(1.65M)는 서지 않는다(20261028 실측 · 별도 규격 결함 후보).
  //   이 실측만 층 비트레이트를 그 안으로 낮춘다(층별 키프레임 동작은 비트레이트와 무관하다).
  const pub = await S.open(pubCtx, { userId: S.user(perLayer ? 'PON' : 'POFF'), publishDefaults: { simulcastLayers: LAYERS } })
  await pub.call('join', room, 'talk')
  // ★SDK adaptiveStream 은 타일 폭 480px 미만이면 가장 낮은 층을 다시 보낸다(SDK:IMPL-TRK-RECEIVE) — 실측의 setLayer 를 덮지 않게 끈다.
  const sub = await S.open(subCtx, { userId: S.user(perLayer ? 'SON' : 'SOFF'), adaptiveStream: false })
  await sub.call('join', room, 'talk')
  const cam = await pub.call<{ simulcast: boolean }>('enableCamera', { simulcast: true })
  expect(cam.simulcast, '시뮬캐스트로 발행됐다(아니면 층 실측이 공허하다)').toBe(true)

  const video = async (p: Participant) => (await p.call<In[]>('trackStats')).find((s) => s.kind === 'video' && !s.id.startsWith('ptt-'))
  await expect.poll(async () => (await video(sub))?.framesDecoded ?? 0, { timeout: 25_000, message: '구독자가 영상을 디코딩한다' }).toBeGreaterThan(10)
  await expect.poll(async () => Object.keys(byRid(await pub.call<Enc[]>('encodings'))).filter((r) => r === 'h' || r === 'l').length,
    { timeout: 15_000, message: '발행자 인코딩 h · l 둘이 선다' }).toBe(2)
  const tid = (await video(sub))!.id
  await wait(3_000)

  const rows: { step: string; dh: number; dl: number; dpliH: number; dpliL: number; dDec: number; dKeyDec: number; freeze: number; width: number | null }[] = []
  const snap = async () => ({ e: byRid(await pub.call<Enc[]>('encodings')), i: (await video(sub))! })
  let a = await snap()
  for (const [step, spatial] of [['→l', 0], ['→h', 1], ['→l', 0], ['→h', 1], ['→l', 0], ['→h', 1]] as const) {
    await sub.call('setLayer', tid, { spatial })
    await wait(2_500)
    const b = await snap()
    rows.push({
      step,
      dh: (b.e.h!.keyFramesEncoded ?? 0) - (a.e.h!.keyFramesEncoded ?? 0),
      dl: (b.e.l!.keyFramesEncoded ?? 0) - (a.e.l!.keyFramesEncoded ?? 0),
      dpliH: (b.e.h!.pliCount ?? 0) - (a.e.h!.pliCount ?? 0),
      dpliL: (b.e.l!.pliCount ?? 0) - (a.e.l!.pliCount ?? 0),
      dDec: (b.i.framesDecoded ?? 0) - (a.i.framesDecoded ?? 0),
      dKeyDec: (b.i.keyFramesDecoded ?? 0) - (a.i.keyFramesDecoded ?? 0),
      freeze: (b.i.freezeCount ?? 0) - (a.i.freezeCount ?? 0),
      width: b.i.frameWidth,
    })
    a = b
  }
  const last = await pub.call<Enc[]>('encodings')
  const pairs = await pub.call<{ nominated: boolean | null; availableOutgoingBitrate: number | null }[]>('icePairs')
  process.stdout.write(`\n  [probe per-layer=${perLayer}] 발행자 송신 추정(availableOutgoingBitrate): ${JSON.stringify(pairs.filter((x) => x.nominated).map((x) => x.availableOutgoingBitrate))}\n`)
  process.stdout.write(`\n  [probe per-layer=${perLayer}] 인코딩 끝 상태: ${JSON.stringify(last.map((e) => ({ rid: e.rid, frames: e.framesEncoded, w: (e as unknown as { frameWidth: number }).frameWidth, active: (e as unknown as { active: boolean }).active, limit: (e as unknown as { limit: string }).limit, bytes: (e as unknown as { bytesSent: number }).bytesSent })))}\n`)
  const fmtp = byRid(last).h!.fmtp
  return { rows, fmtp }
}

for (const perLayer of [false, true]) {
  test(`PROBE-PLI-LAYER-${perLayer ? 'ON' : 'OFF'} 층 전환마다 층별 키프레임 · PLI(x-google-per-layer-pli ${perLayer ? '있음' : '없음'})`, async ({ browser }) => {
    const { rows, fmtp } = await measure(browser, perLayer)
    process.stdout.write(`\n  [probe per-layer=${perLayer}] 송신 코덱 fmtp: ${fmtp}\n`)
    process.stdout.write('  단계 | h 키프레임 Δ | l 키프레임 Δ | h PLI Δ | l PLI Δ | 디코딩 Δ | 수신 키프레임 Δ | 얼어붙음 Δ | 수신 폭\n')
    for (const r of rows) process.stdout.write(`  ${r.step} | ${r.dh} | ${r.dl} | ${r.dpliH} | ${r.dpliL} | ${r.dDec} | ${r.dKeyDec} | ${r.freeze} | ${r.width}\n`)
    test.info().annotations.push({ type: 'probe', description: JSON.stringify({ perLayer, fmtp, rows }) })
    expect(fmtp?.includes('x-google-per-layer-pli') ?? false, '한 축만 바꿨다 — 송신 코덱 fmtp 에 손잡이가 실렸나').toBe(perLayer)
    for (const r of rows) expect(r.dDec, `${r.step} 동안 디코딩이 멎지 않는다`).toBeGreaterThan(0)
  })
}
