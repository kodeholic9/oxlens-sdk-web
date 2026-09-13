// author: kodeholic (powered by Claude)
// 연§4-1·§4-6 — 받을 트랙 보관본. 네 경로(JOIN·EVENT·RESUME·HTTP)가 이 함수 하나를 지난다.
//
// 보관본은 미디어 서버마다다. mid 가 그 연결에서만 뜻을 갖고(연§4-1) 받기 SDP 도 연결마다
// 조립되기 때문이다. 방은 항목의 room_id 로만 가른다.

/**
 * 연§4-1 배정 층 — 그 스트림의 **내 자리**. 수신자마다 다르다.
 *
 * ★**실려 왔을 때만 갈아 끼운다**(연§4-1-1) — 없는 것은 *"안 바뀌었다"* 가 아니라
 * ★**미배정·비점유·고갈**이다. 그래서 `TrackEntry` 본체와 섞지 않는다.
 */
export interface Assign {
  /** 내 받기 m-line 번호 — ★**십진 정수 문자열**. 정렬은 수치로 한다(연§9-5). */
  readonly mid: string
  /** ★**이 연결에 서버가 배정한 PT** — 발행자 값이 아니다. 없으면 실패로 다룬다(폴백 금지). */
  readonly pt: number
  readonly rtx_pt?: number
}

/**
 * 연§4-1 — 받을 스트림 하나. ★★**세 층이다.**
 *
 * | 층 | 무엇 | 누가 보나 | 어디에 |
 * |---|---|---|---|
 * | ★**스트림** | `type`·`ssrc`·`codec`… | ★방 전원(같은 값) | 이 형의 본체 · `seq` 가 센다 |
 * | ★**배정** | 내 `mid`·`pt` | ★수신자 본인 | `assign`(중첩) · `seq` 대상 아님 |
 * | ★**등록** | 내가 올린 것 | 서버와 발행자 본인 | ★**여기 없다** — `publications[]` |
 *
 * ★셋을 한 평면에 두면 조항마다 *"반이중이면?"* 을 따로 판정하게 되고 판정이 갈린다(12차까지의 사고).
 */
export interface TrackEntry {
  /** ★**스트림 종류. 바뀌지 않는다** — 회의↔무전 전환은 등록 속성(`duplex`)이 바뀌는 것이다. */
  readonly type: 'individual' | 'slot'
  readonly room_id: string
  readonly kind: 'audio' | 'video'
  readonly ssrc: number
  readonly track_id: string
  /** ★**수신자 본인의 자리** — 없으면 받을 m-line 이 없는 것이다. */
  readonly assign?: Assign
  /** `slot` 에는 ★**없다** — 여러 사람이 돌려쓰는 한 m-line 이라 주인이 없다. */
  readonly user_id?: string
  readonly active?: boolean
  /** ★`slot` 에는 없다 — 반이중에는 mute 가 없다. ★**스냅샷에 있어야 복구된다.** */
  readonly muted?: boolean
  readonly source?: string
  readonly rtx_ssrc?: number
  readonly codec?: string
  readonly fmtp?: string
  readonly simulcast?: boolean
  readonly scalability?: string
}

/** 받기 SDP 한 절의 재료 — 스트림 층과 배정 층을 ★**조립 직전에** 합친 평면 값. */
export interface SeatRow {
  readonly mid: string
  readonly kind: 'audio' | 'video'
  readonly pt?: number
  readonly rtx_pt?: number
  readonly codec?: string
  readonly fmtp?: string
  readonly room_id?: string
  readonly ssrc?: number
  readonly track_id?: string
  readonly user_id?: string
  readonly source?: string
  readonly rtx_ssrc?: number
  readonly active?: boolean
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

/** 자리 없는 항목은 맨 뒤로 — 정렬이 흔들리지 않게 한 곳에서 정한다. */
const seatNum = (e: TrackEntry): number =>
  e.assign === undefined ? Number.MAX_SAFE_INTEGER : midNum(e.assign.mid)

/** 조립 직전 합치기 — ★**보관은 층을 가른 채로** 하고 평면은 여기서만 만든다. */
function flatten(e: TrackEntry, a: Assign): SeatRow {
  return {
    mid: a.mid,
    kind: e.kind,
    pt: a.pt,
    ...(a.rtx_pt === undefined ? {} : { rtx_pt: a.rtx_pt }),
    ...(e.codec === undefined ? {} : { codec: e.codec }),
    ...(e.fmtp === undefined ? {} : { fmtp: e.fmtp }),
    room_id: e.room_id,
    ssrc: e.ssrc,
    track_id: e.track_id,
    ...(e.user_id === undefined ? {} : { user_id: e.user_id }),
    ...(e.source === undefined ? {} : { source: e.source }),
    ...(e.rtx_ssrc === undefined ? {} : { rtx_ssrc: e.rtx_ssrc }),
    ...(e.active === undefined ? {} : { active: e.active }),
  }
}

export class TrackStore {
  /**
   * ★★**키는 `track_id` 다**(연§4-1-1 "보관본 갱신").
   *
   * ★종전엔 `mid` 로 색인했는데, `mid` 는 ★**배정 층**이라 있다 없다 하고 같은 값이 다른
   * 스트림으로 옮겨 다닌다. 그것을 정체성으로 쓰면 ★**배정이 없는 스트림은 보관본에
   * 아예 못 들어가고**(고갈·비점유·미입장), 자리를 옮긴 스트림은 **둘로 보인다.**
   */
  private readonly byTrack = new Map<string, TrackEntry>()
  private readonly vacancies = new Map<string, Vacancy>()
  private readonly rooms = new Map<string, RoomState>()

  /** 연§4-6 세 규칙은 여기 한 곳에서만 판정한다. */
  apply(source: Source, roomId: string, version: Version, delta: Delta): Verdict {
    const cur = this.rooms.get(roomId)
    const whole = delta.kind === 'snapshot'

    const sameEpoch = cur !== undefined && cur.version.epoch === version.epoch
    // 연§4-6 둘째 예외 — 보관값과 **같은** seq 는 나에게만 온 에코다(응답의 version ·
    // ROOM_EVENT{affiliation} · READY{transport} 가 유발한 재배정 TRACK_EVENT).
    // 서버가 배달 불변식대로 올리지 않았다는 뜻이므로 내용은 반영하고 번호는 그대로 둔다.
    // 같다고 버리면 내가 요청한 결과가 통째로 삼켜진다.
    const echo = cur !== undefined && sameEpoch && version.seq === cur.version.seq
    if (cur && sameEpoch) {
      if (version.seq < cur.version.seq) return { accepted: false, why: 'stale' }
      if (!whole && cur.desync) return { accepted: false, why: 'desync' }
      if (!whole && !echo && version.seq !== cur.version.seq + 1) {
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

  /**
   * 연§4-6-3 — ★**`version` 없이 나에게만 오는 프레임**(배정만 바뀌는 `TRACK_EVENT{add}`).
   *
   * ★★**`seq` 가 못 세는 층이라 번호가 없다**(배정은 수신자별이고 방 공통 스냅샷 밖이다).
   * 그래서 견주기를 태우지 않는다 — 태우면 번호가 없어 ★**갭으로 보이고 통째로 버려진다.**
   * ★버리면 서버가 옮겨 준 내 m-line 자리를 영영 모른 채 옛 자리로 조립한다.
   */
  applyAssign(roomId: string, tracks: readonly TrackEntry[]): Verdict {
    // ★방을 모르면 받을 자리도 없다 — 없는 방의 배정을 지어 넣지 않는다.
    if (!this.rooms.has(roomId)) return { accepted: false, why: 'stale' }
    return { ...this.patch('add', tracks), reset: false }
  }

  /** 방을 나갔다 — 그 방 항목과 자리를 놓는다(연§7-5-5). */
  dropRoom(roomId: string): void {
    for (const [id, e] of [...this.byTrack]) {
      if (e.room_id !== roomId) continue
      this.byTrack.delete(id)
      if (e.assign) this.vacancies.delete(e.assign.mid)
    }
    this.rooms.delete(roomId)
  }

  /** ★**자리 없는 것도 낸다** — 보관본은 스트림 층이고, 자리는 배정 층이다. */
  tracks(roomId?: string): readonly TrackEntry[] {
    const all = [...this.byTrack.values()]
    const picked = roomId === undefined ? all : all.filter((e) => e.room_id === roomId)
    return picked.sort((a, b) => seatNum(a) - seatNum(b))
  }

  /**
   * 연§9-5 — 조립은 mid 수치 오름차순이고 빈 자리도 줄을 차지한다.
   *
   * ★**자리가 붙은 것만 절이 된다** — `assign` 이 없는 스트림(고갈·비점유·미배정)은
   * 받을 m-line 이 없는 것이라 ★**SDP 에 넣을 수 없다.** 그 사실은 `unreachable` 이 말한다.
   */
  seats(): readonly SeatRow[] {
    const rows: SeatRow[] = []
    const taken = new Set<string>()
    for (const e of this.byTrack.values()) {
      if (!e.assign) continue
      taken.add(e.assign.mid)
      rows.push(flatten(e, e.assign))
    }
    for (const [mid, v] of this.vacancies) if (!taken.has(mid)) rows.push(v)
    return rows.sort((a, b) => midNum(a.mid) - midNum(b.mid))
  }

  versionOf(roomId: string): Version | undefined {
    return this.rooms.get(roomId)?.version
  }

  isDesynced(roomId: string): boolean {
    return this.rooms.get(roomId)?.desync ?? false
  }

  private replace(roomId: string, tracks: readonly TrackEntry[]): Omit<Verdict & { accepted: true }, 'reset'> {
    const before = new Map([...this.byTrack].filter(([, e]) => e.room_id === roomId))
    for (const id of before.keys()) this.byTrack.delete(id)

    const added: TrackEntry[] = []
    const unreachable: TrackEntry[] = []
    for (const t of tracks) {
      this.put(t)
      // ★**받을 자리가 없다**(고갈·비점유) — 보관은 하되 부르는 쪽이 그 사실을 알아야 한다.
      if (!t.assign) unreachable.push(t)
      if (!before.has(t.track_id)) added.push(t)
    }
    const removed = [...before.values()].filter((e) => !this.byTrack.has(e.track_id))
    for (const e of removed) this.seat(e)
    this.rooms.get(roomId)!.desync = false
    return { accepted: true, added, removed, unreachable }
  }

  private patch(kind: 'add' | 'remove', tracks: readonly TrackEntry[]): Omit<Verdict & { accepted: true }, 'reset'> {
    const added: TrackEntry[] = []
    const removed: TrackEntry[] = []
    const unreachable: TrackEntry[] = []
    for (const t of tracks) {
      if (kind === 'add') {
        this.put(t)
        if (!t.assign) unreachable.push(t)
        added.push(t)
      } else {
        const gone = this.byTrack.get(t.track_id)
        this.byTrack.delete(t.track_id)
        if (gone) { this.seat(gone); removed.push(gone) }
      }
    }
    return { accepted: true, added, removed, unreachable }
  }

  /**
   * 한 항목을 보관본에 넣는다 — ★**층마다 규칙이 다르다**(연§4-1-1).
   *
   * ★**스트림 층은 통째 교체**(서버가 매번 전 필드를 싣는다 — 병합이 아니다).
   * ★**배정 층은 실려 왔을 때만 갈아 끼운다** — 안 실린 것은 *"안 바뀌었다"* 가 아니라
   * 경로마다 뜻이 다르고(`remove` 는 지울 자리를 싣는다), 그 구분을 여기서 지운다.
   */
  private put(t: TrackEntry): void {
    const prev = this.byTrack.get(t.track_id)
    const assign = t.assign ?? prev?.assign
    const next: TrackEntry = assign === undefined ? stripAssign(t) : { ...t, assign }
    if (next.assign) {
      // ★★**같은 `mid` 가 다른 스트림에 붙으면 옛 항목의 자리를 비운다**(연§4-1-1).
      //   ★안 비우면 한 m-line 을 둘이 주장해 ★**조립이 그 자리에서 둘로 갈린다.**
      for (const [id, e] of this.byTrack) {
        if (id !== t.track_id && e.assign?.mid === next.assign.mid) {
          this.byTrack.set(id, stripAssign(e))
        }
      }
      this.vacancies.delete(next.assign.mid)
    }
    this.byTrack.set(t.track_id, next)
  }

  /** 지우기 직전 항목의 pt·codec 이 자리 지킴 m-line 의 재료다(연§4-1). */
  private seat(e: TrackEntry): void {
    // ★자리가 없던 항목은 지킬 자리도 없다 — `mid` 를 지어내지 않는다.
    if (!e.assign) return
    this.vacancies.set(e.assign.mid, {
      mid: e.assign.mid,
      kind: e.kind,
      pt: e.assign.pt,
      ...(e.codec === undefined ? {} : { codec: e.codec }),
      ...(e.fmtp === undefined ? {} : { fmtp: e.fmtp }),
    })
  }
}

/** `assign` 을 뺀 사본 — ★**`undefined` 를 담지 않는다**(있는 것과 구별이 흐려진다). */
function stripAssign(t: TrackEntry): TrackEntry {
  const { assign: _drop, ...rest } = t
  return rest
}
