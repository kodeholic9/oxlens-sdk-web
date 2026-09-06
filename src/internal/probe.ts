import { PeerLink } from './transport/link.js'

/**
 * SDK§8-2 층 경계 — ★`internal` 은 `domain` 을 모른다. 그래서 조립에 필요한 만큼만 여기서 형을 세운다.
 * 채우는 것은 부르는 쪽(`api/client`)이고, 이쪽은 ★**모양만 알고 뜻은 모른다.**
 */
export interface PubRow {
  readonly kind: string
  readonly source: string
  readonly duplex: string
  readonly state: string
  readonly owner: string
  readonly muted: boolean
  readonly trackId: string | null
  readonly room: string | null
  readonly ssrc: number | null
  readonly link: PeerLink | null
}

export interface SubRow {
  readonly track_id: string
  readonly kind: string
  readonly room_id: string
  readonly ssrc?: number
  readonly mid?: string
  readonly user_id?: string
  readonly codec?: string
  readonly pt?: number
  readonly active?: boolean
}

export interface ProbeSources {
  publishing(): readonly PubRow[]
  subscribed(): readonly { entry: SubRow; link: PeerLink | null }[]
  state(): Record<string, unknown>
  env?(): Record<string, unknown> | undefined
  devices?(): Promise<ReadonlyArray<Record<string, unknown>>>
  permissions?(): Promise<Record<string, unknown>>
  network?(): Promise<Record<string, unknown> | undefined>
}

export interface Probe {
  error?: string
  pub_tracks?: ReadonlyArray<Record<string, unknown>>
  sub_tracks?: ReadonlyArray<Record<string, unknown>>
  env?: Record<string, unknown>
  devices?: ReadonlyArray<Record<string, unknown>>
  permissions?: Record<string, unknown>
  state: Record<string, unknown>
  network?: Record<string, unknown>
}

export async function collect(src: ProbeSources): Promise<Probe> {
  const out: Probe = { state: src.state() }
  try {
    const pub = await pubTracks(src.publishing())
    if (pub.length > 0) out.pub_tracks = pub
    const sub = await subTracks(src.subscribed())
    if (sub.length > 0) out.sub_tracks = sub
    put(out, 'env', src.env?.())
    put(out, 'devices', await src.devices?.())
    put(out, 'permissions', await src.permissions?.())
    put(out, 'network', await src.network?.())
  } catch (e) {
    out.error = (e as Error).message
  }
  return out
}

function put<K extends keyof Probe>(out: Probe, key: K, value: Probe[K] | undefined): void {
  if (value === undefined) return
  if (Array.isArray(value) && value.length === 0) return
  out[key] = value
}

async function pubTracks(tracks: readonly PubRow[]): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = []
  for (const t of tracks) {
    const row: Record<string, unknown> = {
      track_id: t.trackId ?? undefined,
      kind: t.kind, source: t.source, duplex: t.duplex, state: t.state, owner: t.owner,
      muted: t.muted,
      ...(t.ssrc === null ? {} : { ssrc: t.ssrc }),
      ...(t.room === null ? {} : { room_id: t.room }),
    }
    if (t.link !== null && t.ssrc !== null && t.ssrc !== 0) {
      const stats = await t.link.statsFor(t.ssrc, 'outbound').catch(() => null)
      if (stats && stats.size > 0) row.stats = [...stats.values()]
    }
    rows.push(prune(row))
  }
  return rows
}

async function subTracks(
  subs: readonly { entry: SubRow; link: PeerLink | null }[],
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = []
  for (const { entry, link } of subs) {
    const row: Record<string, unknown> = {
      track_id: entry.track_id, kind: entry.kind, room_id: entry.room_id,
      ssrc: entry.ssrc, mid: entry.mid,
      ...(entry.user_id === undefined ? {} : { user_id: entry.user_id }),
      ...(entry.codec === undefined ? {} : { codec: entry.codec }),
      ...(entry.pt === undefined ? {} : { pt: entry.pt }),
      ...(entry.active === undefined ? {} : { active: entry.active }),
    }
    if (link !== null && typeof entry.ssrc === 'number') {
      const stats = await link.statsFor(entry.ssrc, 'inbound').catch(() => null)
      if (stats && stats.size > 0) row.stats = [...stats.values()]
    }
    rows.push(prune(row))
  }
  return rows
}

function prune(row: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k]
  return row
}
