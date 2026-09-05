// author: kodeholic (powered by Claude)
// 연§3-1 WS 프레임 — 8B 머리(ver·flags·op·pid) + JSON body. 순수 codec 이라 소켓을 모른다.

export const WS_VER = 1
export const HEADER = 8
export const MAX_FRAME = 1_048_576

/** 연§3-1 — 프레임은 두 갈래뿐이다. flags 하위 2비트가 그것을 가른다. */
export const Kind = { Request: 0b00, Ok: 0b01, Fail: 0b10 } as const
export type FrameKind = (typeof Kind)[keyof typeof Kind]

export interface Frame {
  readonly kind: FrameKind
  readonly op: number
  readonly pid: number
  /** 연§3-1 — bit2-7 은 예약이고 파서가 원본을 보존한다. */
  readonly reserved: number
  readonly body: unknown
}

/** 연§3-1 끊는 조건 — 응답을 지을 수 없어 연결을 닫는다. code 는 연§10-3. */
export class FrameError extends Error {
  override readonly name = 'FrameError'
  constructor(readonly closeCode: number, readonly closeReason: string, why: string) {
    super(why)
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

/** 빈 body 는 0바이트로 나간다 — 연§3-1(ACK 이 이것이다). */
export function encode(kind: FrameKind, op: number, pid: number, body?: unknown): Uint8Array {
  const empty = body === undefined || body === null
    || (typeof body === 'object' && Object.keys(body as object).length === 0)
  const json = empty ? new Uint8Array(0) : enc.encode(JSON.stringify(body))
  const buf = new Uint8Array(HEADER + json.length)
  const view = new DataView(buf.buffer)
  buf[0] = WS_VER
  buf[1] = kind
  view.setUint16(2, op, false)
  view.setUint32(4, pid >>> 0, false)
  buf.set(json, HEADER)
  if (buf.length > MAX_FRAME) {
    throw new FrameError(4000, 'PROTOCOL_ERROR', `프레임 ${buf.length}B 가 상한 ${MAX_FRAME}B 를 넘는다`)
  }
  return buf
}

export function decode(input: ArrayBuffer | Uint8Array): Frame {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (buf.length > MAX_FRAME) {
    throw new FrameError(4000, 'PROTOCOL_ERROR', `프레임 ${buf.length}B 가 상한을 넘는다`)
  }
  if (buf.length < HEADER) {
    throw new FrameError(4000, 'PROTOCOL_ERROR', `머리 ${HEADER}B 가 안 된다(${buf.length}B)`)
  }
  const flags = buf[1]!
  const kind = flags & 0b11
  if (buf[0] !== WS_VER) {
    throw new FrameError(4000, 'PROTOCOL_ERROR', `ver=${buf[0]} — 1 이 아니다`)
  }
  if (kind === 0b11) {
    throw new FrameError(4000, 'PROTOCOL_ERROR', 'flags 하위 2비트가 예약값 11 이다')
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const op = view.getUint16(2, false)
  const pid = view.getUint32(4, false)
  const reserved = flags & ~0b11
  const payload = buf.subarray(HEADER)
  if (payload.length === 0) return { kind: kind as FrameKind, op, pid, reserved, body: {} }
  let body: unknown
  try {
    body = JSON.parse(dec.decode(payload)) as unknown
  } catch {
    throw new FrameError(4000, 'PROTOCOL_ERROR', `op=0x${op.toString(16)} body 가 JSON 이 아니다`)
  }
  return { kind: kind as FrameKind, op, pid, reserved, body }
}

/** 연§3-1 — pid 는 자기 안에서 하나씩 올리고 넘치면 0 으로 감긴다. */
export class PidCounter {
  private next = 0
  take(): number {
    const pid = this.next
    this.next = (this.next + 1) >>> 0
    return pid
  }
}
