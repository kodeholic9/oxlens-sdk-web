// author: kodeholic (powered by Claude)
// 연§3-3 · §11-1~§11-3 — DC 프레임과 MBCP codec. 순수 함수라 발언권 규칙을 모른다.
//
// ★subtype 은 5비트다(3GPP TS 24.380 Table 8.2.2.1-1). 첫 비트가 곧 ACK 요구 비트이고
// 우리 헤더는 그것을 A(bit4) + Type(bit3-0) 으로 나눠 담는다 — 합치면 같은 5비트다.

export const DC_VER = 1
/** 연§3-3 — 이 문서가 정하는 유일한 svc. 0x02 발성 감지는 확장이라 보내지도 읽지도 않는다. */
export const SVC_MBCP = 0x01
export const DC_MAX_PAYLOAD = 0xffff

export const Type = {
  Request: 0,
  Granted: 1,
  Taken: 2,
  Deny: 3,
  Release: 4,
  Idle: 5,
  Revoke: 6,
  QueuePosRequest: 8,
  QueueInfo: 9,
  Ack: 10,
} as const
export type MbcpType = (typeof Type)[keyof typeof Type]

const ADOPTED = new Set<number>(Object.values(Type))

/** 연§11-3 TLV id. 0~12 는 원문 그대로이고 0x1A 이상이 우리 확장이다. */
export const Tlv = {
  Priority: 0,
  Duration: 1,
  Cause: 2,
  QueueInfo: 3,
  Speaker: 4,
  QueueSize: 7,
  Seq: 8,
  AckType: 12,
  PrevSpeaker: 0x1a,
  CauseText: 0x1b,
  Room: 0x1d,
} as const

export interface Field {
  readonly id: number
  readonly value: Uint8Array
}

export interface Message {
  readonly type: number
  /** 연§11-2 — A 비트. 이것이 서면 ACK 을 반드시 보낸다(§11-5). */
  readonly ack: boolean
  readonly fields: readonly Field[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function encode(msg: Message): Uint8Array {
  let size = 2
  for (const f of msg.fields) size += 2 + f.value.length
  const out = new Uint8Array(size)
  out[0] = (msg.ack ? 0x10 : 0) | (msg.type & 0x0f)
  out[1] = msg.fields.length
  let at = 2
  for (const f of msg.fields) {
    if (f.value.length > 255) throw new RangeError(`TLV ${f.id} 값이 255바이트를 넘는다`)
    out[at] = f.id
    out[at + 1] = f.value.length
    out.set(f.value, at + 2)
    at += 2 + f.value.length
  }
  return out
}

/**
 * 연§11-1·§11-2 — 못 읽거나 우리가 안 쓰는 종류는 null 이다.
 * ★잘렸으면 거기까지 읽고 멈춘다. 그때까지 읽은 것은 유효하다.
 * ★모르는 id 는 버리지 않고 그대로 담는다 — 나중에 필드를 더해도 구버전이 안 깨진다.
 */
export function decode(buf: Uint8Array): Message | null {
  if (buf.length < 2) return null
  const head = buf[0]!
  // 버전은 00 고정이다. 다른 값은 우리가 읽을 물건이 아니다.
  if ((head & 0xc0) !== 0) return null
  const type = head & 0x0f
  if (!ADOPTED.has(type)) return null

  const count = buf[1]!
  const fields: Field[] = []
  let at = 2
  for (let i = 0; i < count; i += 1) {
    if (at + 2 > buf.length) break
    const id = buf[at]!
    const len = buf[at + 1]!
    if (at + 2 + len > buf.length) break
    fields.push({ id, value: buf.subarray(at + 2, at + 2 + len) })
    at += 2 + len
  }
  return { type, ack: (head & 0x10) !== 0, fields }
}

export function field(msg: Message, id: number): Uint8Array | undefined {
  return msg.fields.find((f) => f.id === id)?.value
}

export function text(msg: Message, id: number): string | undefined {
  const v = field(msg, id)
  return v === undefined ? undefined : dec.decode(v)
}

export function u8(msg: Message, id: number): number | undefined {
  const v = field(msg, id)
  return v === undefined || v.length < 1 ? undefined : v[0]
}

export function u16(msg: Message, id: number): number | undefined {
  const v = field(msg, id)
  return v === undefined || v.length < 2 ? undefined : (v[0]! << 8) | v[1]!
}

export function str(id: number, value: string): Field {
  return { id, value: enc.encode(value) }
}

export function byte(id: number, value: number): Field {
  return { id, value: Uint8Array.of(value & 0xff) }
}

export function short(id: number, value: number): Field {
  return { id, value: Uint8Array.of((value >> 8) & 0xff, value & 0xff) }
}

/** 연§3-3 — ver·svc·len 뒤에 payload. 넘치면 보내는 쪽이 거부한다. */
export function frame(payload: Uint8Array, svc = SVC_MBCP): Uint8Array {
  if (payload.length > DC_MAX_PAYLOAD) {
    throw new RangeError(`DC payload ${payload.length}B 가 상한을 넘는다`)
  }
  const out = new Uint8Array(4 + payload.length)
  out[0] = DC_VER
  out[1] = svc
  out[2] = (payload.length >> 8) & 0xff
  out[3] = payload.length & 0xff
  out.set(payload, 4)
  return out
}

/** 연§3-3 — 잘린 프레임은 조용히 버린다. 예외를 던지지 않는다. */
export function unframe(buf: Uint8Array): { svc: number; payload: Uint8Array } | null {
  if (buf.length < 4 || buf[0] !== DC_VER) return null
  const len = (buf[2]! << 8) | buf[3]!
  if (buf.length < 4 + len) return null
  return { svc: buf[1]!, payload: buf.subarray(4, 4 + len) }
}
