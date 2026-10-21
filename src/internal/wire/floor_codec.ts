// author: kodeholic (powered by Claude)
// ★생성 파일 — 원천 areas/flr/model/messages.ts 에서 gen/codec.py 가 지었다. 손으로 고치지 않는다.

export const Type = {REQUEST: 0, GRANTED: 1, TAKEN: 2, DENY: 3, RELEASE: 4, IDLE: 5, REVOKE: 6, QPOS_REQ: 8, QINFO: 9, ACK: 10} as const
export const TlvId = {PRIORITY: 0, DURATION: 1, CAUSE: 2, QINFO: 3, SPEAKER: 4, SEQ: 8, ACKTYPE: 12, PREV: 26, REASON: 27, ROOM: 29} as const
export const RETIRED: readonly number[] = [7, 28, 30]
export const MAX_VALUE = 255

export interface Field { readonly id: number; readonly value: Uint8Array }
export interface Message { readonly type: number; readonly ack: boolean; readonly fields: readonly Field[] }

const ADOPTED = new Set<number>(Object.values(Type))
/** 원문이 A 비트를 쓸 수 있게 하는 종류 */
export const ACK_ALLOWED = new Set<number>([1, 2, 3, 4, 5, 9])
const enc = new TextEncoder()
const dec = new TextDecoder()
const u8 = (v: number): Uint8Array => Uint8Array.of(v & 0xff)
const u8spare = (v: number): Uint8Array => Uint8Array.of(v & 0xff, 0)
const u16be = (v: number): Uint8Array => Uint8Array.of((v >> 8) & 0xff, v & 0xff)
const utf8 = (v: string): Uint8Array => enc.encode(v)
const rd8 = (b: Uint8Array): number => b[0]!
const rd16 = (b: Uint8Array): number => (b[0]! << 8) | b[1]!
/** 값 + 예비 — 길이가 2 가 아니면 그 칸은 없는 것이다(원문 8.1.4) */
const rd8spare = (b: Uint8Array): number | undefined => (b.length === 2 ? b[0]! : undefined)
function cat(...p: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0))
  let at = 0
  for (const x of p) { out.set(x, at); at += x.length }
  return out
}

/** 메시지 → 바이트 — 머리(V 2bit · R 1bit · A 1bit · Type 4bit) · TLV 개수 · TLV */
export function encode(msg: Message): Uint8Array {
  if (msg.ack && !ACK_ALLOWED.has(msg.type)) throw new RangeError(`종류 ${msg.type} 는 A 비트를 쓸 수 없다`)
  const tlvs = msg.fields.map((f) => {
    if (f.value.length > MAX_VALUE) throw new RangeError(`TLV ${f.id} 값이 ${MAX_VALUE}바이트를 넘는다`)
    return cat(Uint8Array.of(f.id, f.value.length), f.value)
  })
  return cat(Uint8Array.of((msg.ack ? 0x10 : 0) | ((msg.type << 0) & 0x0f), msg.fields.length), ...tlvs)
}

/** 바이트 → 메시지 — V 가 0 아니면 버린다 · R 가 0 아니면 무시 · 안 쓰는 종류는 버린다 · 모르는 id 는 담는다 · 잘리면 거기까지 */
export function decode(buf: Uint8Array): Message | null {
  if (buf.length < 2) return null
  const head = buf[0]!
  if ((head & 0xc0) !== 0x00) return null
  const type = (head & 0x0f) >> 0
  if (!ADOPTED.has(type)) return null
  const count = buf[1]!
  const fields: Field[] = []
  let at = 2
  for (let i = 0; i < count; i += 1) {
    if (at + 2 > buf.length) break
    const len = buf[at + 1]!
    if (at + 2 + len > buf.length) break
    fields.push({ id: buf[at]!, value: buf.subarray(at + 2, at + 2 + len) })
    at += 2 + len
  }
  return { type, ack: (head & 0x10) !== 0, fields }
}

/** 0 Floor Request(원문 8.2.4) · C→S · A 안 세운다 — 필수 room · 선택 priority */
export function buildRequest(a: { room: string; priority?: number }): Message {
  const fields: Field[] = [{ id: TlvId.ROOM, value: utf8(a.room) }]
  if (a.priority !== undefined) fields.push({ id: TlvId.PRIORITY, value: u8spare(a.priority) })
  return { type: Type.REQUEST, ack: false, fields }
}
export function readRequest(msg: Message): { value: { room?: string | undefined; priority?: number | undefined }; missing: string[] } {
  const missing: string[] = []
  const get = <T>(id: number, f: (b: Uint8Array) => T | undefined): T | undefined => {
    const x = msg.fields.find((y) => y.id === id)
    return x ? f(x.value) : undefined
  }
  const priority = get(TlvId.PRIORITY, (b) => rd8spare(b))
  const room = get(TlvId.ROOM, (b) => dec.decode(b))
  if (room === undefined) missing.push('room')
  return { value: { priority, room }, missing }
}

/** 1 Floor Granted(원문 8.2.5) · S→C · A 세운다 — 필수 priority, duration, seq, room · 선택 없음 */
export function buildGranted(a: { priority: number; duration: number; seq: number; room: string }): Message {
  const fields: Field[] = [{ id: TlvId.PRIORITY, value: u8spare(a.priority) }, { id: TlvId.DURATION, value: u16be(a.duration) }, { id: TlvId.SEQ, value: u16be(a.seq) }, { id: TlvId.ROOM, value: utf8(a.room) }]
  return { type: Type.GRANTED, ack: true, fields }
}
export function readGranted(msg: Message): { value: { priority?: number | undefined; duration?: number | undefined; seq?: number | undefined; room?: string | undefined }; missing: string[] } {
  const missing: string[] = []
  const get = <T>(id: number, f: (b: Uint8Array) => T | undefined): T | undefined => {
    const x = msg.fields.find((y) => y.id === id)
    return x ? f(x.value) : undefined
  }
  const priority = get(TlvId.PRIORITY, (b) => rd8spare(b))
  const duration = get(TlvId.DURATION, (b) => rd16(b))
  const seq = get(TlvId.SEQ, (b) => rd16(b))
  const room = get(TlvId.ROOM, (b) => dec.decode(b))
  if (priority === undefined) missing.push('priority')
  if (duration === undefined) missing.push('duration')
  if (seq === undefined) missing.push('seq')
  if (room === undefined) missing.push('room')
  return { value: { priority, duration, seq, room }, missing }
}

/** 2 Floor Taken(원문 8.2.9) · S→C · A 세운다 — 필수 speaker, seq, room · 선택 없음 */
export function buildTaken(a: { speaker: string; seq: number; room: string }): Message {
  const fields: Field[] = [{ id: TlvId.SPEAKER, value: utf8(a.speaker) }, { id: TlvId.SEQ, value: u16be(a.seq) }, { id: TlvId.ROOM, value: utf8(a.room) }]
  return { type: Type.TAKEN, ack: true, fields }
}
export function readTaken(msg: Message): { value: { speaker?: string | undefined; seq?: number | undefined; room?: string | undefined }; missing: string[] } {
  const missing: string[] = []
  const get = <T>(id: number, f: (b: Uint8Array) => T | undefined): T | undefined => {
    const x = msg.fields.find((y) => y.id === id)
    return x ? f(x.value) : undefined
  }
  const speaker = get(TlvId.SPEAKER, (b) => dec.decode(b))
  const seq = get(TlvId.SEQ, (b) => rd16(b))
  const room = get(TlvId.ROOM, (b) => dec.decode(b))
  if (speaker === undefined) missing.push('speaker')
  if (seq === undefined) missing.push('seq')
  if (room === undefined) missing.push('room')
  return { value: { speaker, seq, room }, missing }
}

/** 3 Floor Deny(원문 8.2.6) · S→C · A 세운다 — 필수 cause, room · 선택 reason */
export function buildDeny(a: { cause: number; room: string; reason?: string }): Message {
  const fields: Field[] = [{ id: TlvId.CAUSE, value: u8(a.cause) }, { id: TlvId.ROOM, value: utf8(a.room) }]
  if (a.reason !== undefined) fields.push({ id: TlvId.REASON, value: utf8(a.reason) })
  return { type: Type.DENY, ack: true, fields }
}
export function readDeny(msg: Message): { value: { cause?: number | undefined; room?: string | undefined; reason?: string | undefined }; missing: string[] } {
  const missing: string[] = []
  const get = <T>(id: number, f: (b: Uint8Array) => T | undefined): T | undefined => {
    const x = msg.fields.find((y) => y.id === id)
    return x ? f(x.value) : undefined
  }
  const cause = get(TlvId.CAUSE, (b) => rd8(b))
  const reason = get(TlvId.REASON, (b) => dec.decode(b))
  const room = get(TlvId.ROOM, (b) => dec.decode(b))
  if (cause === undefined) missing.push('cause')
  if (room === undefined) missing.push('room')
  return { value: { cause, reason, room }, missing }
}

/** 4 Floor Release(원문 8.2.7) · C→S · A 안 세운다 — 필수 room · 선택 없음 */
export function buildRelease(a: { room: string }): Message {
  const fields: Field[] = [{ id: TlvId.ROOM, value: utf8(a.room) }]
  return { type: Type.RELEASE, ack: false, fields }
}
export function readRelease(msg: Message): { value: { room?: string | undefined }; missing: string[] } {
  const missing: string[] = []
  const get = <T>(id: number, f: (b: Uint8Array) => T | undefined): T | undefined => {
    const x = msg.fields.find((y) => y.id === id)
    return x ? f(x.value) : undefined
  }
  const room = get(TlvId.ROOM, (b) => dec.decode(b))
  if (room === undefined) missing.push('room')
  return { value: { room }, missing }
}

/** 5 Floor Idle(원문 8.2.8) · S→C · A 안 세운다 — 필수 seq, room · 선택 prev */
export function buildIdle(a: { seq: number; room: string; prev?: string }): Message {
  const fields: Field[] = [{ id: TlvId.SEQ, value: u16be(a.seq) }, { id: TlvId.ROOM, value: utf8(a.room) }]
  if (a.prev !== undefined) fields.push({ id: TlvId.PREV, value: utf8(a.prev) })
  return { type: Type.IDLE, ack: false, fields }
}
export function readIdle(msg: Message): { value: { seq?: number | undefined; room?: string | undefined; prev?: string | undefined }; missing: string[] } {
  const missing: string[] = []
  const get = <T>(id: number, f: (b: Uint8Array) => T | undefined): T | undefined => {
    const x = msg.fields.find((y) => y.id === id)
    return x ? f(x.value) : undefined
  }
  const prev = get(TlvId.PREV, (b) => dec.decode(b))
  const seq = get(TlvId.SEQ, (b) => rd16(b))
  const room = get(TlvId.ROOM, (b) => dec.decode(b))
  if (seq === undefined) missing.push('seq')
  if (room === undefined) missing.push('room')
  return { value: { prev, seq, room }, missing }
}

/** 6 Floor Revoke(원문 8.2.10) · S→C · A 안 세운다 — 필수 cause, room · 선택 reason */
export function buildRevoke(a: { cause: number; room: string; reason?: string }): Message {
  const fields: Field[] = [{ id: TlvId.CAUSE, value: u8(a.cause) }, { id: TlvId.ROOM, value: utf8(a.room) }]
  if (a.reason !== undefined) fields.push({ id: TlvId.REASON, value: utf8(a.reason) })
  return { type: Type.REVOKE, ack: false, fields }
}
export function readRevoke(msg: Message): { value: { cause?: number | undefined; room?: string | undefined; reason?: string | undefined }; missing: string[] } {
  const missing: string[] = []
  const get = <T>(id: number, f: (b: Uint8Array) => T | undefined): T | undefined => {
    const x = msg.fields.find((y) => y.id === id)
    return x ? f(x.value) : undefined
  }
  const cause = get(TlvId.CAUSE, (b) => rd8(b))
  const reason = get(TlvId.REASON, (b) => dec.decode(b))
  const room = get(TlvId.ROOM, (b) => dec.decode(b))
  if (cause === undefined) missing.push('cause')
  if (room === undefined) missing.push('room')
  return { value: { cause, reason, room }, missing }
}

/** 8 Floor Queue Position Request(원문 8.2.11) · C→S · A 안 세운다 — 필수 room · 선택 없음 */
export function buildQueuePosRequest(a: { room: string }): Message {
  const fields: Field[] = [{ id: TlvId.ROOM, value: utf8(a.room) }]
  return { type: Type.QPOS_REQ, ack: false, fields }
}
export function readQueuePosRequest(msg: Message): { value: { room?: string | undefined }; missing: string[] } {
  const missing: string[] = []
  const get = <T>(id: number, f: (b: Uint8Array) => T | undefined): T | undefined => {
    const x = msg.fields.find((y) => y.id === id)
    return x ? f(x.value) : undefined
  }
  const room = get(TlvId.ROOM, (b) => dec.decode(b))
  if (room === undefined) missing.push('room')
  return { value: { room }, missing }
}

/** 9 Floor Queue Position Info(원문 8.2.12) · S→C · A 안 세운다 — 필수 info, room · 선택 없음 */
export function buildQueueInfo(a: { info: { position: number; priority: number }; room: string }): Message {
  const fields: Field[] = [{ id: TlvId.QINFO, value: cat(u8(a.info.position), u8(a.info.priority)) }, { id: TlvId.ROOM, value: utf8(a.room) }]
  return { type: Type.QINFO, ack: false, fields }
}
export function readQueueInfo(msg: Message): { value: { info?: { position: number; priority: number } | undefined; room?: string | undefined }; missing: string[] } {
  const missing: string[] = []
  const get = <T>(id: number, f: (b: Uint8Array) => T | undefined): T | undefined => {
    const x = msg.fields.find((y) => y.id === id)
    return x ? f(x.value) : undefined
  }
  const info = get(TlvId.QINFO, (b) => ({ position: rd8(b.subarray(0, 1)), priority: rd8(b.subarray(1, 2)) }))
  const room = get(TlvId.ROOM, (b) => dec.decode(b))
  if (info === undefined) missing.push('info')
  if (room === undefined) missing.push('room')
  return { value: { info, room }, missing }
}

/** 10 Floor Ack(원문 8.2.13) · 양방향 · A 안 세운다 — 필수 of, room · 선택 seq */
export function buildAck(a: { of: number; room: string; seq?: number }): Message {
  const fields: Field[] = [{ id: TlvId.ACKTYPE, value: u8spare(a.of) }, { id: TlvId.ROOM, value: utf8(a.room) }]
  if (a.seq !== undefined) fields.push({ id: TlvId.SEQ, value: u16be(a.seq) })
  return { type: Type.ACK, ack: false, fields }
}
export function readAck(msg: Message): { value: { of?: number | undefined; room?: string | undefined; seq?: number | undefined }; missing: string[] } {
  const missing: string[] = []
  const get = <T>(id: number, f: (b: Uint8Array) => T | undefined): T | undefined => {
    const x = msg.fields.find((y) => y.id === id)
    return x ? f(x.value) : undefined
  }
  const of = get(TlvId.ACKTYPE, (b) => rd8spare(b))
  const seq = get(TlvId.SEQ, (b) => rd16(b))
  const room = get(TlvId.ROOM, (b) => dec.decode(b))
  if (of === undefined) missing.push('of')
  if (room === undefined) missing.push('room')
  return { value: { of, seq, room }, missing }
}

