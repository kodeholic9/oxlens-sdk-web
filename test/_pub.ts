// author: kodeholic (powered by Claude)
// 1층 발행 받침 — 가짜 장치(navigator.mediaDevices · permissions — platform/env 가 부르는 전역) · 가짜 발행 PeerLink(트랜시버 풀 · sender) · 방 하나(talk · 발언 방) 받침.
// 발행(pub.test) · 가로지르는 것(api · err · src · diag 시험)이 같이 쓴다. 불러들이면 globalThis.navigator 를 갈아 끼운다.
import { afterEach } from 'node:test'
import { tick } from './_ws.js'
import { SA, up, enter, drain, type Rig } from './_rig.js'
import { Op, type ServerConfig } from '../src/internal/wire/ws.js'
import type { Room, LocalTrack } from '../src/index.js'
import type { LocalCore } from '../src/domain/pub/local.js'

// ══ 가짜 장치 — navigator.mediaDevices · permissions(platform/env 가 부르는 전역) ═══════════════

/** 장치 트랙 — stop · ended · enabled · 제약 적용을 센다 */
export interface FT { readonly kind: 'audio' | 'video'; readonly id: string; enabled: boolean; readyState: string; deviceId: string; stops: number; applied: unknown[]; contentHint: string; stop(): void; fire(ev: string): void; addEventListener(ev: string, f: () => void): void; removeEventListener(): void; getSettings(): { deviceId: string }; applyConstraints(c: unknown): Promise<void> }
let made = 0
export function ft(kind: 'audio' | 'video', deviceId = kind === 'audio' ? 'mic-1' : 'cam-1'): FT & MediaStreamTrack {
  const ls = new Map<string, (() => void)[]>()
  const t: FT = {
    kind, id: `${kind}-${++made}`, enabled: true, readyState: 'live', deviceId, stops: 0, applied: [], contentHint: '',
    stop() { t.stops++; t.readyState = 'ended' },
    fire(ev) { for (const f of ls.get(ev) ?? []) f() },
    addEventListener(ev, f) { ls.set(ev, [...(ls.get(ev) ?? []), f]) },
    removeEventListener() { /* 없다 */ },
    getSettings: () => ({ deviceId: t.deviceId }),
    applyConstraints(c) { t.applied.push(c); return Promise.resolve() },
  }
  return t as FT & MediaStreamTrack
}

export interface Gum { kind: 'audio' | 'video'; c: MediaTrackConstraints; track: FT }
export const nav = {
  devices: [] as MediaDeviceInfo[],
  gum: [] as Gum[],
  /** 다음 획득을 이 kind 에서 깬다 */
  failKind: null as 'audio' | 'video' | null,
  change: [] as (() => void)[],
  reset(): void {
    nav.gum.length = 0
    nav.failKind = null
    nav.devices = [dev('audioinput', 'mic-1'), dev('audioinput', 'mic-2'), dev('videoinput', 'cam-1')]
  },
  fire(): void { for (const f of nav.change) f() },
}
export function dev(kind: MediaDeviceKind, deviceId: string, label = deviceId, groupId = `g-${deviceId}`): MediaDeviceInfo {
  return { kind, deviceId, label, groupId, toJSON: () => ({}) } as MediaDeviceInfo
}
nav.reset()
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  mediaDevices: {
    enumerateDevices: async () => [...nav.devices],
    getUserMedia: async (c: MediaStreamConstraints) => {
      const kind = c.audio ? 'audio' : 'video'
      if (nav.failKind === kind) { nav.failKind = null; throw Object.assign(new Error('no device'), { name: 'NotFoundError' }) }
      const want = (c.audio ?? c.video) as MediaTrackConstraints
      const id = want.deviceId as { exact?: string; ideal?: string } | undefined
      const track = ft(kind, id?.exact ?? id?.ideal ?? (kind === 'audio' ? 'mic-1' : 'cam-1'))
      nav.gum.push({ kind, c: want, track })
      return { getAudioTracks: () => (kind === 'audio' ? [track] : []), getVideoTracks: () => (kind === 'video' ? [track] : []), getTracks: () => [track] }
    },
    getDisplayMedia: async () => { const track = ft('video', 'screen'); nav.gum.push({ kind: 'video', c: {}, track }); return { getAudioTracks: () => [], getVideoTracks: () => [track], getTracks: () => [track] } },
    addEventListener: (ev: string, f: () => void) => { if (ev === 'devicechange') nav.change.push(f) },
    removeEventListener: () => undefined,
  },
  permissions: { query: async () => ({ state: 'granted' }) },
} })

// ══ 가짜 발행 PeerLink — 트랜시버 풀 · 협상(시험이 settle) · sender(손잡이를 센다) ═══════════════════

/** sender — replaceTrack · setParameters · getStats 를 센다 · 한 줄 기록(log)에 순서를 남긴다 */
export interface FakeSender { track: FT | null; replaced: (string | null)[]; params: { encodings: Record<string, unknown>[] }[]; energy: number; getParameters(): { encodings: Record<string, unknown>[] }; setParameters(p: { encodings: Record<string, unknown>[] }): Promise<void>; replaceTrack(t: FT | null): Promise<void>; getStats(): Promise<RTCStatsReport> }
export interface Slot { kind: 'audio' | 'video'; simulcast: boolean; mid: string; transceiver: { direction: string; sender: FakeSender }; active: boolean; owned: boolean; encodings: unknown[]; fresh: boolean }
export interface PubPeer { assembled: number; slots: Slot[]; deactivated: Slot[]; released: Slot[]; log: string[]; settle(ok?: boolean): void }

export function pubPeer(log: string[]): PubPeer {
  const waiting: ((r: { ok: boolean }) => void)[] = []
  const sender = (): FakeSender => {
    const s: FakeSender = {
      track: null, replaced: [], params: [], energy: 5,
      getParameters: () => ({ encodings: [{}] }),
      setParameters: (p) => { s.params.push(p); log.push('setParameters'); return Promise.resolve() },
      replaceTrack: (t) => { s.track = t; s.replaced.push(t ? t.id : null); log.push(`replaceTrack(${t ? 'track' : 'null'})`); return Promise.resolve() },
      getStats: async () => new Map([['ms', { type: 'media-source', kind: 'audio', totalAudioEnergy: s.energy }]]) as unknown as RTCStatsReport,
    }
    return s
  }
  const p = {
    assembled: 0, slots: [] as Slot[], deactivated: [] as Slot[], released: [] as Slot[], log, dcOpen: false, ice: 'new', sctpState: null,
    negotiate: () => { p.assembled++; return new Promise<{ ok: boolean }>((r) => waiting.push(r)) },
    settle: (ok = true) => { for (const w of waiting.splice(0)) w({ ok }) },
    setRows: () => undefined, receiverOf: () => null, sendDc: () => false, close: () => undefined, restartWith: () => undefined, reopenDc: () => undefined, stats: async () => [],
    acquireSlot: (kind: 'audio' | 'video', simulcast: boolean, encodings: unknown[], _room: unknown, _opus: string, fresh = false) => {
      const free = fresh ? undefined : p.slots.find((s) => !s.owned && s.kind === kind && s.simulcast === simulcast)
      if (free) { free.owned = true; free.active = true; free.transceiver.direction = 'sendonly'; return free }
      const s: Slot = { kind, simulcast, mid: String(p.slots.length), transceiver: { direction: 'sendonly', sender: sender() }, active: true, owned: true, encodings, fresh }
      p.slots.push(s)
      return s
    },
    releaseSlot: (s: Slot) => { s.owned = false; p.released.push(s) },
    deactivate: (s: Slot) => { s.owned = false; s.active = false; s.transceiver.direction = 'inactive'; p.deactivated.push(s); log.push('inactive') },
    sendInfo: (s: Slot) => ({ track: { kind: s.kind, ssrc: 1000 + Number(s.mid), mid: s.mid, pt: s.kind === 'audio' ? 111 : 102, codec: s.kind === 'audio' ? 'opus' : 'H264' }, ext: { mid_extmap_id: 1 } }),
  }
  return p
}

// ══ 받침 — 방 하나(talk · 발언 방) · 그 서버 연결에 가짜 발행 PeerLink ═══════════════════════════

export interface X { r: Rig; room: Room; peer: PubPeer; log: string[] }
export const live: Rig[] = []
afterEach(async () => { for (const r of live.splice(0)) await r.c.close().catch(() => undefined); nav.reset() })

/** 들어가 있는 방의 연결에 가짜 발행 PeerLink 를 끼운다 */
export function wire(r: Rig, sc: ServerConfig, log: string[]): PubPeer {
  const peer = pubPeer(log)
  const link = r.core.links.get(sc.sfu_id)!
  link.peer = peer as never
  r.peers.set(sc.sfu_id, peer as never)
  return peer
}

export async function pubUp(o: Record<string, unknown> = {}): Promise<X> {
  const r = await up({ silenceWindowMs: 20, ...o })
  live.push(r)
  const room = await enter(r, 'r1', { mode: 'talk', pub: 'r1' })
  const log: string[] = []
  const peer = wire(r, SA, log)
  return { r, room, peer, log }
}

/** 마지막 PUBLISH_TRACKS add 에 응답한다 — 그 mid 에 track_id */
export function answerAdd(x: X, trackId: string, ws = x.r.ws): void {
  const f = ws.requests(Op.PUBLISH_TRACKS).filter((q) => (q.body as { action: string }).action === 'add').at(-1)!
  const mid = (f.body as { tracks: { mid: string }[] }).tracks[0]!.mid
  ws.answer(f, { tracks: [{ mid, track_id: trackId }] })
}
export function answerLast(x: X, op: number, body: unknown = {}, ok = true): void { x.r.ws.answer(x.r.ws.last(op), body, ok) }
export const pubReqs = (x: X, action?: 'add' | 'remove'): { action: string; track_ids?: string[]; tracks?: Record<string, unknown>[]; room_id: string }[] =>
  x.r.ws.requests(Op.PUBLISH_TRACKS).map((f) => f.body as never).filter((b: { action: string }) => !action || b.action === action)

/** 발행 한 바퀴 — 협상을 끝내고 add 에 응답한다 */
export async function settlePublish(x: X, trackId: string): Promise<void> {
  await tick()
  await drain(x.r)
  answerAdd(x, trackId)
  await tick(); await tick()
}

/** 전이중 마이크 하나 — enableMicrophone · 협상 · 발행 · 송신 */
export async function mic(x: X, trackId = 't-mic', o: Record<string, unknown> = {}): Promise<LocalTrack> {
  const p = x.r.c.media.enableMicrophone(o)
  await settlePublish(x, trackId)
  return p
}

/** 반이중 마이크 하나 — ptt.enable(기준 방 = 그 방) */
export async function halfMic(x: X, trackId = 't-half'): Promise<LocalCore> {
  const p = x.room.ptt.enable()
  await settlePublish(x, trackId)
  await p
  return x.r.core.media.halfMic('sfu-a')!
}

/** 그 방 발언권을 허가로 — 발언권 상태기 receive(GRANTED) 가 mic.open 을 낸다(위 이음매) */
export function grant(x: X): void {
  const f = x.room.core.floor
  f.st = { ...f.st, cs: 'PREQ' }
  f.receive({ t: 'GRANTED', priority: 0, duration: 30 } as never)
}
/** 발언권 놓기 — PERM.release 가 mic.close 를 낸다 */
export async function ungrant(x: X): Promise<void> { await x.room.core.floor.release() }

