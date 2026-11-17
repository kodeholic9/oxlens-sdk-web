// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-CHAT-API · SDK:IMPL-CHAT-CATCHUP · SDK:RULE-API-ASYNC 재시도 · SDK:RULE-MOD-AREA-MIRROR domain/chat · 연:RULE-CHAT-MSG-ID · 연:RULE-CHAT-SEND · 연:RULE-CHAT-RECV · 연:RULE-CHAT-MISSED · 연:RULE-CHAT-CATCHUP · 연:RULE-CHAT-CATCHUP-BUNDLE · 연:RULE-CHAT-MEMBER-NOTICE · 연:RULE-CHAT-UNREAD · 연:RULE-CHAT-DISABLED · model: claude-opus-5-5
// 채팅 — 방 핸들과 따로 산다(연:RULE-CHAT-SPACE). 위가 상태기를 두지 않는다 — 공간 보관본 · msg_id 거르기를 여기서 든다. 따라잡기는 앱이 부른다(SDK 는 스스로 부르지 않는다).
// 영역 관계 CHAT → SES(tools/sdk_deps.json) — 요청은 시그널링(internal)에 직접 · 통지는 세션이 넣는 통(Queue)에서 직접 꺼낸다(콜백 주입 없음 · 세션은 채팅을 모른다).
import { Code, type ChatMessage as WireMessage, type SpaceEntry, type SpaceHistoryRes, type SpaceListRes, type SpaceViewRes, type MessageRes, type OpName } from '../../internal/wire/ws.js'
import type { Signaling } from '../../internal/ses/signaling.js'
import { LADDER } from '../gen/session_client.js'
import { Emitter } from '../../platform/emitter.js'
import { Fault, fromFailure } from '../../platform/fault.js'
import { sleep, wall } from '../../platform/clock.js'
import { randomHex } from '../../platform/env.js'
import { sha256Hex } from '../../platform/sha256.js'

export type MemberKind = 'join' | 'leave' | 'add' | 'remove'

export interface ChatMessage {
  readonly spaceId: string
  readonly msgId: string
  readonly userId: string
  readonly t: number
  readonly content: string
  /** 멤버 변경 메시지만 — 없으면 보통 메시지(연:RULE-CHAT-MEMBER-NOTICE) */
  readonly kind?: MemberKind
  readonly target?: string
}

export interface Space {
  readonly spaceId: string
  readonly total: number
  readonly read: number
  readonly unread: number
  readonly lastT?: number
}

export type MessageSource = 'live' | 'catchup' | 'history'

export interface HistoryQuery { readonly after?: number; readonly before?: number; readonly limit?: number }

export interface CatchupQuery { readonly spaceId?: string; readonly t?: number }

export interface ChatEvents extends Record<string, unknown[]> {
  messages: [string, ChatMessage[], MessageSource]
  spaces: [Space[]]
}

/** 세션이 넣는 사실 — 실시간 통지 · 따라잡기 묶음 · 앱이 닫았다 */
export type ChatFact =
  | { readonly t: 'message'; readonly body: WireMessage }
  | { readonly t: 'messages'; readonly body: readonly WireMessage[] }
  | { readonly t: 'closed' }

/** 재시도 간격 — 사다리의 둘째~넷째 칸(연:RULE-ERR-CLIENT-FAIL-DEFAULT 4) */
const WAITS = LADDER.waits.slice(1, 4)
/** 공간마다 드는 낸 msg_id 수 — 넘치면 오래된 것부터 버린다(SDK:IMPL-CHAT-CATCHUP) */
const SEEN_MAX = 1000

const toMessage = (m: WireMessage): ChatMessage => ({
  spaceId: m.space_id, msgId: m.msg_id, userId: m.user_id, t: m.t, content: m.content,
  ...(m.kind !== undefined ? { kind: m.kind } : {}), ...(m.target !== undefined ? { target: m.target } : {}),
})

const toSpace = (e: SpaceEntry): Space => ({ spaceId: e.space_id, total: e.total, read: e.read, unread: e.total - e.read, ...(e.last_t !== undefined ? { lastT: e.last_t } : {}) })

/** (t, msgId) 차례(연:RULE-CHAT-ORDER) */
const byOrder = (a: ChatMessage, b: ChatMessage): number => a.t - b.t || (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0)

/** 끝내 실패한 전송 — 앱이 「실패」로 남기고 다시 보낼 때 넘길 msgId 를 싣는다(SDK:IMPL-CHAT-API) */
function withMsgId(e: unknown, msgId: string): Fault {
  const f = e instanceof Fault ? e : new Fault({ code: 0, name: 'BUG', category: 'bug', permanent: true, message: String(e), cause: e })
  return new Fault({ code: f.code, name: f.name, permanent: f.permanent, category: f.category, message: f.message, details: { ...(f.details ?? {}), msgId }, cause: f.cause })
}

/** 클라이언트 하나의 채팅 — createClient 에서 close() 까지 */
export class ChatCore {
  readonly events = new Emitter<ChatEvents>()
  readonly spaceList = new Map<string, Space>()
  /** 공간마다 낸 msg_id — 넣은 차례 · 최근 SEEN_MAX 개 */
  readonly seen = new Map<string, Set<string>>()
  enabled = true
  /** 3014 로 꺼진 사실 — 그 뒤 채팅 API 는 보내지 않고 이것으로 reject 한다 */
  private disabled: Fault | null = null

  constructor(private readonly sig: Signaling, private readonly inbox: { next(): Promise<ChatFact | null> }) {
    void this.pump()
  }

  private async pump(): Promise<void> {
    for (;;) {
      const f = await this.inbox.next()
      if (!f) return
      if (f.t === 'message') this.live(f.body)
      else if (f.t === 'messages') this.bundle(f.body)
      else this.reset()
    }
  }

  // ── 앱 조작 ─────────────────────────────────────────────────────────

  /** msg_id 를 짓는다 — 소문자 hex 36 자 = SHA-256(userId) 앞 4 byte · unix ms 6 byte · 보안 난수 8 byte(연:RULE-CHAT-MSG-ID · 저장된 상태에 기대지 않는다) */
  newMsgId(userId: string): string {
    const ms = (wall() % 0x1000000000000).toString(16).padStart(12, '0')
    return `${sha256Hex(userId).slice(0, 8)}${ms}${randomHex(8)}`
  }

  async send(spaceId: string, content: string, msgId: string, userId: string): Promise<ChatMessage> {
    try {
      const r = (await this.ask('MESSAGE', { space_id: spaceId, msg_id: msgId, content })) as MessageRes
      this.own(spaceId, msgId, r.t)
      return { spaceId, msgId, userId, t: r.t, content }
    } catch (e) { throw withMsgId(e, msgId) }
  }

  /** 내가 보낸 것 — 보낸 세션엔 통지가 없으므로 여기서 집합에 넣고(따라잡기가 또 내지 않게) · 보관본은 한 건 늘리고 그 순간까지 읽은 것으로(서버도 보낸 사람의 read 를 올린다 — 연:RULE-CHAT-UNREAD) */
  private own(spaceId: string, msgId: string, t: number): void {
    if (!this.mark(spaceId, msgId)) return
    const s = this.spaceList.get(spaceId)
    if (!s) return
    const total = s.total + 1
    this.spaceList.set(spaceId, { ...s, total, read: total, unread: 0, lastT: Math.max(s.lastT ?? t, t) })
    this.events.emit('spaces', [...this.spaceList.values()])
  }

  /** 따라잡기 — 앱이 부른다 · 서버 응답에 resolve · 못 받은 것은 그 뒤 messages{catchup} 으로 온다(연:RULE-CHAT-CATCHUP) */
  async catchup(q: CatchupQuery = {}): Promise<void> {
    await this.ask('CATCHUP', { ...(q.spaceId !== undefined ? { space_id: q.spaceId } : {}), ...(q.t !== undefined ? { t: q.t } : {}) })
  }

  history(spaceId: string, q: HistoryQuery = {}): Promise<{ messages: ChatMessage[]; more: boolean }> {
    return this.page(spaceId, q)
  }

  async spaces(): Promise<Space[]> {
    const r = (await this.ask('SPACE_LIST', {})) as SpaceListRes
    this.spaceList.clear()
    for (const e of r.spaces) this.spaceList.set(e.space_id, toSpace(e))
    const list = [...this.spaceList.values()]
    this.events.emit('spaces', list)
    return list
  }

  async view(spaceId: string): Promise<void> {
    const r = (await this.ask('SPACE_VIEW', { space_id: spaceId })) as SpaceViewRes
    const s = this.spaceList.get(spaceId)
    if (!s) return
    const total = Math.max(s.total, r.read)
    this.spaceList.set(spaceId, { ...s, total, read: r.read, unread: total - r.read })
    this.events.emit('spaces', [...this.spaceList.values()])
  }

  // ── 받는 쪽 ─────────────────────────────────────────────────────────

  /** 낸 것으로 적는다 — 이미 있으면 false · 집합은 최근 SEEN_MAX 개 */
  private mark(spaceId: string, msgId: string): boolean {
    let set = this.seen.get(spaceId)
    if (!set) { set = new Set(); this.seen.set(spaceId, set) }
    if (set.has(msgId)) return false
    set.add(msgId)
    if (set.size > SEEN_MAX) set.delete(set.values().next().value!)
    return true
  }

  /** 받은 메시지를 보관본에 — 멤버 변경 메시지는 total 을 올리지 않는다(연:RULE-CHAT-UNREAD) */
  private count(msgs: readonly ChatMessage[]): void {
    let changed = false
    for (const m of msgs) {
      const s = this.spaceList.get(m.spaceId)
      if (!s || m.kind !== undefined) continue
      const total = s.total + 1
      this.spaceList.set(m.spaceId, { ...s, total, unread: total - s.read, lastT: Math.max(s.lastT ?? m.t, m.t) })
      changed = true
    }
    if (changed) this.events.emit('spaces', [...this.spaceList.values()])
  }

  /** 실시간 통지 — 집합에 있으면 버린다 · 아니면 넣고 messages{live}(SDK:IMPL-CHAT-CATCHUP 1) */
  private live(w: WireMessage): void {
    if (!this.mark(w.space_id, w.msg_id)) return
    const m = toMessage(w)
    this.events.emit('messages', m.spaceId, [m], 'live')
    this.count([m])
  }

  /** 따라잡기 묶음 — 공간마다 나눠 (t, msgId) 차례로 · 집합으로 거른 뒤 messages{catchup}(SDK:IMPL-CHAT-CATCHUP 2) */
  private bundle(ws: readonly WireMessage[]): void {
    const by = new Map<string, ChatMessage[]>()
    for (const w of ws) {
      if (!this.mark(w.space_id, w.msg_id)) continue
      const list = by.get(w.space_id) ?? []
      list.push(toMessage(w))
      by.set(w.space_id, list)
    }
    for (const [spaceId, list] of by) {
      list.sort(byOrder)
      this.events.emit('messages', spaceId, list, 'catchup')
      this.count(list)
    }
  }

  /** 한 쪽 — 집합에 없는 것만 내고 넣는다(SDK:IMPL-CHAT-CATCHUP 3) */
  private async page(spaceId: string, q: HistoryQuery): Promise<{ messages: ChatMessage[]; more: boolean }> {
    const r = (await this.ask('SPACE_HISTORY', { space_id: spaceId, ...q })) as SpaceHistoryRes
    const messages = r.messages.map(toMessage)
    const fresh = messages.filter((m) => this.mark(spaceId, m.msgId))
    if (fresh.length) this.events.emit('messages', spaceId, fresh, 'history')
    return { messages, more: r.more }
  }

  // ── 요청 ────────────────────────────────────────────────────────────

  /** 채팅 요청 하나 — 1xxx · permanent 는 다시 안 보낸다 · 그 밖은 사다리 칸으로 최대 3회(같은 body) · 3014 면 꺼진다(연:RULE-CHAT-DISABLED) */
  private async ask(op: OpName, body: unknown): Promise<unknown> {
    for (let i = 0; ; i++) {
      if (this.disabled) throw this.disabled
      const r = await this.sig.request(op, body)
      if (r.ok) return r.body
      const f = fromFailure(r.body)
      if (f.code === Code.CHAT_DISABLED.code) { this.enabled = false; this.disabled = f; throw f }
      if (f.permanent || f.category === 'bug' || i >= WAITS.length) throw f
      await sleep(WAITS[i]!)
    }
  }

  /** 수명 끝(close()) — 보관본 · 집합 · 표지를 비운다 */
  private reset(): void {
    const had = this.spaceList.size > 0
    this.spaceList.clear()
    this.seen.clear()
    this.enabled = true
    this.disabled = null
    if (had) this.events.emit('spaces', [])
  }
}
