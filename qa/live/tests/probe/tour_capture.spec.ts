// author: kodeholic (powered by Claude)
// ★실측 탐침 — 학습 문서(context/guide/learn)의 콜 플로우 재료를 한 번에 거둔다. 판정하지 않는다.
//   거두는 것: 브라우저 WS 프레임(보냄 · 받음) · SDP 두 벌(setLocal · setRemote) · ICE · DC 상태 · SDK 전이 · 서버 표면(/admin).
//   서버 로그는 정리(LEAVE)까지 본 뒤 이 회차의 시각 창으로 자른다(개발 형상 로그 자리 /tmp/oxlens/<node>/ox.log.<날짜> · stat 줄 뺌).
//   산출: <저장소>/.archive/tour/tour-<시각>/tour.json(TOUR_OUT 으로 바꾼다).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../../fixtures/scope.js'
import { ROOT, placementOf, roomFor, sfuIds } from '../../fixtures/env.js'

const S = new Scope('tour')
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString()
const STAMP = local(new Date()).replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const OUT = process.env.TOUR_OUT ?? join('..', '..', '.archive', 'tour', `tour-${STAMP}`)

/** 개발 형상 로그 — 로컬 날짜의 파일에서 [from, to] 창 · stat 줄을 뺀다. */
function serverLog(node: string, from: Date, to: Date): string[] {
  const d = local(from).slice(0, 10)
  const f = `/tmp/oxlens/${node}/ox.log.${d}`
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter((l) => {
    if (!l.startsWith('ts=') || l.includes(' kind=stat ')) return false
    const at = new Date(l.slice(3, l.indexOf(' ')))
    return at >= from && at <= to
  })
}

test.afterEach(async () => { await S.teardown() })

interface Frame { at: string; who: string; dir: 'send' | 'recv'; data: string }

/** 브라우저 안 — RTCPeerConnection 을 감싸 SDP · ICE · DC 를 시각과 함께 남긴다. */
function hookPc(): void {
  const log: unknown[] = []
  ;(window as unknown as { __tour: unknown[] }).__tour = log
  const Orig = window.RTCPeerConnection
  let n = 0
  class Hooked extends Orig {
    constructor(cfg?: RTCConfiguration) {
      super(cfg)
      const pc = n++
      const put = (ev: string, body: unknown) => log.push({ at: new Date().toISOString(), pc, ev, body })
      put('new', null)
      this.addEventListener('iceconnectionstatechange', () => put('ice', this.iceConnectionState))
      this.addEventListener('connectionstatechange', () => put('conn', this.connectionState))
      this.addEventListener('datachannel', (e) => put('dc-remote', e.channel.label))
      this.addEventListener('track', (e) => put('track', { kind: e.track.kind, mid: e.transceiver.mid, streams: e.streams.map((s) => s.id) }))
      const sl = this.setLocalDescription.bind(this)
      const sr = this.setRemoteDescription.bind(this)
      this.setLocalDescription = async (d?: RTCLocalSessionDescriptionInit) => {
        await sl(d as RTCSessionDescriptionInit)
        put('local', { type: this.localDescription?.type, sdp: this.localDescription?.sdp })
      }
      this.setRemoteDescription = async (d: RTCSessionDescriptionInit) => {
        put('remote', { type: d.type, sdp: d.sdp })
        await sr(d)
      }
      const cdc = this.createDataChannel.bind(this)
      this.createDataChannel = (label: string, opts?: RTCDataChannelInit) => {
        const ch = cdc(label, opts)
        put('dc-local', { label, opts: opts ?? null })
        ch.addEventListener('open', () => put('dc-open', label))
        return ch
      }
    }
  }
  window.RTCPeerConnection = Hooked as typeof RTCPeerConnection
}

test('TOUR-01 입장 → 발행 → 구독 → 영상이 보이기까지', { annotation: { type: 'spec', description: 'none' } }, async ({ browser }) => {
  const ids = await sfuIds()
  let role = 0
  while (placementOf(roomFor('tour', `p${role}`), ids) !== 'node-a') role++
  const ROOM = S.room(`p${role}`)

  const ctx = await browser.newContext()
  await ctx.addInitScript(hookPc)
  const frames: Frame[] = []
  const pages = new Map<unknown, string>()
  let next = ''
  ctx.on('page', (p) => {
    pages.set(p, next)
    p.on('websocket', (ws) => {
      const who = pages.get(p) ?? '?'
      const put = (dir: Frame['dir']) => (f: { payload: string | Buffer }) =>
        frames.push({ at: new Date().toISOString(), who, dir, data: typeof f.payload === 'string' ? f.payload : `b64:${f.payload.toString('base64')}` })
      ws.on('framesent', put('send'))
      ws.on('framereceived', put('recv'))
    })
  })
  const steps: { at: string; step: string }[] = []
  const mark = (step: string) => steps.push({ at: new Date().toISOString(), step })

  mark('ensureRoom')
  await ensureRoom(ROOM)
  next = 'A'
  mark('A.connect')
  const a = await S.open(ctx, { userId: S.user('A') })
  mark('A.join')
  await a.call('join', ROOM, 'talk')
  next = 'B'
  mark('B.connect')
  const b = await S.open(ctx, { userId: S.user('B') })
  mark('B.join')
  await b.call('join', ROOM, 'talk')
  mark('B.enableMic')
  await b.call('enableMic')
  mark('B.enableCamera')
  await b.call('enableCamera')

  const videoOf = async (p: Participant) => (await p.call<{ id: string; kind: string; videoWidth?: number }[]>('trackStats'))
    .find((s) => s.kind === 'video' && !s.id.startsWith('ptt-'))
  await expect.poll(() => videoOf(a).then((v) => v?.videoWidth ?? 0), { timeout: 20_000 }).toBeGreaterThan(0)
  mark('A.videoDecoded')

  const statsA1 = await a.call('trackStats')
  await new Promise((r) => setTimeout(r, 2_500))
  const statsA2 = await a.call('trackStats')
  const statsB = { local: await b.call('localTracks'), encodings: await b.call('encodings') }
  mark('collect')

  const admin = async (path: string) => {
    const res = await fetch(`${ROOT}${path}`)
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const pcA = await a.page.evaluate(() => (window as unknown as { __tour: unknown }).__tour)
  const pcB = await b.page.evaluate(() => (window as unknown as { __tour: unknown }).__tour)
  const diag = { A: await a.call('diag'), B: await b.call('diag') }
  const rooms = { A: await a.call('rooms'), B: await b.call('rooms') }
  const server = {
    room: await admin(`/admin/rooms/${ROOM}/snapshot`),
    userA: await admin(`/admin/users/${S.user('A')}/media`),
    userB: await admin(`/admin/users/${S.user('B')}/media`),
  }
  mark('teardown')
  await S.teardown()
  await new Promise((r) => setTimeout(r, 500))
  const end = new Date()
  const out = {
    room: ROOM, node: 'node-a', sfus: ids, steps, frames,
    pc: { A: pcA, B: pcB }, diag, rooms,
    stats: { A1: statsA1, A2: statsA2, B: statsB },
    server,
    log: Object.fromEntries(ids.map((n) => [n, serverLog(n, new Date(steps[0]!.at), end)])),
  }
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'tour.json'), JSON.stringify(out, null, 2))
  process.stdout.write(`  tour → ${OUT}/tour.json\n`)
})
