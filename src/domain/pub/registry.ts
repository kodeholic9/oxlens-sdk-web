// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-PUB-API acquire · enable* · publish · SDK:RULE-SRC-PROFILE · SDK:RULE-SRC-DEVICES · SDK:IMPL-SRC-BLOCKS Source · SDK:RULE-ROOM-PERMISSION-BITS 자동 발행을 멈춘다 · SDK:RULE-MOD-TEARDOWN · SDK:IMPL-MOD-TABLE media-registry · SDK:RULE-MOD-AREA-MIRROR domain/pub · model: claude-opus-5-5
// 옛 domain/media-registry.ts 의 발행 몫(로컬 트랙 목록 · 획득 · 장치 정책)을 다시 지었다 — 재생(Playback)은 trk/ · 진단 수집은 domain/diag(가로지름) 로 옮겼다.
import type { Publication } from '../../internal/wire/ws.js'
import { Emitter } from '../../platform/emitter.js'
import { stateFault } from '../../platform/fault.js'
import { capture, enumerate, permission, deviceChanges, type PermState } from '../../platform/env.js'
import type { LogBook, Logger } from '../../platform/log.js'
import { opusFmtpLine, type Settings } from '../defaults.js'
import type { LinkCore } from '../link/core.js'
import type { AffCore } from '../aff/core.js'
import { LocalCore, type Owner, type Source, type Profile, type TrackOptions } from './local.js'

/** 발행이 읽는 createClient 설정(정책:sdk) */
export type PubSettings = Pick<Settings, 'wakeDetectMs' | 'micColdAfterMs' | 'simulcastLayers' | 'screenShare' | 'cameraCapture' | 'deviceAcquireTimeoutMs' | 'silenceWindowMs' | 'opusFmtpDefault'>

/** 불투명 문자열을 상태기의 작은 수로 — 같은지만 본다 · 0 은 내지 않는다(SDK:RULE-MOD-BINDING-VALUES) */
class Ids {
  private readonly to = new Map<string, number>()
  id(s: string): number {
    let n = this.to.get(s)
    if (n === undefined) { n = this.to.size + 1; this.to.set(s, n) }
    return n
  }
}

/** 'default' 는 OS 기본의 별칭이다 — 같은 kind · groupId 의 실제 장치로 정규화하고 겹친 것은 하나만 남긴다(SDK:RULE-SRC-DEVICES · 선례 LiveKit normalizeDeviceId) · groupId 가 없으면(권한 전) 가르지 못하니 그대로 둔다 */
export function normalizeDevices(list: readonly MediaDeviceInfo[]): MediaDeviceInfo[] {
  const out: MediaDeviceInfo[] = []
  const seen = new Set<string>()
  for (const d of list) {
    const real = d.deviceId === 'default' && d.groupId ? list.find((x) => x.kind === d.kind && x.groupId === d.groupId && x.deviceId !== 'default') : undefined
    const x = real ?? d
    const k = `${x.kind}:${x.deviceId}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

export interface DeviceChange { added: MediaDeviceInfo[]; removed: MediaDeviceInfo[]; list: MediaDeviceInfo[] }

/**
 * 클라이언트 객체 하나의 발행 — 로컬 트랙 목록 · 획득(Source) · 장치 선택 정책 · 이음매가 부르는 무리 입구.
 * 발행은 세션 · 방 · 트랙 영역을 부르지 않는다(may_use = AFF · FLR · LINK) — 세션이 설정 · 원장 · 연결 표 · 소속을 쥐여 만든다.
 */
export class MediaRegistry {
  readonly tracks = new Set<LocalCore>()
  readonly preferred: Partial<Record<'audioinput' | 'audiooutput' | 'videoinput', string>> = {}
  readonly deviceEvents = new Emitter<{ change: [DeviceChange] }>()
  readonly log: Logger
  readonly ids = new Ids()
  readonly opusLine: string
  coldAfter: number
  private lastDevices: MediaDeviceInfo[] = []
  /** 핫플러그 견줌의 기준선 — 만들 때 한 번 센다(안 세면 첫 devicechange 가 있던 장치까지 added 로 낸다) */
  private readonly seeded: Promise<void>

  constructor(readonly cfg: PubSettings, readonly book: LogBook, readonly links: ReadonlyMap<string, LinkCore>, readonly aff: AffCore) {
    this.log = book.scope('pub')
    this.opusLine = opusFmtpLine(cfg.opusFmtpDefault)
    this.coldAfter = cfg.micColdAfterMs
    const md = deviceChanges()
    this.seeded = md ? enumerate().then((l) => { this.lastDevices = l }) : Promise.resolve()
    if (md) md.addEventListener('devicechange', () => void this.devicesChanged())
  }

  register(t: LocalCore): void { this.tracks.add(t) }
  unregister(t: LocalCore): void { this.tracks.delete(t) }

  on(sfuId: string | null): LocalCore[] { return [...this.tracks].filter((t) => t.sfuId !== null && t.sfuId === sfuId) }
  inRoom(roomId: string): LocalCore[] { return [...this.tracks].filter((t) => t.roomId === roomId) }
  byTrackId(id: string): LocalCore | undefined { return [...this.tracks].find((t) => t.trackId === id) }
  ownsTrack(id: string): boolean { return this.byTrackId(id) !== undefined }
  anyPublished(): boolean { return [...this.tracks].some((t) => t.st.ps !== 'IDLE') }

  // ── 발언권(FLR)이 부르는 것 — 반이중 마이크 · mic.open · mic.close ─────────

  hasHalfMic(sfuId: string | null): boolean { return this.on(sfuId).some((t) => t.kind === 'audio' && t.duplex === 'half' && t.st.ps !== 'IDLE') }
  halfMic(sfuId: string | null): LocalCore | undefined { return this.on(sfuId).find((t) => t.kind === 'audio' && t.duplex === 'half' && !t.ended) }
  halfMicCold(sfuId: string | null): boolean { return this.halfMic(sfuId)?.cold ?? false }

  /** press 의 첫 단계 · ptt.enable — 그 방 서버에 반이중 마이크가 없으면 획득해(track 이면 그 외부 트랙으로) 발행한다(기준 방 = 그 방).
   *  서버당 하나 — 옵션은 서버당 첫 것이 이긴다(뒤 것은 로그) · 자기가 만든 트랙이 실패하면 정지 */
  async ensureHalfMic(roomId: string, o: TrackOptions & { track?: MediaStreamTrack } = {}): Promise<LocalCore> {
    const room = this.aff.pubRoom(roomId)
    if (!room) throw stateFault('STATE_NOT_JOINED', { room: roomId })
    const have = this.halfMic(room.sfuId)
    if (have && have.st.ps !== 'IDLE') {
      if (Object.keys(o).length) this.log.info('그 서버에 반이중 마이크가 이미 있다 — 서버당 첫 enable 의 옵션이 이긴다(뒤 것은 무시)', { server: room.sfuId, room: roomId })
      return have
    }
    if (!room.bits.publishAudio) throw stateFault('STATE_NO_PERMISSION', { denied: ['publish_audio'] })
    const { track, ...opts } = o
    const t = have ?? (track ? this.external('audio', 'external', track, { ...opts, profile: opts.profile ?? 'ptt' }) : await this.acquireOne('audio', 'microphone', { ...opts, profile: opts.profile ?? 'ptt' }, 'sdk'))
    try { await t.publish(roomId, 'half') } catch (e) { if (!have && !track) await t.stop(); throw e }
    return t
  }

  warmHalf(sfuId: string | null): Promise<void> { return this.halfMic(sfuId)?.warm() ?? Promise.resolve() }

  floorOpen(sfuId: string | null): void { for (const t of this.on(sfuId)) if (t.duplex === 'half') t.floorOpen() }
  floorClose(sfuId: string | null): void { for (const t of this.on(sfuId)) if (t.duplex === 'half') t.floorClose() }

  // ── 이음매가 부르는 무리 입구(LINK · SES) ──────────────────────────────

  /** 재구축의 다시 발행 — 그 서버(null = 전부) */
  reregisterAll(sfuId: string | null): void {
    for (const t of [...this.tracks]) if (sfuId === null || t.sfuId === sfuId) t.reregister()
  }

  /** 이어받기 응답 대조 — 읽는 값 listed = 응답의 발행 목록에 내 트랙이 있다 */
  resumeCheck(pubs: readonly Publication[]): void {
    for (const t of [...this.tracks]) t.resumeCheck(t.trackId !== null && pubs.some((p) => p.track_id === t.trackId))
  }

  // ── Source — 획득(SDK:RULE-SRC-PROFILE 프로필 = duplex 기본) ─────────────

  /** 획득 제약 — 프로필의 캡처 축 · 앱 값이 덮는다 · 영상은 정책서 cameraCapture · screenShare */
  constraintsFor(kind: 'audio' | 'video', source: Source, profile: Profile, o: TrackOptions): MediaTrackConstraints {
    if (kind === 'audio') {
      const base: MediaTrackConstraints = profile === 'ptt'
        ? { autoGainControl: true, noiseSuppression: true, echoCancellation: true, channelCount: 1 }
        : { autoGainControl: true, noiseSuppression: true, echoCancellation: true }
      const c = { ...(o.capture ?? {}) } as Record<string, unknown>
      delete c['deviceId']
      return { ...base, ...(c as MediaTrackConstraints) }
    }
    if (source === 'screen') return { frameRate: o.frameRate ?? this.cfg.screenShare.maxFramerate ?? 15 }
    const cam = this.cfg.cameraCapture
    const c: MediaTrackConstraints = {}
    const w = o.width ?? o.capture?.width ?? cam.width
    const h = o.height ?? o.capture?.height ?? cam.height
    const f = o.frameRate ?? o.capture?.frameRate ?? cam.frameRate
    if (w) c.width = { ideal: w }
    if (h) c.height = { ideal: h }
    if (f) c.frameRate = { ideal: f }
    return c
  }

  /** 하나 획득 — getUserMedia 는 platform/env 안에서만(SDK:IMPL-SRC-BLOCKS Source) */
  async acquireOne(kind: 'audio' | 'video', source: Source, o: TrackOptions, owner: Owner): Promise<LocalCore> {
    const profile = o.profile ?? 'conference'
    const deviceId = o.deviceId ?? o.capture?.deviceId ?? (kind === 'audio' ? this.preferred.audioinput : this.preferred.videoinput)
    const track = await capture({ kind, screen: source === 'screen', deviceId, constraints: this.constraintsFor(kind, source, profile, o), timeoutMs: o.timeoutMs ?? this.cfg.deviceAcquireTimeoutMs })
    if (source === 'screen') {
      const hint = o.encoding?.contentHint ?? this.cfg.screenShare.contentHint
      if (hint) track.contentHint = hint
    }
    return new LocalCore(this, kind, source, track, owner, deviceId ? { ...o, deviceId } : o)
  }

  /** 예외 경로 — SDK 가 소스를 못 잡는 트랙(캔버스 · 파일) · owner external(장치 수명 관리 대상 아님) */
  external(kind: 'audio' | 'video', source: Source, track: MediaStreamTrack, o: TrackOptions): LocalCore {
    return new LocalCore(this, kind, source, track, 'external', o)
  }

  /** 전부 아니면 전무 — 하나가 실패하면 획득한 것은 정지하고 그 kind 로 reject · owner app */
  async acquire(req: { microphone?: TrackOptions | boolean; camera?: TrackOptions | boolean; screen?: TrackOptions | boolean }): Promise<LocalCore[]> {
    const out: LocalCore[] = []
    const items: ['audio' | 'video', Source, TrackOptions | boolean | undefined][] = [['audio', 'microphone', req.microphone], ['video', 'camera', req.camera], ['video', 'screen', req.screen]]
    try {
      for (const [k, s, o] of items) {
        if (!o) continue
        out.push(await this.acquireOne(k, s, typeof o === 'object' ? o : {}, 'app'))
      }
    } catch (e) {
      for (const t of out) t.track.stop()
      throw e
    }
    return out
  }

  // ── 장치 선택 정책(SDK:RULE-SRC-DEVICES) — sdk 소유만 · 비트가 막는 트랙은 재획득하지 않는다 ─────

  /** 장치 상실 — 대체가 있으면 정책이 살리고 · 없으면(또는 비트가 재획득을 막으면) ended{device_lost} */
  async deviceLost(t: LocalCore): Promise<void> {
    const list = await enumerate()
    const kind = t.kind === 'audio' ? 'audioinput' : 'videoinput'
    if (t.source !== 'screen' && t.allowedNow() && list.some((d) => d.kind === kind)) {
      try { await t.switchTo(null); return } catch { /* 대체 실패 — 아래 */ }
    }
    await t.stop('device_lost')
  }

  private async devicesChanged(): Promise<void> {
    await this.seeded
    const list = await enumerate()
    const key = (d: MediaDeviceInfo): string => `${d.kind}:${d.deviceId}`
    const before = new Set(this.lastDevices.map(key))
    const after = new Set(list.map(key))
    const added = list.filter((d) => !before.has(key(d)))
    const removed = this.lastDevices.filter((d) => !after.has(key(d)))
    this.lastDevices = list
    for (const t of [...this.tracks]) {
      if (t.owner !== 'sdk' || t.source === 'screen' || t.ended || !t.allowedNow()) continue
      const kind = t.kind === 'audio' ? 'audioinput' : 'videoinput'
      const pref = this.preferred[kind]
      const settings = t.track.getSettings?.() ?? {}
      const gone = settings.deviceId !== undefined && !list.some((d) => d.kind === kind && d.deviceId === settings.deviceId)
      // 명시한 장치가 다시 꽂혔다 — 임시 자동에서 명시로 돌아간다(기억은 세션 동안)
      const back = pref !== undefined && settings.deviceId !== pref && list.some((d) => d.kind === kind && d.deviceId === pref)
      if (gone || back || (!pref && added.some((d) => d.kind === kind))) {
        if (!list.some((d) => d.kind === kind)) { await t.stop('device_lost'); continue }
        const target = pref && list.some((d) => d.deviceId === pref) ? pref : null
        try { await t.switchTo(target) } catch { /* 다음 사건에 다시 */ }
      }
    }
    this.deviceEvents.emit('change', { added, removed, list })
  }

  async devices(kind?: MediaDeviceKind, requestPermissions = false): Promise<MediaDeviceInfo[]> {
    if (requestPermissions) {
      try {
        const t = await capture({ kind: kind === 'videoinput' ? 'video' : 'audio', timeoutMs: this.cfg.deviceAcquireTimeoutMs })
        t.stop()
      } catch { /* 권한이 없다 — 목록은 그대로 */ }
    }
    const raw = await enumerate()
    this.lastDevices = raw
    const list = normalizeDevices(raw)
    return kind ? list.filter((d) => d.kind === kind) : list
  }

  async permissions(): Promise<{ microphone: PermState; camera: PermState }> {
    return { microphone: await permission('microphone'), camera: await permission('camera') }
  }

  /** client.close() — 통보는 LEAVE 하나(이미 나갔다) · 로컬만 내린다 · 앱 소유 획득 트랙은 남긴다(SDK:RULE-MOD-TEARDOWN) */
  closeForApp(): void {
    for (const t of [...this.tracks]) t.dispose(t.owner !== 'app')
  }
}
