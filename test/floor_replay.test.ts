// author: kodeholic (powered by Claude)
// floor 원천 실행 기록 재생 — context/spec/pilot/floor/source/trace/gen.py 가 지은 경로의 클라 사건을
// 클라 상태기에 그대로 넣고, 걸음마다 상태(cs·sub)와 보낸 것을 견준다.
// 원천의 클라는 toggle 이고, 클라 타이머는 한 상태에 하나뿐이라 그 클라의 시계를 주기만큼 당겨 터뜨린다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Message, Tlv, Type, byte, byteSpare, short, str } from '../src/internal/mbcp.js'
import { FloorRoom, T100_MS, T101_MS, T104_MS, T132_MS } from '../src/domain/floor.js'

declare const __FLOOR_TRACE__: string

interface M { t: string; a: string; n: number; d: number; q: number }
interface Act { k: string; c: string; m: M; o: { to: string; m: M }[] }
interface Snap { cs: Record<string, string>; sub: Record<string, string> }
interface Trace { run: string; users: string[]; feats: string[]; steps: { act: Act; snap: Snap }[] }

const ROOM = 'r1'
const PHASE: Record<string, string> = {
  NOPERM: 'no_permission', PREQ: 'pending_request', PERM: 'has_permission', PREL: 'pending_release', QUEUED: 'queued',
}
const SENT: Record<number, string> = {
  [Type.Request]: 'REQUEST', [Type.Release]: 'RELEASE', [Type.QueuePosRequest]: 'QPOS_REQ', [Type.Ack]: 'ACK',
}
const TIMER: Record<string, number> = { T101: T101_MS, T100: T100_MS, T104: T104_MS, T132: T132_MS }

function toClient(m: M, acked: boolean): Message {
  const room = str(Tlv.Room, ROOM)
  switch (m.t) {
    case 'GRANTED': return { type: Type.Granted, ack: acked, fields: [short(Tlv.Duration, m.d), byteSpare(Tlv.Priority, m.n), room] }
    case 'DENY': return { type: Type.Deny, ack: acked, fields: [byte(Tlv.Cause, m.n), room] }
    case 'REVOKE': return { type: Type.Revoke, ack: false, fields: [byte(Tlv.Cause, m.n), room] }
    case 'QINFO': return { type: Type.QueueInfo, ack: false, fields: [{ id: Tlv.QueueInfo, value: new Uint8Array([m.n, m.d]) }, room] }
    case 'TAKEN': return { type: Type.Taken, ack: false, fields: [short(Tlv.Seq, m.q), str(Tlv.Speaker, m.a), room] }
    case 'IDLE': return {
      type: Type.Idle, ack: false,
      fields: [short(Tlv.Seq, m.q), ...(m.a && m.a !== 'none' ? [str(Tlv.PrevSpeaker, m.a)] : []), room],
    }
    default: throw new Error(`모르는 S→C ${m.t}`)
  }
}

function field(msg: Message, id: number): number {
  return msg.fields.find((f) => f.id === id)?.value[0] ?? 0
}

function sentOf(msgs: readonly Message[]): string[] {
  return msgs.map((x) => {
    const name = SENT[x.type] ?? `?${x.type}`
    const n = x.type === Type.Request ? field(x, Tlv.Priority) : x.type === Type.Ack ? field(x, Tlv.AckType) : 0
    return `${name}:${n}`
  })
}

function wantOf(o: Act['o']): string[] {
  return o.filter((x) => x.to === 'server').map((x) => `${x.m.t}:${x.m.t === 'REQUEST' || x.m.t === 'ACK' ? x.m.n : 0}`)
}

function sub(r: FloorRoom): string {
  return (r as unknown as { sub: string }).sub.toUpperCase()
}

test('floor 원천 실행 기록 — 클라 상태기가 걸음마다 원천과 같다', () => {
  const doc = JSON.parse(readFileSync(__FLOOR_TRACE__, 'utf8')) as { source_sha256: string; traces: Trace[] }
  assert.ok(doc.traces.length > 0)
  let steps = 0
  const fails: string[] = []
  doc.traces.forEach((t, ti) => {
    const acked = t.feats.includes('EnAck')
    const rooms = new Map<string, FloorRoom>()
    const clock = new Map<string, number>()
    for (const u of t.users) {
      const r = new FloorRoom(ROOM, u, 'toggle')
      r.armed()
      rooms.set(u, r)
      clock.set(u, 0)
    }
    for (let i = 1; i < t.steps.length; i++) {
      const { act, snap } = t.steps[i]!
      const r = rooms.get(act.c)
      if (!r) continue
      let now = clock.get(act.c)!
      let sent: readonly Message[] | undefined
      switch (act.k) {
        case 'press': r.priority = act.m.n; sent = r.press(now).send; break
        case 'intent': sent = r.press(now).send; break
        case 'release': sent = r.release(now).send; break
        case 'qpos': sent = r.queuePosition(now).send; break
        case 'dS': sent = r.receive(toClient(act.m, acked), now).send; break
        case 'pub_away': case 'leave': sent = r.reset('moved').send; break
        case 'dc_down': sent = r.setTrusted(false).send; break
        case 'dc_up': sent = r.setTrusted(true).send; break
        default:
          if (act.k in TIMER) {
            now += TIMER[act.k]!
            clock.set(act.c, now)
            sent = r.tick(now).send
          }
      }
      if (sent === undefined) continue
      steps++
      const at = `${t.run}#${ti} 걸음 ${i} ${act.k}(${act.c})`
      const bad: string[] = []
      const [want, have] = [wantOf(act.o), sentOf(sent)]
      if (JSON.stringify(want) !== JSON.stringify(have)) bad.push(`${at} 보냄: 원천 ${want} · SDK ${have}`)
      for (const u of t.users) {
        const x = rooms.get(u)!
        if (PHASE[snap.cs[u]!] !== x.phase) bad.push(`${at} cs[${u}]: 원천 ${snap.cs[u]} · SDK ${x.phase}`)
        if (snap.cs[u] === 'QUEUED' && snap.sub[u] !== sub(x)) bad.push(`${at} sub[${u}]: 원천 ${snap.sub[u]} · SDK ${sub(x)}`)
      }
      if (bad.length) {
        fails.push(...bad)
        break
      }
    }
  })
  assert.ok(steps > 0)
  assert.equal(fails.length, 0, `원천 ${doc.source_sha256} · 재생 ${steps}걸음\n${fails.join('\n')}`)
})
