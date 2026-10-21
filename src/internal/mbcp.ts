// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-MOD-TABLE internal/mbcp · 연:TRN.frame.DC · 연:RULE-FLR-HEADER · 연:RULE-FLR-TLV · 연:RULE-FLR-ROOM-KEY · model: claude-opus-5-5
import * as C from './wire/floor_codec.js'

const SVC_FLOOR = 0x01
const MAX_PAYLOAD = 65532

/** 서버 → 클라 발언권 사건 하나 — 방 키는 0x1D 단일(연:RULE-FLR-ROOM-KEY) */
export type FloorRx =
  | { t: 'TAKEN'; ack?: boolean; speaker: string; seq: number }
  | { t: 'IDLE'; ack?: boolean; prev?: string; seq: number }
  | { t: 'GRANTED'; ack?: boolean; priority: number; duration: number; seq: number }
  | { t: 'DENY'; ack?: boolean; cause: number; reason?: string }
  | { t: 'QINFO'; ack?: boolean; info: { position: number; priority: number } }
  | { t: 'REVOKE'; ack?: boolean; cause: number; reason?: string }

export interface Received {
  readonly room: string
  readonly rx: FloorRx
}

/** DC 프레임 — ver · svc · len(BE) · payload(연:TRN.frame.DC) */
export function wrap(payload: Uint8Array, svc = SVC_FLOOR): Uint8Array {
  if (payload.length > MAX_PAYLOAD) throw new RangeError('DC 프레임이 65532 바이트를 넘는다')
  const out = new Uint8Array(4 + payload.length)
  out[0] = 1
  out[1] = svc
  out[2] = (payload.length >> 8) & 0xff
  out[3] = payload.length & 0xff
  out.set(payload, 4)
  return out
}

/** 잘린 프레임은 조용히 버린다 · 발언권 svc 만 푼다 */
export function unwrap(buf: Uint8Array): Uint8Array | null {
  if (buf.length < 4 || buf[0] !== 1 || buf[1] !== SVC_FLOOR) return null
  const len = (buf[2]! << 8) | buf[3]!
  if (buf.length < 4 + len) return null
  return buf.subarray(4, 4 + len)
}

export function request(room: string, priority: number): Uint8Array {
  return wrap(C.encode(priority > 0 ? C.buildRequest({ room, priority }) : C.buildRequest({ room })))
}

export function release(room: string): Uint8Array {
  return wrap(C.encode(C.buildRelease({ room })))
}

export function queuePosRequest(room: string): Uint8Array {
  return wrap(C.encode(C.buildQueuePosRequest({ room })))
}

const ACK_OF: Record<'TAKEN' | 'GRANTED' | 'DENY', number> = { TAKEN: C.Type.TAKEN, GRANTED: C.Type.GRANTED, DENY: C.Type.DENY }

export function ack(room: string, of: 'TAKEN' | 'GRANTED' | 'DENY', seq?: number): Uint8Array {
  return wrap(C.encode(seq === undefined ? C.buildAck({ of: ACK_OF[of], room }) : C.buildAck({ of: ACK_OF[of], room, seq })))
}

/** 바이트 → 사건 — 필수 칸이 빠진 것 · 방 키가 없는 것 · 클라가 받지 않는 종류는 버린다 */
export function parse(buf: Uint8Array): Received | null {
  const p = unwrap(buf)
  if (!p) return null
  const m = C.decode(p)
  if (!m) return null
  switch (m.type) {
    case C.Type.TAKEN: {
      const r = C.readTaken(m)
      if (r.missing.length || r.value.room === undefined) return null
      return { room: r.value.room, rx: { t: 'TAKEN', ack: m.ack, speaker: r.value.speaker!, seq: r.value.seq! } }
    }
    case C.Type.IDLE: {
      const r = C.readIdle(m)
      if (r.missing.length || r.value.room === undefined) return null
      const rx: FloorRx = r.value.prev === undefined ? { t: 'IDLE', ack: m.ack, seq: r.value.seq! } : { t: 'IDLE', ack: m.ack, prev: r.value.prev, seq: r.value.seq! }
      return { room: r.value.room, rx }
    }
    case C.Type.GRANTED: {
      const r = C.readGranted(m)
      if (r.missing.length || r.value.room === undefined) return null
      return { room: r.value.room, rx: { t: 'GRANTED', ack: m.ack, priority: r.value.priority!, duration: r.value.duration!, seq: r.value.seq! } }
    }
    case C.Type.DENY: {
      const r = C.readDeny(m)
      if (r.missing.length || r.value.room === undefined) return null
      const rx: FloorRx = r.value.reason === undefined ? { t: 'DENY', ack: m.ack, cause: r.value.cause! } : { t: 'DENY', ack: m.ack, cause: r.value.cause!, reason: r.value.reason }
      return { room: r.value.room, rx }
    }
    case C.Type.QINFO: {
      const r = C.readQueueInfo(m)
      if (r.missing.length || r.value.room === undefined || !r.value.info) return null
      return { room: r.value.room, rx: { t: 'QINFO', ack: m.ack, info: { position: r.value.info.position ?? 255, priority: r.value.info.priority ?? 0 } } }
    }
    case C.Type.REVOKE: {
      const r = C.readRevoke(m)
      if (r.missing.length || r.value.room === undefined) return null
      const rx: FloorRx = r.value.reason === undefined ? { t: 'REVOKE', ack: m.ack, cause: r.value.cause! } : { t: 'REVOKE', ack: m.ack, cause: r.value.cause!, reason: r.value.reason }
      return { room: r.value.room, rx }
    }
    default:
      return null
  }
}
