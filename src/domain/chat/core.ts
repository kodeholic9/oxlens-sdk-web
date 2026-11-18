// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-CHAT-API · SDK:IMPL-CHAT-CATCHUP · SDK:IMPL-CHAT-FOLD · SDK:RULE-API-ASYNC 재시도 · SDK:RULE-MOD-AREA-MIRROR domain/chat · 연:RULE-CHAT-MSG-ID · 연:RULE-CHAT-SEND · 연:RULE-CHAT-RECV · 연:RULE-CHAT-MISSED · 연:RULE-CHAT-CATCHUP · 연:RULE-CHAT-CATCHUP-BUNDLE · 연:RULE-CHAT-MEMBER-NOTICE · 연:RULE-CHAT-UNREAD · 연:RULE-CHAT-DISABLED · 연:RULE-CHAT-KIND · 연:RULE-CHAT-REPLY · 연:RULE-CHAT-EDIT · 연:RULE-CHAT-REACT · 연:RULE-CHAT-DELETE · 연:RULE-CHAT-FOLD · 연:RULE-CHAT-UNKNOWN-KIND · 연:RULE-CHAT-EXT · 연:RULE-CHAT-CONTENT · 연:RULE-CHAT-TALK · 연:RULE-CHAT-TALK-UPDATE · model: claude-opus-5-5
// 채팅 — 방 핸들과 따로 산다(연:RULE-CHAT-SPACE). 위가 상태기를 두지 않는다 — 공간 보관본 · msg_id 거르기 · 관계 메시지 접기를 여기서 든다. 따라잡기는 앱이 부른다(SDK 는 스스로 부르지 않는다).
// 영역 관계 CHAT → SES(tools/sdk_deps.json) — 요청은 시그널링(internal)에 직접 · 통지는 세션이 넣는 통(Queue)에서 직접 꺼낸다(콜백 주입 없음 · 세션은 채팅을 모른다).
import { Code, type ChatMessage as WireMessage, type SpaceEntry, type SpaceHistoryRes, type SpaceListRes, type SpaceViewRes, type MessageRes, type OpName, type TalkInfo } from '../../internal/wire/ws.js'
import type { Signaling } from '../../internal/ses/signaling.js'
import { LADDER } from '../gen/session_client.js'
import { Emitter } from '../../platform/emitter.js'
import { Fault, fromFailure } from '../../platform/fault.js'
import { sleep, wall, Timer } from '../../platform/clock.js'
import { randomHex } from '../../platform/env.js'
import { sha256Hex } from '../../platform/sha256.js'

export type MemberKind = 'join' | 'leave' | 'add' | 'remove'

export interface ChatMessage {
  readonly spaceId: string
  readonly msgId: string
  readonly userId: string
  readonly t: number
  /** 보이는 본문 — 고쳤으면 마지막 고침의 것 · 지웠으면 빈 문자열(SDK:IMPL-CHAT-FOLD) */
  readonly content: string
  /** 멤버 변경 메시지 · 모르는 종류(본문이 있는 것) — 글이면 없다(연:RULE-CHAT-KIND) */
  readonly kind?: MemberKind | (string & {})
  readonly target?: string
  /** 답장이면 원본 msgId(연:RULE-CHAT-REPLY) */
  readonly ref?: string
  /** 앱 몫 — 고쳤으면 마지막 고침의 것(연:RULE-CHAT-EXT) */
  readonly ext?: unknown
  readonly edited?: true
  readonly deleted?: true
  /** 반응 — 키마다 누른 사람 */
  readonly reactions?: Readonly<Record<string, readonly string[]>>
  /** 무전 발언 기록(`kind:"talk"`)의 상태 — 갱신(`talk_update`)을 접은 마지막 전체 상태 · `deadline` 이 지난 `talking` 은 `lost`(SDK:IMPL-CHAT-FOLD · 연:CHAT.type.TalkInfo) */
  readonly talk?: TalkInfo
}

export type { TalkInfo }

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
  updates: [string, ChatMessage[]]
  spaces: [Space[]]
}

/** 세션이 넣는 사실 — 실시간 통지 · 묶음(`live` 면 혼잡할 때 묶인 실시간 — 출처 `live` · 아니면 `catchup` · SDK:IMPL-CHAT-CATCHUP) · 앱이 닫았다 */
export type ChatFact =
  | { readonly t: 'message'; readonly body: WireMessage }
  | { readonly t: 'messages'; readonly body: readonly WireMessage[]; readonly live: boolean }
  | { readonly t: 'closed' }

/** 재시도 간격 — 사다리의 둘째~넷째 칸(연:RULE-ERR-CLIENT-FAIL-DEFAULT 4) */
const WAITS = LADDER.waits.slice(1, 4)
/** 공간마다 드는 수 — 낸 msg_id · 낸 글 · 접기 상태(모르는 원본 포함) · 넘치면 오래된 것부터 버린다(SDK:IMPL-CHAT-CATCHUP · SDK:IMPL-CHAT-FOLD) */
const SEEN_MAX = 1000
/** MESSAGE 요청 몸 상한(연:RULE-CHAT-CONTENT) */
const BODY_MAX = 131_072

const RELATION = new Set(['edit', 'react', 'delete', 'talk_update'])
const MEMBER = new Set(['join', 'leave', 'add', 'remove'])
/** 발언 시계의 깨어남 문턱 — 이 시계는 늦어도 판정이 같다(지난 뒤 처음 보면 lost) */
const TALK_WAKE_MS = 60_000

/** 원본 하나의 접기 상태 — 마지막 고침 · 사람마다 마지막 반응 · 지움 · 발언 기록의 마지막 갱신(연:RULE-CHAT-FOLD) */
interface Fold { edit?: WireMessage; readonly reacts: Map<string, WireMessage>; deleted: boolean; talk?: WireMessage }

/** 발언 상태 — 끝 갱신 없이 지금(단말 UTC ms)이 `deadline` 을 넘은 `talking` 은 `lost`(연:RULE-CHAT-TALK-UPDATE · SDK:IMPL-CHAT-FOLD) */
function due(t: TalkInfo | undefined): TalkInfo | undefined {
  if (!t || t.state !== 'talking' || wall() < t.deadline) return t
  return { ...t, state: 'lost' }
}

const newer = (a: WireMessage, b: WireMessage | undefined): boolean => !b || a.t > b.t || (a.t === b.t && a.msg_id > b.msg_id)

const toSpace = (e: SpaceEntry): Space => ({ spaceId: e.space_id, total: e.total, read: e.read, unread: e.total - e.read, ...(e.last_t !== undefined ? { lastT: e.last_t } : {}) })

/** (t, msgId) 차례(연:RULE-CHAT-ORDER) */
const byOrder = (a: ChatMessage, b: ChatMessage): number => a.t - b.t || (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0)

/** 원본에 접기 상태를 붙여 앱에 낼 글 — 지움은 끝(연:RULE-CHAT-FOLD) */
function folded(w: WireMessage, f: Fold | undefined): ChatMessage {
  const base = { spaceId: w.space_id, msgId: w.msg_id, userId: w.user_id, t: w.t }
  const tail = { ...(w.kind !== undefined ? { kind: w.kind } : {}), ...(w.target !== undefined ? { target: w.target } : {}), ...(w.ref !== undefined ? { ref: w.ref } : {}) }
  if (f?.deleted) return { ...base, ...tail, content: '', deleted: true }
  const src = f?.edit ?? w
  const reactions: Record<string, string[]> = {}
  for (const [user, r] of f?.reacts ?? []) for (const k of r.keys ?? []) (reactions[k] ??= []).push(user)
  const talk = w.kind === 'talk' ? due(f?.talk?.talk ?? w.talk) : undefined
  return {
    ...base, ...tail, content: src.content,
    ...(src.ext !== undefined ? { ext: src.ext } : {}),
    ...(f?.edit ? { edited: true as const } : {}),
    ...(Object.keys(reactions).length ? { reactions } : {}),
    ...(talk ? { talk } : {}),
  }
}

/** 끝내 실패한 전송 — 앱이 「실패」로 남기고 다시 보낼 때 넘길 msgId 를 싣는다(SDK:IMPL-CHAT-API) */
function withMsgId(e: unknown, msgId: string): Fault {
  const f = e instanceof Fault ? e : new Fault({ code: 0, name: 'BUG', category: 'bug', permanent: true, message: String(e), cause: e })
  return new Fault({ code: f.code, name: f.name, permanent: f.permanent, category: f.category, message: f.message, details: { ...(f.details ?? {}), msgId }, cause: f.cause })
}

/** 넣은 차례로 상한을 지키는 표 — 밀려난 키를 돌려준다 */
function capped<K, V>(m: Map<K, V>, k: K, v: V): K | undefined {
  m.delete(k)
  m.set(k, v)
  if (m.size <= SEEN_MAX) return undefined
  const old = m.keys().next().value!
  m.delete(old)
  return old
}

function inner<V>(m: Map<string, Map<string, V>>, k: string): Map<string, V> {
  let x = m.get(k)
  if (!x) { x = new Map(); m.set(k, x) }
  return x
}

/** 클라이언트 하나의 채팅 — createClient 에서 close() 까지 */
export class ChatCore {
  readonly events = new Emitter<ChatEvents>()
  readonly spaceList = new Map<string, Space>()
  /** 공간마다 마지막 목록이 센 끝 — 그 목록 응답의 `last_t` 그대로(없으면 0) · 실시간 글이 올리는 `lastT` 와 따로 든다(SDK:IMPL-CHAT-API) */
  private readonly listed = new Map<string, number>()
  /** 공간마다 낸 msg_id — 넣은 차례 · 최근 SEEN_MAX 개 */
  readonly seen = new Map<string, Set<string>>()
  /** 공간마다 낸 글(원본 그대로) — 접은 결과를 updates 로 다시 낼 때 쓴다 */
  private readonly posts = new Map<string, Map<string, WireMessage>>()
  /** 공간마다 낸 글의 접기 상태 — 글 표와 같은 수명(글이 밀려나면 같이 지운다) */
  private readonly folds = new Map<string, Map<string, Fold>>()
  /** 공간마다 원본을 아직 모르는 접기 상태 — 따로 SEEN_MAX 개(SDK:IMPL-CHAT-FOLD) · 원본이 오면 folds 로 옮긴다 */
  private readonly pending = new Map<string, Map<string, Fold>>()
  enabled = true
  /** 3014 로 꺼진 사실 — 그 뒤 채팅 API 는 보내지 않고 이것으로 reject 한다 */
  private disabled: Fault | null = null
  /** 낸 발언 기록마다 `deadline` 시계 — 공간 · msgId(SDK:IMPL-CHAT-FOLD) */
  private readonly talkTimers = new Map<string, Map<string, Timer>>()

  constructor(private readonly sig: Signaling, private readonly inbox: { next(): Promise<ChatFact | null> }, private readonly who: { readonly userId: string | null } = { userId: null }) {
    void this.pump()
  }

  private async pump(): Promise<void> {
    for (;;) {
      const f = await this.inbox.next()
      if (!f) return
      if (f.t === 'message') this.take([f.body], 'live')
      else if (f.t === 'messages') this.take(f.body, f.live ? 'live' : 'catchup')
      else this.reset()
    }
  }

  // ── 앱 조작 ─────────────────────────────────────────────────────────

  /** msg_id 를 짓는다 — 소문자 hex 36 자 = SHA-256(userId) 앞 4 byte · unix ms 6 byte · 보안 난수 8 byte(연:RULE-CHAT-MSG-ID · 저장된 상태에 기대지 않는다) */
  newMsgId(userId: string): string {
    const ms = (wall() % 0x1000000000000).toString(16).padStart(12, '0')
    return `${sha256Hex(userId).slice(0, 8)}${ms}${randomHex(8)}`
  }

  /** 글 · 답장 — ref 가 있으면 답장(연:RULE-CHAT-REPLY) */
  async send(spaceId: string, content: string, msgId: string, userId: string, o: { ref?: string; ext?: unknown } = {}): Promise<ChatMessage> {
    const body = { space_id: spaceId, msg_id: msgId, content, ...(o.ref !== undefined ? { ref: o.ref } : {}), ...(o.ext !== undefined ? { ext: o.ext } : {}) }
    try {
      const r = (await this.ask('MESSAGE', body)) as MessageRes
      const w: WireMessage = { space_id: spaceId, msg_id: msgId, user_id: userId, t: r.t, content, ...(o.ref !== undefined ? { ref: o.ref } : {}), ...(o.ext !== undefined ? { ext: o.ext } : {}) }
      this.own(w)
      return folded(w, undefined)
    } catch (e) { throw withMsgId(e, msgId) }
  }

  /** 고침 · 반응 · 지움 — 성공하면 내 것을 접어 updates 로 낸다(보낸 세션엔 통지가 없다 — SDK:IMPL-CHAT-FOLD) */
  async relate(spaceId: string, kind: 'edit' | 'react' | 'delete', ref: string, msgId: string, userId: string, o: { content?: string; keys?: readonly string[]; ext?: unknown } = {}): Promise<void> {
    const body = {
      space_id: spaceId, msg_id: msgId, kind, ref,
      ...(o.content !== undefined ? { content: o.content } : {}), ...(o.keys !== undefined ? { keys: [...o.keys] } : {}), ...(o.ext !== undefined ? { ext: o.ext } : {}),
    }
    try {
      const r = (await this.ask('MESSAGE', body)) as MessageRes
      this.take([{ space_id: spaceId, msg_id: msgId, user_id: userId, t: r.t, kind, ref, content: o.content ?? '', ...(o.keys !== undefined ? { keys: [...o.keys] } : {}), ...(o.ext !== undefined ? { ext: o.ext } : {}) }], 'live')
    } catch (e) { throw withMsgId(e, msgId) }
  }

  /** 내가 보낸 글 — 보낸 세션엔 통지가 없으므로 여기서 집합 · 글 표에 넣고(따라잡기가 또 내지 않게) · 보관본은 한 건 늘리고 그 순간까지 읽은 것으로(서버도 보낸 사람의 read 를 올린다 — 연:RULE-CHAT-UNREAD) */
  private own(w: WireMessage): void {
    if (!this.mark(w.space_id, w.msg_id)) return
    this.remember(w)
    const s = this.spaceList.get(w.space_id)
    if (!s) return
    const total = s.total + 1
    this.spaceList.set(w.space_id, { ...s, total, read: total, unread: 0, lastT: Math.max(s.lastT ?? w.t, w.t) })
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
    this.listed.clear()
    for (const e of r.spaces) { this.spaceList.set(e.space_id, toSpace(e)); this.listed.set(e.space_id, e.last_t ?? 0) }
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

  private postsOf(spaceId: string): Map<string, WireMessage> {
    return inner(this.posts, spaceId)
  }

  /** 낸 글을 표에 — 원본을 모르던 접기 상태를 옮겨 오고 · 밀려난 글의 접기 상태는 지운다 */
  private remember(w: WireMessage): void {
    const wait = this.pending.get(w.space_id)?.get(w.msg_id)
    if (wait) { this.pending.get(w.space_id)!.delete(w.msg_id); inner(this.folds, w.space_id).set(w.msg_id, wait) }
    const out = capped(this.postsOf(w.space_id), w.msg_id, w)
    if (out !== undefined) this.folds.get(w.space_id)?.delete(out)
  }

  /** 관계 메시지 하나를 접기 상태에 — 지움은 끝 · 고침은 원본마다 · 반응은 사람마다 (t, msgId) 최대(연:RULE-CHAT-FOLD) · 원본을 모르면 따로 든다 */
  private apply(r: WireMessage): void {
    const ref = r.ref ?? ''
    const known = this.postsOf(r.space_id).has(ref)
    const table = inner(known ? this.folds : this.pending, r.space_id)
    const f = table.get(ref) ?? { reacts: new Map<string, WireMessage>(), deleted: false }
    if (r.kind === 'delete') f.deleted = true
    else if (r.kind === 'edit' && newer(r, f.edit)) f.edit = r
    else if (r.kind === 'react' && newer(r, f.reacts.get(r.user_id))) f.reacts.set(r.user_id, r)
    else if (r.kind === 'talk_update' && newer(r, f.talk)) f.talk = r
    if (known) table.set(ref, f)
    else capped(table, ref, f)
  }

  /** 받은 메시지를 보관본에 — 글과 발언 기록만 total 을 올린다 · ★목록이 이미 센 것(`t` ≤ 그 목록의 `last_t`)은 빼고 · 내 발언 기록은 읽은 것으로(서버도 화자의 read 를 올린다)(연:RULE-CHAT-UNREAD · SDK:IMPL-CHAT-API) */
  private count(msgs: readonly ChatMessage[]): void {
    let changed = false
    for (const m of msgs) {
      const s = this.spaceList.get(m.spaceId)
      if (!s || (m.kind !== undefined && m.kind !== 'talk') || m.t <= (this.listed.get(m.spaceId) ?? 0)) continue
      const total = s.total + 1
      const read = m.kind === 'talk' && m.userId === this.who.userId ? total : s.read
      this.spaceList.set(m.spaceId, { ...s, total, read, unread: total - read, lastT: Math.max(s.lastT ?? m.t, m.t) })
      changed = true
    }
    if (changed) this.events.emit('spaces', [...this.spaceList.values()])
  }

  /** 낸 발언 기록이 아직 `talking` 이면 `deadline` 에 시계를 건다 · 끝났거나 이미 lost 면 시계를 걷는다(SDK:IMPL-CHAT-FOLD) */
  private watch(m: ChatMessage): void {
    if (m.kind !== 'talk') return
    const timers = inner(this.talkTimers, m.spaceId)
    timers.get(m.msgId)?.stop()
    timers.delete(m.msgId)
    if (m.talk?.state !== 'talking') return
    const t = new Timer(TALK_WAKE_MS)
    timers.set(m.msgId, t)
    t.start(Math.max(0, m.talk.deadline - wall()), () => this.overdue(m.spaceId, m.msgId))
  }

  /** 시계가 울렸다 — 그동안 끝 갱신이 없었으면 lost 로 updates(저장된 상태가 정본 — 뒤에 끝 갱신이 오면 그것으로) */
  private overdue(spaceId: string, msgId: string): void {
    this.talkTimers.get(spaceId)?.delete(msgId)
    const w = this.postsOf(spaceId).get(msgId)
    if (!w) return
    const m = folded(w, this.folds.get(spaceId)?.get(msgId))
    if (m.talk?.state === 'talking') return this.watch(m)
    if (m.talk?.state === 'lost') this.events.emit('updates', spaceId, [m])
  }

  /** 받은 것 — 집합으로 거른 뒤 관계는 접기 상태에 · 글은 접어 messages 로 · 이미 낸 글이 바뀌었으면 updates 로(SDK:IMPL-CHAT-CATCHUP · SDK:IMPL-CHAT-FOLD) */
  private take(ws: readonly WireMessage[], source: MessageSource): void {
    const posts = new Map<string, WireMessage[]>()
    const touched = new Map<string, Set<string>>()
    for (const w of ws) {
      if (!this.mark(w.space_id, w.msg_id)) continue
      if (w.kind !== undefined && RELATION.has(w.kind)) {
        this.apply(w)
        if (w.ref !== undefined) {
          const t = touched.get(w.space_id) ?? new Set<string>()
          t.add(w.ref)
          touched.set(w.space_id, t)
        }
        continue
      }
      if (w.kind !== undefined && !MEMBER.has(w.kind) && w.kind !== 'talk' && !w.content) continue
      const list = posts.get(w.space_id) ?? []
      list.push(w)
      posts.set(w.space_id, list)
    }
    for (const [spaceId, list] of posts) {
      for (const w of list) this.remember(w)
      const out = list.map((w) => folded(w, this.folds.get(spaceId)?.get(w.msg_id))).sort(byOrder)
      this.events.emit('messages', spaceId, out, source)
      if (source !== 'history') this.count(out)
      for (const m of out) this.watch(m)
    }
    for (const [spaceId, refs] of touched) {
      const fresh = new Set((posts.get(spaceId) ?? []).map((w) => w.msg_id))
      const known = this.postsOf(spaceId)
      const changed = [...refs].filter((r) => !fresh.has(r) && known.has(r)).map((r) => folded(known.get(r)!, this.folds.get(spaceId)?.get(r))).sort(byOrder)
      if (changed.length) this.events.emit('updates', spaceId, changed)
      for (const m of changed) this.watch(m)
    }
  }

  /** 한 쪽 — relations 를 먼저 접고 · 집합에 없는 글만 내고 넣는다 · 돌려주는 쪽은 접은 글 전부(SDK:IMPL-CHAT-CATCHUP 3 · SDK:IMPL-CHAT-FOLD) */
  private async page(spaceId: string, q: HistoryQuery): Promise<{ messages: ChatMessage[]; more: boolean }> {
    const r = (await this.ask('SPACE_HISTORY', { space_id: spaceId, ...q })) as SpaceHistoryRes
    this.take([...(r.relations ?? []), ...r.messages], 'history')
    const messages = r.messages.map((w) => folded(w, this.folds.get(spaceId)?.get(w.msg_id)))
    return { messages, more: r.more }
  }

  // ── 요청 ────────────────────────────────────────────────────────────

  /** 채팅 요청 하나 — 1xxx · permanent 는 다시 안 보낸다 · 그 밖은 사다리 칸으로 최대 3회(같은 body) · 3014 면 꺼진다(연:RULE-CHAT-DISABLED) · MESSAGE 몸이 상한을 넘으면 보내지 않는다(연:RULE-CHAT-CONTENT) */
  private async ask(op: OpName, body: unknown): Promise<unknown> {
    if (op === 'MESSAGE' && new TextEncoder().encode(JSON.stringify(body)).length > BODY_MAX) {
      throw new Fault({ code: Code.INVALID_PAYLOAD.code, name: 'INVALID_PAYLOAD', permanent: true, message: 'MESSAGE body over 131072 bytes' })
    }
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

  /** 수명 끝(close()) — 보관본 · 집합 · 글 표 · 접기 상태 · 표지를 비운다 */
  private reset(): void {
    const had = this.spaceList.size > 0
    this.spaceList.clear()
    this.listed.clear()
    this.seen.clear()
    this.posts.clear()
    this.folds.clear()
    this.pending.clear()
    for (const m of this.talkTimers.values()) for (const t of m.values()) t.stop()
    this.talkTimers.clear()
    this.enabled = true
    this.disabled = null
    if (had) this.events.emit('spaces', [])
  }
}
