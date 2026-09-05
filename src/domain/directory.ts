// author: kodeholic (powered by Claude)
// 연§5-3 · §5-5 — 방 목록과 방 상세. ★한 경로가 두 쓰임을 겸한다: 미리보기와 재동기.
import { Http, HttpFailed } from '../platform/http.js'
import { TrackEntry, Version } from './store.js'

export interface RoomRow {
  readonly room_id: string
  readonly name: string
  readonly capacity: number
  readonly user_count: number
  readonly created_at: number
  readonly rec: boolean
}

export interface RoomDetail extends RoomRow {
  readonly participants: readonly { user_id: string; role?: number; select?: boolean }[]
  readonly version: Version
  /** `?tracks=1` 일 때만. mid 는 ★내가 그 방에 입장 중일 때만 채워진다(연§5-5). */
  readonly tracks?: readonly TrackEntry[]
}

/** 연§5-1 인증 두 갈래 — 재동기는 세션 헤더가 정본이다(종일 켜둔 클라의 토큰은 만료돼 있다). */
export interface Credentials {
  token(): string
  sessionId(): string | null
}

export class Directory {
  constructor(
    private readonly base: string,
    private readonly creds: Credentials,
    private readonly http: Http,
  ) {}

  list(): Promise<{ rooms: readonly RoomRow[]; total: number }> {
    return this.fetch('/rooms', false) as Promise<{ rooms: readonly RoomRow[]; total: number }>
  }

  /** 미리보기 — 정원을 먹지 않고 명단에 오르지 않는다(연§5-5 ①). */
  preview(roomId: string): Promise<RoomDetail> {
    return this.fetch(`/rooms/${encodeURIComponent(roomId)}`, false) as Promise<RoomDetail>
  }

  /**
   * 재동기(연§5-5 ②③) — `?tracks=1` 은 명시적으로 요구한다. 기본이 0 인 이유가 그것이다.
   * ★세션 헤더로 부른다: 그래야 입장 중인 방의 `mid` 가 채워져 SDP 재료가 된다.
   */
  resync(roomId: string): Promise<RoomDetail> {
    return this.fetch(`/rooms/${encodeURIComponent(roomId)}?tracks=1`, true) as Promise<RoomDetail>
  }

  private async fetch(path: string, preferSession: boolean): Promise<unknown> {
    const url = `${this.base}${path}`
    const session = this.creds.sessionId()
    const headers = preferSession && session !== null
      ? { 'X-OxLens-Session': session }
      : { Authorization: `Bearer ${this.creds.token()}` }
    const res = await this.http.get(url, headers)
    if (res.status !== 200) throw new HttpFailed(res.status, url)
    return res.body
  }
}
