// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:RULE-ERR-DEVICE · SDK:RULE-SRC-DEVICES · SDK:IMPL-SRC-BLOCKS · SDK:RULE-PLAT-WEB · model: claude-opus-5-5
import { Fault } from './fault.js'

export type DeviceKind = 'audio' | 'video'
export type PermState = 'granted' | 'denied' | 'prompt' | 'unknown'
export type BlockedBy = 'user' | 'dismissed' | 'system' | 'unknown'

export interface CaptureRequest {
  readonly kind: DeviceKind
  readonly screen?: boolean
  readonly deviceId?: string | undefined
  readonly constraints?: MediaTrackConstraints
  readonly timeoutMs: number
}

function media(): MediaDevices | null {
  return typeof navigator !== 'undefined' && navigator.mediaDevices ? navigator.mediaDevices : null
}

/** 표준 예외 이름 → DEVICE_* (SDK:RULE-ERR-DEVICE — 메시지로 이름을 정하지 않는다) */
async function deviceFault(kind: DeviceKind, e: unknown): Promise<Fault> {
  const name = e instanceof Error || (e && typeof e === 'object' && 'name' in e) ? String((e as { name: unknown }).name) : ''
  const details: Record<string, unknown> = { kind }
  let fname = 'DEVICE_OTHER'
  if (name === 'NotAllowedError') {
    fname = 'DEVICE_PERMISSION_DENIED'
    details['blockedBy'] = await blockedBy(kind, e)
  } else if (name === 'NotFoundError') fname = 'DEVICE_NOT_FOUND'
  else if (name === 'NotReadableError') fname = 'DEVICE_IN_USE'
  else if (name === 'OverconstrainedError') {
    fname = 'DEVICE_OVERCONSTRAINED'
    const c = (e as { constraint?: unknown }).constraint
    if (typeof c === 'string') details['constraint'] = c
  }
  return new Fault({ code: 0, name: fname, category: 'device', permanent: false, details, cause: e })
}

/** blockedBy 판별 두 층 — Chromium 메시지 · 그 다음 permissions.query · 못 가르면 unknown(SDK:RULE-ERR-DEVICE) */
async function blockedBy(kind: DeviceKind, e: unknown): Promise<BlockedBy> {
  const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : ''
  if (msg === 'Permission dismissed') return 'dismissed'
  if (msg === 'Permission denied by system') return 'system'
  if (msg === 'Permission denied') return 'user'
  const st = await permission(kind === 'audio' ? 'microphone' : 'camera')
  return st === 'denied' ? 'user' : 'unknown'
}

function shape(req: CaptureRequest, exact: boolean): MediaStreamConstraints {
  const base: MediaTrackConstraints = { ...(req.constraints ?? {}) }
  if (req.deviceId) base.deviceId = exact ? { exact: req.deviceId } : { ideal: req.deviceId }
  return req.kind === 'audio' ? { audio: base } : { video: base }
}

/**
 * 장치 획득 — kind 하나 · 트랙 하나. 시한이 지나면 DEVICE_TIMEOUT 이고 늦게 온 스트림은 곧바로 멈춘다(SDK:RULE-ERR-DEVICE).
 * deviceId 는 exact 로 시작하고 실패하면 ideal 로 한 번 더 한다(SDK:RULE-SRC-PROFILE 캡처 축).
 */
export async function capture(req: CaptureRequest): Promise<MediaStreamTrack> {
  const md = media()
  if (!md) throw new Fault({ code: 0, name: 'DEVICE_OTHER', category: 'device', details: { kind: req.kind } })
  const once = (c: MediaStreamConstraints): Promise<MediaStream> => {
    if (req.screen) return md.getDisplayMedia({ video: c.video ?? true, audio: false })
    return md.getUserMedia(c)
  }
  const attempt = async (c: MediaStreamConstraints): Promise<MediaStream> => {
    let late = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const p = once(c)
    const t = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        late = true
        rej(new Fault({ code: 0, name: 'DEVICE_TIMEOUT', category: 'device', details: { kind: req.kind } }))
      }, req.timeoutMs)
    })
    p.then((s) => { if (late) for (const tr of s.getTracks()) tr.stop() }, () => undefined)
    try { return await Promise.race([p, t]) } finally { if (timer !== null) clearTimeout(timer) }
  }
  let stream: MediaStream
  try {
    stream = await attempt(shape(req, true))
  } catch (e) {
    if (e instanceof Fault) throw e
    const n = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : ''
    if (req.deviceId && !req.screen && (n === 'OverconstrainedError' || n === 'NotFoundError')) {
      try { stream = await attempt(shape(req, false)) } catch (e2) { if (e2 instanceof Fault) throw e2; throw await deviceFault(req.kind, e2) }
    } else throw await deviceFault(req.kind, e)
  }
  const tracks = req.kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks()
  for (const extra of stream.getTracks()) if (extra !== tracks[0]) extra.stop()
  const tr = tracks[0]
  if (!tr) throw new Fault({ code: 0, name: 'DEVICE_NOT_FOUND', category: 'device', details: { kind: req.kind } })
  return tr
}

/** 권한 상태 — 표준 state 그대로 · query 가 던지면 unknown(값을 지어내지 않는다 — SDK:RULE-SRC-DEVICES) */
export async function permission(name: 'microphone' | 'camera'): Promise<PermState> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions) return 'unknown'
    const st = await navigator.permissions.query({ name: name as PermissionName })
    return st.state
  } catch {
    return 'unknown'
  }
}

export async function enumerate(): Promise<MediaDeviceInfo[]> {
  const md = media()
  if (!md) return []
  try { return await md.enumerateDevices() } catch { return [] }
}

/** 장치 목록 바뀜을 듣는다 — Source 블록의 손잡이(SDK:IMPL-SRC-BLOCKS) */
export function deviceChanges(): MediaDevices | null {
  return media()
}

export function canSetSink(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
}

/** 페이지 수명 — 떠날 때 close() 를 보장 없이 시도한다(SDK:RULE-PLAT-WEB) */
export function pageTarget(): Window | null {
  return typeof window !== 'undefined' ? window : null
}

export function documentTarget(): Document | null {
  return typeof document !== 'undefined' ? document : null
}

export function userAgent(): string {
  return typeof navigator !== 'undefined' ? navigator.userAgent : ''
}

/** 환경 요약 — probe env(SDK:IMPL-DIAG-PROBE) */
export function describe(): Record<string, unknown> {
  const out: Record<string, unknown> = { ua: userAgent() }
  if (typeof navigator !== 'undefined') {
    out['platform'] = navigator.platform
    out['language'] = navigator.language
    out['online'] = navigator.onLine
  }
  if (typeof document !== 'undefined') out['visibility'] = document.visibilityState
  return out
}
