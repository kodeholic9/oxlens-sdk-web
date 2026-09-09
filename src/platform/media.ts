// author: kodeholic (powered by Claude)
// 장치 획득. SDK§6-1 — 획득과 발행은 다른 걸음이라 이 표면은 발행을 모른다.
import { MediaTrackLike } from './webrtc.js'

export type CaptureKind = 'microphone' | 'camera' | 'screen'

export interface CaptureRequest {
  readonly kind: CaptureKind
  readonly deviceId?: string
  readonly constraints?: Record<string, unknown>
  /** SDK§2-3 `DEVICE_TIMEOUT` — 이 호출의 대기 상한. 없으면 등록부의 기본값(정책서 §4-1). */
  readonly timeoutMs?: number
}

export type PlatformDeviceKind = 'audioinput' | 'audiooutput' | 'videoinput'
export interface PlatformDeviceInfo {
  readonly deviceId: string
  readonly kind: PlatformDeviceKind
  readonly label: string
  readonly groupId: string
}
export type PlatformPermission = 'granted' | 'denied' | 'prompt' | 'unknown'

export interface Devices {
  capture(req: CaptureRequest): Promise<MediaTrackLike>
  /** SDK§6-4 — 목록. 권한 전이면 `label` 이 빈 문자열이다(브라우저 규칙). */
  enumerate(): Promise<ReadonlyArray<PlatformDeviceInfo>>
  /** 목록이 바뀌면 부른다. 해제 함수를 돌려준다 — 훅을 주입받지 않고 주인이 쥔다. */
  onChange(fn: () => void): () => void
  /** SDK§2-3 — 브라우저가 모르면 `unknown` 이다. 모른다고 `prompt` 로 지어내지 않는다. */
  permission(name: 'microphone' | 'camera'): Promise<PlatformPermission>
}

/** SDK§2-3 — 표준 예외 이름에서 온 여섯. `timeout` 만 SDK 시계다. */
export type DeviceFailure = 'permission_denied' | 'not_found' | 'in_use' | 'overconstrained' | 'timeout' | 'other'
export type BlockedBy = 'user' | 'dismissed' | 'system' | 'unknown'

/** SDK§2-3 — 어느 kind 에서 막혔는지까지 알려야 앱이 프롬프트를 다시 띄울 곳을 안다. */
export class DeviceError extends Error {
  override readonly name = 'DeviceError'
  readonly blockedBy?: BlockedBy
  readonly constraint?: string
  override readonly cause?: unknown
  constructor(
    readonly kind: CaptureKind,
    readonly reason: DeviceFailure,
    why: string,
    extra: { readonly blockedBy?: BlockedBy; readonly constraint?: string; readonly cause?: unknown } = {},
  ) {
    super(why)
    if (extra.blockedBy !== undefined) this.blockedBy = extra.blockedBy
    if (extra.constraint !== undefined) this.constraint = extra.constraint
    if (extra.cause !== undefined) this.cause = extra.cause
  }
}

/** SDK§2-3 — 이름은 표준 예외에서만 짓는다. 메시지로 이름을 정하지 않는다. */
export function reasonOf(errorName: string): DeviceFailure {
  switch (errorName) {
    case 'NotAllowedError': return 'permission_denied'
    case 'NotFoundError': return 'not_found'
    case 'NotReadableError': return 'in_use'
    case 'OverconstrainedError': return 'overconstrained'
    default: return 'other'
  }
}

/**
 * SDK§2-3 판별 규칙 — 표준만으로는 셋이 안 갈린다. 두 층을 순서대로 본다:
 * ① Chromium 메시지(`dismissed` → `system` → `user` 순으로 — "denied by system" 이 "denied" 를 품는다)
 * ② `permissions.query` 가 `denied` 면 `user` ③ 그 밖 `unknown`. 문자열이 바뀌면 `unknown` 으로 떨어진다.
 */
export function blockedByOf(message: string | undefined, permission: PlatformPermission): BlockedBy {
  const m = message ?? ''
  if (m.includes('Permission dismissed')) return 'dismissed'
  if (m.includes('Permission denied by system')) return 'system'
  if (m.includes('Permission denied')) return 'user'
  if (permission === 'denied') return 'user'
  return 'unknown'
}

export const browserDevices: Devices = {
  async enumerate(): Promise<ReadonlyArray<PlatformDeviceInfo>> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return []
    const list = await navigator.mediaDevices.enumerateDevices()
    return list.map((d) => ({ deviceId: d.deviceId, kind: d.kind as PlatformDeviceKind, label: d.label, groupId: d.groupId }))
  },

  onChange(fn: () => void): () => void {
    const target = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (!target?.addEventListener) return () => {}
    target.addEventListener('devicechange', fn)
    return () => target.removeEventListener('devicechange', fn)
  },

  async permission(name: 'microphone' | 'camera'): Promise<PlatformPermission> {
    const q = typeof navigator === 'undefined' ? undefined : navigator.permissions?.query
    if (!q) return 'unknown'
    try {
      const st = await navigator.permissions.query({ name } as unknown as PermissionDescriptor)
      return st.state as PlatformPermission
    } catch {
      return 'unknown'
    }
  },

  async capture(req: CaptureRequest): Promise<MediaTrackLike> {
    const wanted = req.deviceId === undefined ? true : { deviceId: { exact: req.deviceId } }
    try {
      const stream = req.kind === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: { ...(req.constraints ?? {}) } })
        : await navigator.mediaDevices.getUserMedia(
            req.kind === 'microphone'
              ? { audio: typeof wanted === 'boolean' ? { ...(req.constraints ?? {}) } : { ...wanted, ...(req.constraints ?? {}) } }
              : { video: typeof wanted === 'boolean' ? { ...(req.constraints ?? {}) } : { ...wanted, ...(req.constraints ?? {}) } },
          )
      const track = stream.getTracks()[0]
      if (!track) throw new DeviceError(req.kind, 'other', `${req.kind} 에서 트랙이 안 나왔다`)
      return track
    } catch (e) {
      if (e instanceof DeviceError) throw e
      const err = e as { name?: string; message?: string; constraint?: string }
      const name = err.name ?? ''
      const reason = reasonOf(name)
      const extra: { blockedBy?: BlockedBy; constraint?: string; cause: unknown } = { cause: e }
      if (reason === 'permission_denied') {
        const permission = req.kind === 'screen' ? 'unknown' : await browserDevices.permission(req.kind)
        extra.blockedBy = blockedByOf(err.message, permission)
      }
      if (reason === 'overconstrained' && typeof err.constraint === 'string') extra.constraint = err.constraint
      throw new DeviceError(req.kind, reason, `${req.kind} 획득 실패: ${name}`, extra)
    }
  },
}
