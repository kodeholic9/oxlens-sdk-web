// author: kodeholic (powered by Claude)
// 장치 획득. SDK§6-1 — 획득과 발행은 다른 걸음이라 이 표면은 발행을 모른다.
import { MediaTrackLike } from './webrtc.js'

export type CaptureKind = 'microphone' | 'camera' | 'screen'

export interface CaptureRequest {
  readonly kind: CaptureKind
  readonly deviceId?: string
  readonly constraints?: Record<string, unknown>
}

export interface Devices {
  capture(req: CaptureRequest): Promise<MediaTrackLike>
}

/** SDK§2-3 — 어느 kind 에서 막혔는지까지 알려야 앱이 프롬프트를 다시 띄울 곳을 안다. */
export class DeviceError extends Error {
  override readonly name = 'DeviceError'
  constructor(readonly kind: CaptureKind, readonly blockedBy: 'user' | 'dismissed' | 'system' | 'unknown', why: string) {
    super(why)
  }
}

export const browserDevices: Devices = {
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
