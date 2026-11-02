// author: kodeholic (powered by Claude)
// SDK:RULE-DOC-SDK-CONTRACT 합격 기준 ② · SDK:RULE-DOC-WRITING-SDK 「API 는 예제가 계약의 일부」 — 문서(DOC — 가로지르는 것) 1층. 예제 앱 둘(examples/)이 표면만 보고 컴파일되고 가짜 wire 위에서 도는가(K-accept-2)를 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws)에 이 파일의 작은 가짜 서버(요청마다 답한다) · ★진짜 PeerLink 위 가짜 RTCPeerConnection(트랜시버마다 절을 짓는 offer) · 가짜 navigator · window · 예제가 선언한 app 전역.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeWS, tick, type Frame } from './_ws.js'
import { BIND_OK, SA } from './_rig.js'
import { Op, type RoomJoinRes } from '../src/internal/wire/ws.js'
import * as Dispatch from '../examples/dispatch-console.js'
import * as Handset from '../examples/ptt-handset.js'

// ══ 가짜 RTCPeerConnection — 트랜시버마다 절을 짓는 브라우저 offer · 서버 offer 의 절마다 트랜시버 ═══════════════

const H264 = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'
type Desc = { type: string; sdp?: string }
interface Tr { mid: string | null; kind: string; direction: string; sender: object; receiver: { track: unknown } }

class FakeDC {
  readyState = 'connecting'
  binaryType = 'blob'
  readonly sent: unknown[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  open(): void { this.readyState = 'open'; this.onopen?.() }
  close(): void { this.readyState = 'closed' }
  send(b: unknown): void { this.sent.push(b) }
}

let ssrcSeq = 3000
class FakePC {
  static made: FakePC[] = []
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription: Desc | null = null
  remoteDescription: Desc | null = null
  oniceconnectionstatechange: (() => void) | null = null
  ontrack: (() => void) | null = null
  sctp: { state: string; onstatechange: null; transport: { state: string; onstatechange: null } } | null = null
  readonly dcs: FakeDC[] = []
  readonly trs: Tr[] = []
  private appMid: string | null = null
  private nextMid = 0
  private readonly ssrc = new Map<Tr, number>()
  constructor() { FakePC.made.push(this) }
  createDataChannel(): FakeDC { const d = new FakeDC(); this.dcs.push(d); return d }
  addTransceiver(kind: string, init: { direction?: string }): Tr {
    const t: Tr = { mid: null, kind, direction: init.direction ?? 'sendrecv', sender: { replaceTrack: async () => undefined, getParameters: () => ({ encodings: [{}] }), setParameters: async () => undefined, getStats: async () => new Map() }, receiver: { track: null } }
    this.trs.push(t)
    return t
  }
  getTransceivers(): Tr[] { return this.trs }
  /** 브라우저 offer — DC 는 먼저 만든 절(mid 0) · 트랜시버는 만든 차례로 mid · 보내는 절엔 SSRC */
  async createOffer(): Promise<Desc> {
    if (this.appMid === null && this.dcs.length) this.appMid = String(this.nextMid++)
    for (const t of this.trs) if (t.mid === null) t.mid = String(this.nextMid++)
    const secs: string[][] = []
    const mids: string[] = []
    if (this.appMid !== null) { mids.push(this.appMid); secs.push(['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:cliUf9', 'a=ice-pwd:cliPw9', 'a=fingerprint:sha-256 11:22', 'a=setup:actpass', `a=mid:${this.appMid}`, 'a=sctp-port:5000', 'a=max-message-size:262144']) }
    for (const t of this.trs) {
      mids.push(t.mid!)
      const send = t.direction === 'sendonly' || t.direction === 'sendrecv'
      if (send && !this.ssrc.has(t)) this.ssrc.set(t, ++ssrcSeq * 2)
      const s = this.ssrc.get(t)
      if (t.kind === 'audio') {
        secs.push(['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', `a=mid:${t.mid}`, 'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid', `a=${t.direction}`, 'a=rtcp-mux', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', ...(send ? [`a=ssrc:${s} cname:cli`] : [])])
      } else {
        secs.push(['m=video 9 UDP/TLS/RTP/SAVPF 102 103', 'c=IN IP4 0.0.0.0', `a=mid:${t.mid}`, 'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid', `a=${t.direction}`, 'a=rtcp-mux', 'a=rtpmap:102 H264/90000', `a=fmtp:102 ${H264}`, 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', ...(send ? [`a=ssrc-group:FID ${s} ${s! + 1}`, `a=ssrc:${s} cname:cli`, `a=ssrc:${s! + 1} cname:cli`] : [])])
      }
    }
    const order = mids.map((m, i) => [Number(m), i] as const).sort((a, b) => a[0] - b[0])
    const lines = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', `a=group:BUNDLE ${order.map(([m]) => m).join(' ')}`, 'a=msid-semantic: WMS', ...order.flatMap(([, i]) => secs[i]!)]
    return { type: 'offer', sdp: lines.join('\r\n') + '\r\n' }
  }
  async createAnswer(): Promise<Desc> { return { type: 'answer', sdp: this.remoteDescription?.sdp ?? '' } }
  async setLocalDescription(d: Desc): Promise<void> {
    if (d.type === 'rollback') { this.signalingState = 'stable'; return }
    this.localDescription = d
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(d: Desc): Promise<void> {
    this.remoteDescription = d
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'
    this.sctp ??= { state: 'connected', onstatechange: null, transport: { state: 'connected', onstatechange: null } }
    // 협상이 섰다 — ICE 가 붙고 DC 가 열린다(브라우저 사실)
    setTimeout(() => {
      if (this.iceConnectionState !== 'connected') { this.iceConnectionState = 'connected'; this.oniceconnectionstatechange?.() }
      for (const dc of this.dcs) if (dc.readyState === 'connecting') dc.open()
    }, 0)
  }
  async getStats(): Promise<Map<string, unknown>> { return new Map() }
  close(): void { this.signalingState = 'closed' }
}
;(globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePC

// ══ 가짜 장치 · 창 · 예제의 app 전역 ═════════════════════════════════════════════════════════════════

function devTrack(kind: string): object {
  return { kind, id: `${kind}-${++ssrcSeq}`, enabled: true, readyState: 'live', muted: false, stop() { (this as { readyState: string }).readyState = 'ended' }, addEventListener: () => undefined, removeEventListener: () => undefined, getSettings: () => ({ deviceId: kind === 'audio' ? 'mic-1' : 'cam-1' }), applyConstraints: () => Promise.resolve() }
}
const stream = (t: { kind: string }): unknown => ({ getAudioTracks: () => (t.kind === 'audio' ? [t] : []), getVideoTracks: () => (t.kind === 'video' ? [t] : []), getTracks: () => [t] })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  userAgent: 'TestAgent/1.0',
  mediaDevices: {
    enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'mic-1', label: 'mic', groupId: 'g1' }, { kind: 'videoinput', deviceId: 'cam-1', label: 'cam', groupId: 'g2' }],
    getUserMedia: async (c: MediaStreamConstraints) => stream(devTrack(c.audio ? 'audio' : 'video') as { kind: string }),
    addEventListener: () => undefined, removeEventListener: () => undefined,
  },
  permissions: { query: async () => ({ state: 'granted' }) },
} })

/** 이벤트 대상 하나 — 예제가 거는 리스너를 시험이 쏜다 */
function target(): { addEventListener(n: string, f: (e: unknown) => void): void; removeEventListener(n: string, f: (e: unknown) => void): void; fire(n: string, e?: unknown): void } {
  const ls = new Map<string, ((e: unknown) => void)[]>()
  return { addEventListener: (n, f) => { ls.set(n, [...(ls.get(n) ?? []), f]) }, removeEventListener: (n, f) => { ls.set(n, (ls.get(n) ?? []).filter((x) => x !== f)) }, fire: (n, e = {}) => { for (const f of ls.get(n) ?? []) f(e) } }
}
const win = target()
;(globalThis as unknown as { window: unknown }).window = win

interface Ui { calls: [string, unknown[]][]; of(n: string): unknown[][] }
function ui(): Ui & Record<string, unknown> {
  const calls: [string, unknown[]][] = []
  return new Proxy({ calls, of: (n: string) => calls.filter(([k]) => k === n).map(([, a]) => a) } as Ui & Record<string, unknown>, {
    get: (o, k) => (k in o ? o[k as string] : (...a: unknown[]) => { calls.push([String(k), a]) }),
  })
}

// ══ 작은 가짜 서버 — 받은 요청마다 그 op 의 응답을 낸다 ══════════════════════════════════════════════

interface Server { ws: FakeWS; stop(): void; joins: string[]; pubs: Record<string, unknown>[] }
function serve(): Server {
  const s: Server = { ws: undefined as unknown as FakeWS, stop: () => undefined, joins: [], pubs: [] }
  const done = new Set<string>()
  const sub = new Set<string>()
  let pub: string | null = null
  let track = 0
  let alive = true
  const answer = (ws: FakeWS, f: Frame): void => {
    const b = (f.body ?? {}) as Record<string, unknown>
    switch (f.op) {
      case Op.BIND: ws.answer(f, BIND_OK); return
      case Op.ROOM_JOIN: {
        const id = String(b['room_id'])
        sub.add(id); s.joins.push(id)
        if (b['select'] === true) pub = id
        const me = { user_id: 'u1', select: b['select'] === true, participant_type: 0 as const, permission: { publish_audio: true, publish_video: true, publish_screen: true, floor_request: true } }
        const body: RoomJoinRes = {
          room_id: id, participants: [me, { user_id: 'u2', select: true, participant_type: 0 }], me, affiliation: { sub_rooms: [...sub], pub_room: pub },
          server_config: SA, tracks: [], version: { epoch: 'e1', seq: 1 }, media_codecs: { audio: 'opus', video: 'H264' }, mline_table: { sfu_id: SA.sfu_id, arev: 1, mlines: [] },
        }
        ws.answer(f, body); return
      }
      case Op.AFFILIATION: {
        if (typeof b['pub_deselect'] === 'string' && pub === b['pub_deselect']) pub = null
        if (typeof b['pub_select'] === 'string') pub = b['pub_select']
        ws.answer(f, { sub_rooms: [...sub], pub_room: pub, cause: 'user' }); return
      }
      case Op.PUBLISH_TRACKS: {
        s.pubs.push(b)
        const ts = (b['tracks'] as { mid: string }[] | undefined) ?? []
        ws.answer(f, b['action'] === 'add' ? { tracks: ts.map((t) => ({ mid: t.mid, track_id: `t-${++track}` })) } : {}); return
      }
      default: ws.answer(f, {})
    }
  }
  const loop = async (): Promise<void> => {
    while (alive) {
      const ws = FakeWS.made.at(-1)
      if (ws) {
        if (ws.readyState === 0) ws.open()
        s.ws = ws
        for (const f of ws.frames()) {
          const key = `${FakeWS.made.length}:${f.pid}`
          if (f.kind !== 'request' || done.has(key)) continue
          done.add(key)
          answer(ws, f)
        }
      }
      await tick(2)
    }
  }
  void loop()
  s.stop = () => { alive = false }
  return s
}

const stops: (() => void)[] = []
afterEach(async () => {
  for (const f of stops.splice(0)) f()
  win.fire('pagehide')
  await tick(10)
})

async function until(ok: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let t = 0; t < ms && !ok(); t += 5) await tick(5)
  assert.ok(ok(), `시한 안에 서지 않았다: ${what}`)
}

const g = globalThis as unknown as { app: unknown }

test('K-accept-2 — 예제 앱 둘(지령대 · PTT 단말)이 표면만 보고 tsc --noEmit 를 통과하고 가짜 wire 위에서 돈다', async () => {
  // ① 컴파일 — 예제 둘 + 공개 배럴(src)만으로
  const dir = mkdtempSync(join(tmpdir(), 'oxsdk-examples-'))
  const cfg = join(dir, 'tsconfig.json')
  const root = process.cwd()
  writeFileSync(cfg, JSON.stringify({ extends: join(root, 'tsconfig.json'), include: [join(root, 'examples'), join(root, 'src')] }))
  const tsc = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', cfg], { encoding: 'utf8' })
  assert.equal(tsc.status, 0, `K-accept-2 — 예제 둘 tsc --noEmit 통과: ${tsc.stdout}${tsc.stderr}`)

  // ② 지령대 — 채널 셋 듣기 · 셋째 채널을 발언 방으로 · Space 로 누르면 발언권 요청이 DC 로 나간다
  FakeWS.made.length = 0
  FakeWS.auto.clear()
  FakePC.made.length = 0
  const srv = serve(); stops.push(srv.stop)
  const d = ui()
  g.app = { base: 'https://hub.example', fetchToken: async () => 'tok', channels: ['c1', 'c2', 'c3'], ui: d }
  await Dispatch.main()
  assert.ok(d.of('connection').some(([s]) => s === 'active'), 'K-accept-2 — 지령대: 접속 상태가 ui 에 닿는다')
  assert.deepEqual([...new Set(srv.joins)].sort(), ['c1', 'c2', 'c3'], 'K-accept-2 — 지령대: 채널마다 입장(기본 listen)')
  await until(() => d.of('roster').length > 0 || d.of('speakingChannel').length > 0, 'roster · speakingChannel')
  assert.ok(d.of('speakingChannel').some(([c]) => c === 'c3'), 'K-accept-2 — 지령대: 셋째 채널이 발언 방(speakingRoom 이벤트)')
  const dcs = (): number => FakePC.made.flatMap((p) => p.dcs).reduce((n, x) => n + x.sent.length, 0)
  const before = dcs()
  win.fire('keydown', { code: 'Space', repeat: false })
  await until(() => d.of('ptt').some(([c]) => c === 'c3'), 'ptt 상태가 ui 에')
  await until(() => dcs() > before, '발언권 REQUEST 가 DC 로', 5000)
  assert.ok(dcs() > before && srv.pubs.some((p) => p['action'] === 'add'), 'K-accept-2 — 지령대: Space → press 가 반이중 마이크를 발행하고 발언권 요청이 DC 로 나간다')
  win.fire('keyup', { code: 'Space' })
  await tick(10)
  win.fire('pagehide'); await tick(10)
  srv.stop()

  // ③ PTT 단말 — 말하기 모드 입장 · 미리 데우기 · 무전 영상 · 버튼 클릭이 발언권 요청
  FakeWS.made.length = 0
  FakePC.made.length = 0
  const srv2 = serve(); stops.push(srv2.stop)
  const h = ui()
  const button = { ...target(), disabled: false }
  g.app = { base: 'https://hub.example', roomId: 'r1', fetchToken: async () => 'tok', button, ui: h }
  await Handset.main()
  assert.ok(h.of('status').some(([s]) => String(s).startsWith('active')), 'K-accept-2 — 단말: 접속 상태가 ui 에 닿는다')
  const adds = srv2.pubs.filter((p) => p['action'] === 'add').flatMap((p) => p['tracks'] as { kind: string; duplex: string }[])
  assert.deepEqual(adds.map((t) => `${t.kind}:${t.duplex}`).sort(), ['audio:half', 'video:half'], 'K-accept-2 — 단말: ptt.enable · enableVideo 가 반이중 마이크 · 영상을 발행')
  const b2 = FakePC.made.flatMap((p) => p.dcs).reduce((n, x) => n + x.sent.length, 0)
  button.fire('click')
  await until(() => FakePC.made.flatMap((p) => p.dcs).reduce((n, x) => n + x.sent.length, 0) > b2, '단말 발언권 REQUEST', 5000)
  assert.ok(h.of('ptt').length > 0, 'K-accept-2 — 단말: 버튼 클릭 → press → ptt 상태가 ui 에 · 발언권 요청이 DC 로')
  win.fire('pagehide'); await tick(10)
  srv2.stop()
})
