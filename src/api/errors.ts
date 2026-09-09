// author: kodeholic (powered by Claude)
// SDK§2-3 — 아래층은 사실만 올리고 여기서 표면 오류형으로 감싼다.
// code 는 연§10-2 숫자 그대로다 — SDK 가 합치거나 바꾸지 않는다.
import { RequestFailed, SignalingClosed } from '../internal/signaling.js'
import { SdpError } from '../internal/sdp/build.js'
import { LinkError } from '../internal/transport/link.js'
import { DeviceError } from '../platform/media.js'
import { HttpFailed } from '../platform/http.js'
import { PublishError } from '../domain/media-registry.js'
import { RoomError } from '../domain/rooms.js'
import { ErrorCategory, OxLensError } from './types.js'

/** 연§10-2 — 앞자리가 "무엇을 고쳐야 하나"다. */
export function categoryOf(code: number): ErrorCategory {
  if (code >= 1000 && code < 2000) return 'bug'
  if (code >= 2000 && code < 3000) return 'auth'
  if (code >= 3000 && code < 4000) return 'state'
  if (code >= 4000 && code < 5000) return 'limit'
  return 'server'
}

export function toOxLensError(e: unknown): OxLensError {
  if (e instanceof OxLensError) return e
  if (e instanceof RequestFailed) {
    const failure = e.failure as { permanent?: boolean }
    return new OxLensError({
      category: categoryOf(e.failure.code),
      code: e.failure.code,
      name: e.failure.name,
      // 연§10-1 — permanent 는 서버가 싣는다. 없으면 1xxx 만 영구로 본다(연§7-0-1).
      permanent: failure.permanent ?? e.failure.code < 2000,
      message: e.message,
      ...(e.failure.details === undefined ? {} : { details: e.failure.details }),
    })
  }
  if (e instanceof RoomError) {
    return new OxLensError({
      category: e.code === 0 ? 'state' : categoryOf(e.code),
      code: e.code, name: e.failureName, permanent: e.code < 2000, message: e.message,
    })
  }
  // SDK§2-3 `device` 세부 — 이름은 표준 예외에서, `blockedBy` 는 `PERMISSION_DENIED` 에만, `cause` 는 보존.
  if (e instanceof DeviceError) {
    return new OxLensError({
      category: 'device', code: 0, name: `DEVICE_${e.reason.toUpperCase()}`,
      permanent: e.reason === 'permission_denied' && e.blockedBy === 'user',
      message: e.message,
      details: {
        kind: e.kind === 'microphone' ? 'audio' : 'video',
        ...(e.blockedBy === undefined ? {} : { blockedBy: e.blockedBy }),
        ...(e.constraint === undefined ? {} : { constraint: e.constraint }),
      },
      ...(e.cause === undefined ? {} : { cause: e.cause }),
    })
  }
  // 연§5-5 — HTTP 실패는 body 의 `code` 로 가른다. body 가 없는 401 은 SDK§3-2 대로 `2003` 이다.
  if (e instanceof HttpFailed) {
    const f = e.failure
    if (f !== undefined) {
      return new OxLensError({
        category: categoryOf(f.code), code: f.code, name: f.name, permanent: f.code < 2000, message: e.message,
        ...(f.details === undefined ? {} : { details: f.details }),
      })
    }
    if (e.status === 401) {
      return new OxLensError({ category: 'auth', code: 2003, name: 'TOKEN_EXPIRED', permanent: false, message: e.message })
    }
    return new OxLensError({ category: 'server', code: 0, name: `HTTP_${e.status}`, permanent: false, message: e.message })
  }
  if (e instanceof SdpError || e instanceof LinkError) {
    return new OxLensError({ category: 'negotiation', code: 0, name: e.reason.toUpperCase(), permanent: false, message: e.message })
  }
  if (e instanceof PublishError) {
    return new OxLensError({ category: 'negotiation', code: 0, name: e.reason.toUpperCase(), permanent: false, message: e.message })
  }
  if (e instanceof SignalingClosed) {
    return new OxLensError({ category: 'closed', code: e.info.code, name: 'CLOSED', permanent: false, message: e.message })
  }
  return new OxLensError({ category: 'bug', code: 0, name: 'UNEXPECTED', permanent: true, message: (e as Error).message })
}
