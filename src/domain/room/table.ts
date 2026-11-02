// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-ROOM-API join · SDK:IMPL-AFF-SPEAKING-ROOM · SDK:RULE-MOD-AREA-MIRROR domain/room · model: claude-opus-5-5
// 옛 domain/session.ts 의 방 부분(join · dropRoom)을 옮겨 왔다.
import type { Core } from '../ses/core.js'
import type { Reply } from '../../internal/ses/signaling.js'
import { RoomCore, type JoinOptions } from './core.js'
import { AffCore } from '../aff/core.js'

/** 클라이언트 객체 하나의 방 목록 — 소속(발언 방)은 방 목록 위에 하나다 */
export class RoomTable extends Map<string, RoomCore> {
  readonly aff: AffCore

  constructor(private readonly core: Core) {
    super()
    this.aff = new AffCore(this, core.book.scope('aff'))
  }

  async join(roomId: string, opts: JoinOptions): Promise<RoomCore> {
    await this.core.untilActive()
    const live = this.get(roomId)
    if (live && live.st.rs !== 'NONE') return live.joined()
    const room = new RoomCore(this.core, roomId, opts)
    this.set(roomId, room)
    const joined = await room.start()
    // select:false 로 들어간 talk 입장 — 입장 뒤 소속 전환으로 옮긴다 · 전환이 실패해도 입장은 그대로(speakingRoomFailed 로 안다 · 연:RULE-ROOM-JOIN-START 2)
    if (joined.mode === 'talk' && !joined.joinSel && this.aff.speakingRoom !== roomId) await this.aff.setSpeakingRoom(roomId).catch(() => undefined)
    return joined
  }

  drop(room: RoomCore): void {
    if (this.get(room.id) === room) this.delete(room.id)
  }

  // ── 소속(AFF)이 방 목록을 지나 쓰는 것 — 소속은 세션 영역을 부르지 않는다(may_use) ─────

  untilActive(): Promise<void> { return this.core.untilActive() }

  /** 소속 요청 — AFFILIATION */
  request(op: 'AFFILIATION', body: Record<string, unknown>): Promise<Reply> { return this.core.sig.request(op, body) }

  record(layer: string, key: string, from: string, to: string, label: string, cause: string): void { this.core.record(layer, key, from, to, label, cause) }
  impossible(layer: string, key: string, from: string, entry: string): void { this.core.impossible(layer, key, from, entry) }
}
