// author: kodeholic (powered by Claude)
// ★실측(probe) — 「구독 줄을 처음에 다 깐다」(context 202611/20261107d G1 · 20261107e G6)가 값이 있는가. 서버 · SDK 는 그대로 두고 지금 경로만 잰다.
//   ① 지금 경로의 A/B — 같은 구독자에게 ★새 줄이 생기는 구독(연:RULE-SUB-FILL 「상한 안에서 새 줄 — 구독 SDP 가 바뀐다」)과
//      ★빈 줄을 다시 쓰는 구독(「같은 kind 의 빈 줄이 있으면 그것을 쓰고 — 표만 온다」 · 정:sub.md `Table::sync` free 줄 · mid 작은 것부터)을 번갈아 만든다.
//      둘의 차 = 줄을 미리 깔았을 때 얻을 수 있는 이득의 상한(미리 깔아도 표 + READY{arev} 한 왕복은 남는다 — 연:RULE-SUB-EGRESS-ACKED).
//   ② 빈 줄의 값 — ①에서 잡은 실제 구독 offer 를 본떠 N 줄(줄마다 a=ssrc · 같은 튜플)을 따로 띄운 브라우저에 먹이고
//      협상 시간 · SDP 크기 · 렌더러 RSS · 쉬는 동안 렌더러 CPU 를 잰다.
//   판정이 아니라 수치다 — 정규 게이트 밖(chromium-probe).
import { execFileSync } from 'node:child_process'
import { chromium, test, type Page } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../../fixtures/scope.js'

const S = new Scope('subline_grow')
const ROOM = S.room()
const MEDIA = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']

test.describe.configure({ mode: 'serial' })
test.afterEach(async () => { await S.teardown() })

interface Nego { what: string; type: string | null; t0: number; t1: number; mlines: number; len: number }
interface In { id: string; kind: string; framesDecoded: number | null; freezeCount: number | null; freezeMs: number | null; packets: number | null }
interface Ev { at: number; kind: string; detail: { id?: string; kind?: string; userId?: string | null } }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 구독자 페이지 — SDP 를 넣는 세 부름의 시각 · 크기를 남긴다(값은 바꾸지 않는다). */
const NEGO_LOG = () => {
  const w = window as unknown as { __nego: unknown[] }
  w.__nego = []
  const P = RTCPeerConnection.prototype
  const count = (sdp: string | undefined) => (sdp ? sdp.split('\r\n').filter((l) => l.startsWith('m=')).length : 0)
  const srd = P.setRemoteDescription
  P.setRemoteDescription = async function (this: RTCPeerConnection, d?: RTCSessionDescriptionInit) {
    const t0 = performance.now()
    const r = await srd.call(this, d as RTCSessionDescriptionInit)
    w.__nego.push({ what: 'srd', type: d?.type ?? null, t0, t1: performance.now(), mlines: count(d?.sdp), len: d?.sdp?.length ?? 0 })
    return r
  } as typeof srd
  const sld = P.setLocalDescription
  P.setLocalDescription = async function (this: RTCPeerConnection, d?: RTCLocalSessionDescriptionInit) {
    const t0 = performance.now()
    const r = await sld.call(this, d as RTCLocalSessionDescriptionInit)
    w.__nego.push({ what: 'sld', type: d?.type ?? null, t0, t1: performance.now(), mlines: count(this.localDescription?.sdp), len: this.localDescription?.sdp.length ?? 0 })
    return r
  } as typeof sld
  const ca = P.createAnswer
  P.createAnswer = async function (this: RTCPeerConnection, o?: RTCAnswerOptions) {
    const t0 = performance.now()
    const r = await ca.call(this, o)
    w.__nego.push({ what: 'ca', type: 'answer', t0, t1: performance.now(), mlines: count(r.sdp), len: r.sdp?.length ?? 0 })
    return r
  } as typeof ca
}

const negos = (p: Participant) => p.page.evaluate(() => (window as unknown as { __nego: Nego[] }).__nego.slice())
const decoded = async (p: Participant, id: string) => (await p.call<In[]>('trackStats')).find((s) => s.id === id)?.framesDecoded ?? 0

const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN }
const summary = (xs: number[]) => xs.length ? `n=${xs.length} 중앙 ${pct(xs, 0.5).toFixed(0)} · 최소 ${Math.min(...xs).toFixed(0)} · 최대 ${Math.max(...xs).toFixed(0)}` : 'n=0'

test('SUBLINE-GROW ① 새 줄 vs 빈 줄 다시 쓰기 — 지금 경로', { annotation: { type: 'spec', description: '연:RULE-SUB-FILL · 연:RULE-SUB-TABLE-PROC · 연:RULE-LINK-SDP-RENEGOTIATE' } }, async ({ browser }) => {
  test.setTimeout(300_000)
  await ensureRoom(ROOM)
  const subCtx = await browser.newContext()
  await subCtx.addInitScript(NEGO_LOG)
  const sub = await S.open(subCtx, { userId: S.user('SUB'), adaptiveStream: false })
  await sub.call('join', ROOM, 'talk')
  await wait(1_500)

  const rows: { kind: 'new' | 'vacant'; negoDelta: number; negoMs: number; trackMs: number; frameMs: number }[] = []
  const open: Participant[] = []
  // 순서: 새 줄(+) · 나감(−) · 빈 줄(+) — 둘씩 번갈아. 나간 사람의 줄은 빈 줄로 남는다(연:RULE-SUB-TABLE-SERVER 「줄은 지우지 않는다」).
  const plan: ('add' | 'leave')[] = []
  for (let i = 0; i < 5; i++) plan.push('add', 'leave', 'add')
  let n = 0
  for (const step of plan) {
    if (step === 'leave') {
      const p = open.pop()!
      await p.call('teardown')
      await wait(2_500)
      continue
    }
    n += 1
    // ★이미 받던 영상(남은 발행자들)이 재협상 동안 끊기나 — 미리 깔기의 이득이 남는다면 여기다.
    const others0 = (await sub.call<In[]>('trackStats')).filter((x) => x.kind === 'video' && (x.packets ?? 0) > 0)
    const before = await negos(sub)
    const evBefore = (await sub.call<Ev[]>('events', 'track')).length
    const pubCtx = await browser.newContext()
    const pub = await S.open(pubCtx, { userId: S.user(`P${String(n).padStart(2, '0')}`) })
    await pub.call('join', ROOM, 'talk')
    const t0 = Date.now()
    await pub.call('enableCamera')
    let trackId = ''
    let tTrack = 0
    await expect.poll(async () => {
      const ev = (await sub.call<Ev[]>('events', 'track')).slice(evBefore).find((e) => e.detail.kind === 'video')
      if (ev) { trackId = ev.detail.id!; tTrack = ev.at }
      return trackId
    }, { timeout: 20_000, intervals: [50], message: `P${n} 영상 트랙이 구독자에게 안 붙는다` }).not.toBe('')
    // ★다운링크 SSRC 는 줄에 평생 붙어(연:RULE-LINK-DOWNLINK-SSRC) inbound 계수가 앞 주인 때부터 누적된다 — 트랙이 붙은 순간 값이 기준이다.
    const base = await decoded(sub, trackId)
    await expect.poll(async () => decoded(sub, trackId), { timeout: 20_000, intervals: [50], message: `P${n} 첫 디코딩` }).toBeGreaterThan(base)
    const tFrame = Date.now()
    await wait(800)
    const others1 = await sub.call<In[]>('trackStats')
    const disrupt = others0.map((o) => {
      const b = others1.find((x) => x.id === o.id)
      return { dDec: (b?.framesDecoded ?? 0) - (o.framesDecoded ?? 0), dFreeze: (b?.freezeCount ?? 0) - (o.freezeCount ?? 0), dFreezeMs: ((b?.freezeMs ?? 0) - (o.freezeMs ?? 0)) * 1000 }
    })
    const after = (await negos(sub)).slice(before.length)
    const offers = after.filter((x) => x.what === 'srd' && x.type === 'offer')
    const span = after.length ? Math.max(...after.map((x) => x.t1)) - Math.min(...after.map((x) => x.t0)) : 0
    rows.push({ kind: offers.length > 0 ? 'new' : 'vacant', negoDelta: offers.length, negoMs: span, trackMs: tTrack - t0, frameMs: tFrame - t0 })
    process.stdout.write(`\n  [subline] P${n} ${offers.length > 0 ? '새 줄' : '빈 줄'} · 구독 offer ${offers.length}회(줄 ${offers.at(-1)?.mlines ?? '-'} · ${offers.at(-1)?.len ?? '-'}B) · 협상 ${span.toFixed(1)}ms · 트랙 붙음 ${tTrack - t0}ms · 첫 디코딩 ${tFrame - t0}ms · 받던 영상 ${disrupt.length}개 — 그 창 디코딩 Δ[${disrupt.map((d) => d.dDec).join(',')}] · 얼어붙음 Δ${disrupt.reduce((a, d) => a + d.dFreeze, 0)}(${disrupt.reduce((a, d) => a + d.dFreezeMs, 0).toFixed(0)}ms)\n`)
    open.push(pub)
  }
  const pick = (k: 'new' | 'vacant', f: (r: typeof rows[number]) => number) => rows.filter((r) => r.kind === k).map(f)
  process.stdout.write(`\n  [subline] 요약 — 발행 호출 → 구독자 첫 디코딩(ms)\n` +
    `  [subline]   새 줄: ${summary(pick('new', (r) => r.frameMs))} · 트랙 붙음 ${summary(pick('new', (r) => r.trackMs))} · 협상 ${summary(pick('new', (r) => r.negoMs))}\n` +
    `  [subline]   빈 줄: ${summary(pick('vacant', (r) => r.frameMs))} · 트랙 붙음 ${summary(pick('vacant', (r) => r.trackMs))}\n`)
  // ② 의 바탕 — 실제 구독 offer
  const dump = await sub.call<{ remote: string | null }>('sdpDump')
  ;(globalThis as unknown as { __subOffer?: string }).__subOffer = dump.remote ?? ''
  for (const p of open) await p.call('teardown')
  expect(rows.filter((r) => r.kind === 'new').length, '새 줄 표본이 있다').toBeGreaterThan(0)
  expect(rows.filter((r) => r.kind === 'vacant').length, '빈 줄 표본이 있다').toBeGreaterThan(0)
})

/** 실제 구독 offer 에서 세션 머리와 마지막 video · audio 절을 떼어 N 줄을 짓는다(mid · ssrc · msid 만 바꾼다). */
function synth(offer: string, nVideo: number, nAudio: number): string {
  const parts = offer.split(/\r\n(?=m=)/)
  const head = parts[0]!.split('\r\n').filter((l) => l && !l.startsWith('a=group:BUNDLE')).join('\r\n')
  const video = parts.filter((p) => p.startsWith('m=video')).at(-1)
  const audio = parts.filter((p) => p.startsWith('m=audio')).at(-1)
  if (!video || !audio) throw new Error('구독 offer 에 video · audio 절이 없다')
  const out: string[] = []
  const mids: string[] = []
  let mid = 100
  let ssrc = 0x90000000
  const clone = (sec: string) => {
    mid += 1
    mids.push(String(mid))
    const s1 = (ssrc += 2)
    let secOut = sec.replace(/a=mid:[^\r\n]*/, `a=mid:${mid}`)
    const olds = [...new Set([...secOut.matchAll(/a=ssrc:(\d+)/g)].map((m) => m[1]!))]
    olds.forEach((o, i) => { secOut = secOut.replaceAll(`a=ssrc:${o} `, `a=ssrc:${s1 + i} `).replaceAll(` ${o} `, ` ${s1 + i} `).replace(new RegExp(` ${o}(\\r|$)`, 'g'), ` ${s1 + i}$1`) })
    secOut = secOut.replace(/a=msid:(\S+) (\S+)/, `a=msid:$1 tr${mid}`).replace(/msid:(\S+) (\S+)/g, `msid:$1 tr${mid}`)
    out.push(secOut.replace(/\r\n$/, ''))
  }
  for (let i = 0; i < nAudio; i++) clone(audio)
  for (let i = 0; i < nVideo; i++) clone(video)
  return `${head}\r\na=group:BUNDLE ${mids.join(' ')}\r\n${out.join('\r\n')}\r\n`
}

async function rendererPids(page: Page): Promise<number[]> {
  const cdp = await page.context().browser()!.newBrowserCDPSession()
  const info = await cdp.send('SystemInfo.getProcessInfo') as { processInfo: { id: number; type: string; cpuTime: number }[] }
  await cdp.detach()
  return info.processInfo.filter((p) => p.type === 'renderer').map((p) => p.id)
}
async function rendererCpu(page: Page): Promise<number> {
  const cdp = await page.context().browser()!.newBrowserCDPSession()
  const info = await cdp.send('SystemInfo.getProcessInfo') as { processInfo: { id: number; type: string; cpuTime: number }[] }
  await cdp.detach()
  return info.processInfo.filter((p) => p.type === 'renderer').reduce((a, p) => a + p.cpuTime, 0)
}
const rssKb = (pids: number[]) => pids.reduce((a, pid) => {
  try { return a + Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim() || 0) } catch { return a }
}, 0)

test('SUBLINE-GROW ② 빈 줄 N 개의 값 — 협상 시간 · SDP 크기 · 렌더러 메모리 · 쉬는 CPU', { annotation: { type: 'spec', description: '연:RULE-SUB-FILL · 연:RULE-ROOM-BUDGET-SPLIT' } }, async () => {
  test.setTimeout(240_000)
  const offer = (globalThis as unknown as { __subOffer?: string }).__subOffer
  test.skip(!offer, '①이 먼저 돌아 실제 구독 offer 를 잡아야 한다(같은 파일 · 차례대로)')
  for (const [nv, na] of [[1, 1], [5, 5], [13, 13], [25, 25], [48, 48]] as const) {
    const b = await chromium.launch({ args: MEDIA })
    try {
      const page = await (await b.newContext()).newPage()
      await page.goto('about:blank')
      await wait(1_000)
      const pids = await rendererPids(page)
      const rss0 = rssKb(pids)
      const sdp = synth(offer!, nv, na)
      const r = await page.evaluate(async (sdp) => {
        const pc = new RTCPeerConnection()
        ;(window as unknown as { __pc: RTCPeerConnection }).__pc = pc
        const t0 = performance.now()
        await pc.setRemoteDescription({ type: 'offer', sdp })
        const t1 = performance.now()
        const ans = await pc.createAnswer()
        const t2 = performance.now()
        await pc.setLocalDescription(ans)
        const t3 = performance.now()
        return { srd: t1 - t0, ca: t2 - t1, sld: t3 - t2, transceivers: pc.getTransceivers().length, answerLen: ans.sdp?.length ?? 0 }
      }, sdp)
      await wait(2_000)
      const rss1 = rssKb(pids)
      const c0 = await rendererCpu(page)
      await wait(10_000)
      const c1 = await rendererCpu(page)
      process.stdout.write(`\n  [subline②] 줄 ${nv + na}(video ${nv} · audio ${na}) · offer ${sdp.length}B · answer ${r.answerLen}B · 트랜시버 ${r.transceivers} · SRD ${r.srd.toFixed(1)}ms · createAnswer ${r.ca.toFixed(1)}ms · SLD ${r.sld.toFixed(1)}ms · 렌더러 RSS +${((rss1 - rss0) / 1024).toFixed(1)}MB · 쉬는 10초 렌더러 CPU ${(c1 - c0).toFixed(2)}s\n`)
    } finally {
      await b.close()
    }
  }
})

