// author: kodeholic (powered by Claude)
// 가짜 AI(되울림) — AI 에이전트 브리지(SDK:RULE-PLAT-AGENT) 3층 판의 상대(context 202611/20261112a).
// 브리지가 이 WS 서버로 접속한다. 턴 음성(PCM)을 모았다가 turn.end 에 reply 로 되돌린다(mark `m<턴>`).
// ★의존을 늘리지 않는다 — Node 에 WS 서버가 없어 RFC 6455 최소 꼴(핸드셰이크 · 마스크 푼 받기 · 마스크 없는 보내기 · 조각 없음)만 짓는다. 재는 쪽이 아니다 — 받은 것을 적기만 한다.
import { createHash } from 'node:crypto'
import { createServer, IncomingMessage, Server } from 'node:http'
import { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface FakeAi {
  readonly url: string
  /** 받은 텍스트 사건(차례대로) */
  readonly events: Array<Record<string, unknown>>
  /** 받은 음성 프레임 수 */
  frames(): number
  close(): Promise<void>
}

function frame(op: number, payload: Buffer): Buffer {
  const n = payload.length
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 0xff]) : (() => {
    const h = Buffer.alloc(10)
    h[0] = 0x80 | op
    h[1] = 127
    h.writeBigUInt64BE(BigInt(n), 2)
    return h
  })()
  return Buffer.concat([head, payload])
}

/** 쌓인 바이트에서 완성된 프레임을 꺼낸다 — [opcode, payload][] · 남은 바이트 */
function parse(buf: Buffer): { msgs: Array<[number, Buffer]>; rest: Buffer } {
  const msgs: Array<[number, Buffer]> = []
  let off = 0
  for (;;) {
    if (buf.length - off < 2) break
    const op = buf[off] & 0x0f
    const masked = (buf[off + 1] & 0x80) !== 0
    let len = buf[off + 1] & 0x7f
    let p = off + 2
    if (len === 126) {
      if (buf.length - p < 2) break
      len = buf.readUInt16BE(p)
      p += 2
    } else if (len === 127) {
      if (buf.length - p < 8) break
      len = Number(buf.readBigUInt64BE(p))
      p += 8
    }
    const mask = masked ? buf.subarray(p, p + 4) : null
    if (masked) p += 4
    if (buf.length - p < len) break
    const data = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
    msgs.push([op, data])
    off = p + len
  }
  return { msgs, rest: buf.subarray(off) }
}

/** 되울림 가짜 AI 를 띄운다 */
export async function startEchoAi(): Promise<FakeAi> {
  const events: Array<Record<string, unknown>> = []
  let frames = 0
  const server: Server = createServer()
  const sockets = new Set<Duplex>()
  server.on('upgrade', (req: IncomingMessage, sock: Duplex) => {
    sockets.add(sock)
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    let buf = Buffer.alloc(0)
    let turnPcm: Buffer[] = []
    const send = (o: Record<string, unknown>): void => { sock.write(frame(1, Buffer.from(JSON.stringify(o)))) }
    sock.on('data', (d: Buffer) => {
      const r = parse(Buffer.concat([buf, d]))
      buf = Buffer.from(r.rest)
      for (const [op, data] of r.msgs) {
        if (op === 2) {
          frames++
          turnPcm.push(data.subarray(8))
        } else if (op === 1) {
          const ev = JSON.parse(data.toString()) as Record<string, unknown>
          events.push(ev)
          if (ev.type === 'turn.start') turnPcm = []
          if (ev.type === 'turn.end' && turnPcm.length) {
            const rid = `r${String(ev.turn)}`
            send({ type: 'reply.start', reply: rid })
            sock.write(frame(2, Buffer.concat(turnPcm)))
            send({ type: 'mark', name: `m${String(ev.turn)}` })
            send({ type: 'reply.end', reply: rid })
            turnPcm = []
          }
        } else if (op === 8) {
          sock.end(frame(8, Buffer.alloc(0)))
        } else if (op === 9) {
          sock.write(frame(10, data))
        }
      }
    })
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => sockets.delete(sock))
  })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    url: `ws://127.0.0.1:${port}/agent`,
    events,
    frames: () => frames,
    close: () => new Promise<void>((res) => {
      for (const s of sockets) s.destroy()
      server.close(() => res())
    }),
  }
}
