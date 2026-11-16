// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-CHAT-API · SDK:IMPL-CHAT-CATCHUP · SDK:RULE-API-ASYNC 재시도 · SDK:RULE-MOD-AREA-MIRROR domain/chat · 연:RULE-CHAT-MSG-ID · 연:RULE-CHAT-SEND · 연:RULE-CHAT-RECV · 연:RULE-CHAT-MISSED · 연:RULE-CHAT-CATCHUP-BASIS · 연:RULE-CHAT-UNREAD · 연:RULE-CHAT-DISABLED · model: claude-opus-5-5
// 채팅 — 방 핸들과 따로 산다(연:RULE-CHAT-SPACE). 위가 상태기를 두지 않는다 — 공간 보관본 · 따라잡기 기준 · msg_id 거르기를 여기서 든다.
// 영역 관계 CHAT → SES(tools/sdk_deps.json) — 요청은 시그널링(internal)에 직접 · 통지와 세션 사실은 세션이 넣는 통(Queue)에서 직접 꺼낸다(콜백 주입 없음 · 세션은 채팅을 모른다).
import { Code, type ChatMessage as WireMessage, type SpaceEntry, type SpaceHistoryRes, type SpaceListRes, type SpaceViewRes, type MessageRes, type OpName } from '../../internal/wire/ws.js'
import type { Signaling } from '../../internal/ses/signaling.js'
import { LADDER } from '../gen/session_client.js'
import { Emitter } from '../../platform/emitter.js'
import { Fault, fromFailure } from '../../platform/fault.js'
import { sleep } from '../../platform/clock.js'
import { uuidV4 } from '../../platform/env.js'
import type { Logger } from '../../platform/log.js'

export interface ChatMessage {
  readonly spaceId: string
  readonly msgId: string
  readonly userId: string
  readonly t: number
  readonly content: string
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

export interface ChatEvents extends Record<string, unknown[]> {
  messages: [string, ChatMessage[], MessageSource]
  spaces: [Space[]]
}

/** 세션이 넣는 사실 — 실시간 통지 · 세션이 섰다 · 앱이 닫았다 */
export type ChatFact = { readonly t: 'message'; readonly body: WireMessage } | { readonly t: 'up' } | { readonly t: 'closed' }

/** 재시도 간격 — 사다리의 둘째~넷째 칸(연:RULE-ERR-CLIENT-FAIL-DEFAULT 4) */
const WAITS = LADDER.waits.slice(1, 4)

const toMessage = (m: WireMessage): ChatMessage => ({ spaceId: m.space_id, msgId: m.msg_id, userId: m.user_id, t: m.t, content: m.content })

const toSpace = (e: SpaceEntry): Space => ({ spaceId: e.space_id, total: e.total, read: e.read, unread: e.total - e.read, ...(e.last_t !== undefined ? { lastT: e.last_t } : {}) })

/** 끝내 실패한 전송 — 앱이 「실패」로 남기고 다시 보낼 때 넘길 msgId 를 싣는다(SDK:IMPL-CHAT-API) */
function withMsgId(e: unknown, msgId: string): Fault {
  const f = e instanceof Fault ? e : new Fault({ code: 0, name: 'BUG', category: 'bug', permanent: true, message: String(e), cause: e })
  return new Fault({ code: f.code, name: f.name, permanent: f.permanent, category: f.category, message: f.message, details: { ...(f.details ?? {}), msgId }, cause: f.cause })
}

/** 클라이언트 하나의 채팅 — createClient 에서 close() 까지 */
export class ChatCore {
  readonly events = new Emitter<ChatEvents>()
  readonly spaceList = new Map<string, Space>()
  /** 공간마다 따라잡기 기준 — 그 공간을 마지막으로 서버에서 읽은 응답의 끝 t(연:RULE-CHAT-CATCHUP-BASIS) */
  readonly basis = new Map<string, number>()
  /** 공간마다 기준보다 뒤에 실시간으로 받은 msg_id → t */
  readonly seen = new Map<string, Map<string, number>>()
  focused: string | null = null
  enabled = true
  /** 3014 로 꺼진 사실 — 그 뒤 채팅 API 는 보내지 않고 이것으로 reject 한다 */
  private disabled: Fault | null = null
  /** 이 수명에서 세션이 선 적이 있다 — 그 뒤에 다시 서면 놓친 것으로 본다(연:RULE-CHAT-MISSED) */
  private wasUp = false

  constructor(private readonly sig: Signaling, private readonly inbox: { next(): Promise<ChatFact | null> }, private readonly log: Logger) {
    void this.pump()
  }

  private async pump(): Promise<void> {
    for (;;) {
      const f = await this.inbox.next()
      if (!f) return
      if (f.t === 'message') this.live(f.body)
      else if (f.t === 'up') { if (this.wasUp) void this.catchUp(); this.wasUp = true }
      else this.reset()
    }
  }

  // ── 앱 조작 ─────────────────────────────────────────────────────────

  /** msg_id 를 짓는다 — `<내 user_id>/<UUID v4>`(저장된 상태에 기대지 않는 값 · 연:RULE-CHAT-MSG-ID) */
  newMsgId(userId: string): string { return `${userId}/${uuidV4()}` }

  async send(spaceId: string, content: string, msgId: string, userId: string): Promise<ChatMessage> {
    try {
      const r = (await this.ask('MESSAGE', { space_id: spaceId, msg_id: msgId, content })) as MessageRes
      this.own(spaceId, msgId, r.t)
      return { spaceId, msgId, userId, t: r.t, content }
    } catch (e) { throw withMsgId(e, msgId) }
  }

  /** 내가 보낸 것 — 보낸 세션엔 통지가 없으므로 여기서 집합에 넣고(다시 가져오기가 또 내지 않게) · 보관본은 한 건 늘리고 그 순간까지 읽은 것으로(서버도 보낸 사람의 read 를 올린다 — 연:RULE-CHAT-UNREAD) */
  private own(spaceId: string, msgId: string, t: number): void {
    const b = this.basis.get(spaceId)
    if (b === undefined || t > b) {
      let set = this.seen.get(spaceId)
      if (!set) { set = new Map(); this.seen.set(spaceId, set) }
      if (set.has(msgId)) return
      set.set(msgId, t)
    }
    const s = this.spaceList.get(spaceId)
    if (!s) return
    const total = s.total + 1
    this.spaceList.set(spaceId, { ...s, total, read: total, unread: 0, lastT: Math.max(s.lastT ?? t, t) })
    this.events.emit('spaces', [...this.spaceList.values()])
  }

  history(spaceId: string, q: HistoryQuery = {}): Promise<{ messages: ChatMessage[]; more: boolean }> {
    return this.page(spaceId, q, 'history')
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

  focus(spaceId: string | null): void { this.focused = spaceId }

  // ── 받는 쪽 ─────────────────────────────────────────────────────────

  /** 실시간 통지 — t ≤ basis 면 버린다 · 집합에 있으면 버린다 · 아니면 넣고 messages{live}(SDK:IMPL-CHAT-CATCHUP 1) */
  private live(m: WireMessage): void {
    const b = this.basis.get(m.space_id)
    if (b !== undefined && m.t <= b) return
    let set = this.seen.get(m.space_id)
    if (!set) { set = new Map(); this.seen.set(m.space_id, set) }
    if (set.has(m.msg_id)) return
    set.set(m.msg_id, m.t)
    this.events.emit('messages', m.space_id, [toMessage(m)], 'live')
    const s = this.spaceList.get(m.space_id)
    if (!s) return
    const total = s.total + 1
    this.spaceList.set(m.space_id, { ...s, total, unread: total - s.read, lastT: Math.max(s.lastT ?? m.t, m.t) })
    this.events.emit('spaces', [...this.spaceList.values()])
  }

  /** 다시 붙은 뒤 — spaces() · focus 공간 하나만 기준 뒤를 more 가 거짓일 때까지(기준이 없으면 최근 쪽 하나 · SDK:IMPL-CHAT-CATCHUP 2) */
  private async catchUp(): Promise<void> {
    if (!this.enabled) return
    try { await this.spaces() } catch (e) { this.log.warn('따라잡기 — 공간 목록 실패', { err: e instanceof Fault ? `${e.code} ${e.name}` : String(e) }) }
    const id = this.focused
    if (id === null || !this.enabled) return
    try {
      for (;;) {
        const b = this.basis.get(id)
        const p = await this.page(id, b === undefined ? {} : { after: b }, 'catchup')
        if (b === undefined || !p.more || p.messages.length === 0) return
      }
    } catch (e) { this.log.warn('따라잡기 — 다시 가져오기 실패', { space: id, err: e instanceof Fault ? `${e.code} ${e.name}` : String(e) }) }
  }

  /** 한 쪽 — after · 인자 없음 갈래만 기준을 그 끝 t 로 올리고 집합에서 t ≤ basis 를 지운다(SDK:IMPL-CHAT-CATCHUP 3) · 낼 것은 집합으로 거른 뒤 */
  private async page(spaceId: string, q: HistoryQuery, source: MessageSource): Promise<{ messages: ChatMessage[]; more: boolean }> {
    const r = (await this.ask('SPACE_HISTORY', { space_id: spaceId, ...q })) as SpaceHistoryRes
    const messages = r.messages.map(toMessage)
    const set = this.seen.get(spaceId)
    const fresh = set ? messages.filter((m) => !set.has(m.msgId)) : messages
    const end = messages.at(-1)
    if (q.before === undefined && end) {
      const b = Math.max(this.basis.get(spaceId) ?? end.t, end.t)
      this.basis.set(spaceId, b)
      if (set) for (const [id, t] of set) if (t <= b) set.delete(id)
    }
    if (fresh.length) this.events.emit('messages', spaceId, fresh, source)
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

  /** 수명 끝(close()) — 보관본 · 기준 · 집합 · 표지를 비운다 */
  private reset(): void {
    const had = this.spaceList.size > 0
    this.spaceList.clear()
    this.basis.clear()
    this.seen.clear()
    this.focused = null
    this.enabled = true
    this.disabled = null
    this.wasUp = false
    if (had) this.events.emit('spaces', [])
  }
}
