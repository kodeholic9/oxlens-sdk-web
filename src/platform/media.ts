// author: kodeholic (powered by Claude)
// 장치 획득. SDK§6-1 — 획득과 발행은 다른 걸음이라 이 표면은 발행을 모른다.
import { MediaTrackLike } from './webrtc.js'

export type CaptureKind = 'microphone' | 'camera' | 'screen'

export interface CaptureRequest {
  readonly kind: CaptureKind
  readonly deviceId?: string
  readonly constraints?: Record<string, unknown>
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

/** SDK§2-3 — 어느 kind 에서 막혔는지까지 알려야 앱이 프롬프트를 다시 띄울 곳을 안다. */
export class DeviceError extends Error {
  override readonly name = 'DeviceError'
  constructor(readonly kind: CaptureKind, readonly blockedBy: 'user' | 'dismissed' | 'system' | 'unknown', why: string) {
    super(why)
  }
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
      if (!track) throw new DeviceError(req.kind, 'unknown', `${req.kind} 에서 트랙이 안 나왔다`)
      return track
    } catch (e) {
      if (e instanceof DeviceError) throw e
      const name = (e as Error).name
      const blockedBy = name === 'NotAllowedError' ? 'user' : name === 'NotFoundError' ? 'system' : 'unknown'
      throw new DeviceError(req.kind, blockedBy, `${req.kind} 획득 실패: ${name}`)
    }
  },
}
