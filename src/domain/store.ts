// author: kodeholic (powered by Claude)
// 연§4-1·§4-6 — 받을 트랙 보관본. 네 경로(JOIN·EVENT·RESUME·HTTP)가 이 함수 하나를 지난다.
//
// 보관본은 미디어 서버마다다. mid 가 그 연결에서만 뜻을 갖고(연§4-1) 받기 SDP 도 연결마다
// 조립되기 때문이다. 방은 항목의 room_id 로만 가른다.

/** 연§4-1. 오는 필드는 경로마다 다르므로 필수는 다섯뿐이다. */
export interface TrackEntry {
  readonly room_id: string
  readonly kind: 'audio' | 'video'
  readonly ssrc: number
  readonly track_id: string
  readonly mid?: string
  readonly user_id?: string
  readonly duplex?: 'full' | 'half'
  readonly active?: boolean
  readonly source?: string
  readonly rtx_ssrc?: number
  readonly pt?: number
  readonly rtx_pt?: number
  readonly codec?: string
  readonly fmtp?: string
  readonly simulcast?: boolean
  readonly scalability?: string
}

export interface Version {
  readonly epoch: string
  readonly seq: number
}

export type Source = 'join' | 'event' | 'resume' | 'http'

export type Delta =
  | { readonly kind: 'snapshot'; readonly tracks: readonly TrackEntry[] }
  | { readonly kind: 'add'; readonly tracks: readonly TrackEntry[] }
  | { readonly kind: 'remove'; readonly tracks: readonly TrackEntry[] }

/** 자리 지킴 — 항목은 지워도 그 mid 의 m-line 은 남는다(연§4-1·§9-5). */
export interface Vacancy {
  readonly mid: string
  readonly kind: 'audio' | 'video'
  readonly pt?: number
  readonly codec?: string
  readonly fmtp?: string
}

export type Verdict =
  | {
      readonly accepted: true
      /** epoch 가 갈려 보관본을 통째로 버렸다. */
      readonly reset: boolean
      readonly added: readonly TrackEntry[]
      readonly removed: readonly TrackEntry[]
      /** mid 는 있으나 받을 수 없는 트랙 — 서버 받기 mid 고갈(연§4-1). */
      readonly unreachable: readonly TrackEntry[]
    }
  | { readonly accepted: false; readonly why: 'stale' | 'gap' | 'desync' }

interface RoomState {
  version: Version
  desync: boolean
}

const midNum = (mid: string): number => Number.parseInt(mid, 10)

export class TrackStore {
  /** mid 로 색인한다 — 받기 m-line 자리가 곧 정체성이다. */
  private readonly byMid = new Map<string, TrackEntry>()
  private readonly vacancies = new Map<string, Vacancy>()
  private readonly rooms = new Map<string, RoomState>()

  /** 연§4-6 세 규칙은 여기 한 곳에서만 판정한다. */
  apply(source: Source, roomId: string, version: Version, delta: Delta): Verdict {
    const cur = this.rooms.get(roomId)
    const whole = delta.kind === 'snapshot'

    const sameEpoch = cur !== undefined && cur.version.epoch === version.epoch
    if (cur && sameEpoch) {
      if (version.seq <= cur.version.seq) return { accepted: false, why: 'stale' }
      if (!whole && cur.desync) return { accepted: false, why: 'desync' }
      if (!whole && version.seq !== cur.version.seq + 1) {
        cur.desync = true
        return { accepted: false, why: 'gap' }
      }
    }

    // 연§4-6 규칙 1 — 서버가 재기동했다. 그 방 보관본을 통째로 버리고 재구축한다.
    const reset = cur !== undefined && !sameEpoch
    if (reset) this.dropRoom(roomId)
    this.rooms.set(roomId, { version, desync: false })

    return whole
      ? { ...this.replace(roomId, delta.tracks), reset }
      : { ...this.patch(delta.kind, delta.tracks), reset }
  }

  /** 방을 나갔다 — 그 방 항목과 자리를 놓는다(연§7-5-5). */
  dropRoom(roomId: string): void {
    for (const [mid, e] of [...this.byMid]) {
      if (e.room_id !== roomId) continue
      this.byMid.delete(mid)
      this.vacancies.delete(mid)
    }
    this.rooms.delete(roomId)
  }

  tracks(roomId?: string): readonly TrackEntry[] {
    const all = [...this.byMid.values()]
    const picked = roomId === undefined ? all : all.filter((e) => e.room_id === roomId)
    return picked.sort((a, b) => midNum(a.mid!) - midNum(b.mid!))
  }

  /** 연§9-5 — 조립은 mid 수치 오름차순이고 빈 자리도 줄을 차지한다. */
  seats(): readonly (TrackEntry | Vacancy)[] {
    const rows: (TrackEntry | Vacancy)[] = [...this.byMid.values()]
    for (const [mid, v] of this.vacancies) if (!this.byMid.has(mid)) rows.push(v)
    return rows.sort((a, b) => midNum(a.mid!) - midNum(b.mid!))
  }

  versionOf(roomId: string): Version | undefined {
    return this.rooms.get(roomId)?.version
  }

  isDesynced(roomId: string): boolean {
    return this.rooms.get(roomId)?.desync ?? false
  }

  private replace(roomId: string, tracks: readonly TrackEntry[]): Omit<Verdict & { accepted: true }, 'reset'> {
    const before = new Map([...this.byMid].filter(([, e]) => e.room_id === roomId))
    for (const mid of before.keys()) this.byMid.delete(mid)

    const added: TrackEntry[] = []
    const unreachable: TrackEntry[] = []
    for (const t of tracks) {
      if (t.mid === undefined) { unreachable.push(t); continue }
      this.byMid.set(t.mid, t)
      this.vacancies.delete(t.mid)
      if (!before.has(t.mid)) added.push(t)
    }
    const removed = [...before.values()].filter((e) => !this.byMid.has(e.mid!))
    for (const e of removed) this.seat(e)
    this.rooms.get(roomId)!.desync = false
    return { accepted: true, added, removed, unreachable }
  }

  private patch(kind: 'add' | 'remove', tracks: readonly TrackEntry[]): Omit<Verdict & { accepted: true }, 'reset'> {
    const added: TrackEntry[] = []
    const removed: TrackEntry[] = []
    const unreachable: TrackEntry[] = []
    for (const t of tracks) {
      if (t.mid === undefined) { unreachable.push(t); continue }
      if (kind === 'add') {
        this.byMid.set(t.mid, t)
        this.vacancies.delete(t.mid)
        added.push(t)
      } else {
        const gone = this.byMid.get(t.mid)
        this.byMid.delete(t.mid)
        if (gone) { this.seat(gone); removed.push(gone) }
      }
    }
    return { accepted: true, added, removed, unreachable }
  }

  /** 지우기 직전 항목의 pt·codec 이 자리 지킴 m-line 의 재료다(연§4-1). */
  private seat(e: TrackEntry): void {
    this.vacancies.set(e.mid!, {
      mid: e.mid!,
      kind: e.kind,
      ...(e.pt === undefined ? {} : { pt: e.pt }),
      ...(e.codec === undefined ? {} : { codec: e.codec }),
      ...(e.fmtp === undefined ? {} : { fmtp: e.fmtp }),
    })
  }
}
