// author: kodeholic (powered by Claude)
// 브라우저 offer 를 읽는다. 조립에 필요한 만큼만 — 붙어 있는 SDP 를 고쳐 쓰는 일은 없다(연§9-5).

export type Direction = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'
export type MediaKind = 'audio' | 'video' | 'application'

export interface MSection {
  readonly kind: MediaKind
  readonly mid: string
  readonly direction: Direction
  readonly pts: readonly number[]
  /** pt → "opus/48000/2" 원문. 서버 값으로 다시 쓰지 않는다(연§9-4). */
  readonly rtpmap: ReadonlyMap<number, string>
  readonly fmtp: ReadonlyMap<number, string>
  /** rtx_pt → apt. */
  readonly rtx: ReadonlyMap<number, number>
  readonly extmap: ReadonlyMap<number, string>
  readonly simulcastSend: boolean
  /** 브라우저가 정한 값 — 등록에 싣는 ssrc 는 여기서 읽는다(연§6-3). */
  readonly ssrcs: readonly number[]
  /** a=ssrc-group:FID 의 짝. 두 번째가 재전송 ssrc 다. */
  readonly fid: readonly [number, number] | null
}

export interface ParsedSdp {
  readonly bundle: readonly string[]
  readonly sections: readonly MSection[]
}

const DIRECTIONS: readonly Direction[] = ['sendrecv', 'sendonly', 'recvonly', 'inactive']

export function parse(sdp: string): ParsedSdp {
  const lines = sdp.split(/\r\n|\n/).filter((l) => l.length > 0)
  const bundle: string[] = []
  const sections: MSection[] = []

  interface Draft {
    kind: MediaKind; mid: string; direction: Direction; pts: number[]
    rtpmap: Map<number, string>; fmtp: Map<number, string>
    rtx: Map<number, number>; extmap: Map<number, string>; simulcastSend: boolean
    ssrcs: number[]; fid: [number, number] | null
  }
  let cur: Draft | null = null
  const flush = (): void => { if (cur) sections.push({ ...cur }) }

  for (const line of lines) {
    if (line.startsWith('m=')) {
      flush()
      const parts = line.slice(2).split(' ')
      cur = {
        kind: parts[0] as MediaKind,
        mid: '',
        direction: 'sendrecv',
        pts: parts.slice(3).map(Number).filter((n) => Number.isFinite(n)),
        rtpmap: new Map(), fmtp: new Map(), rtx: new Map(), extmap: new Map(),
        simulcastSend: false, ssrcs: [], fid: null,
      }
      continue
    }
    if (!cur) {
      const g = /^a=group:BUNDLE (.+)$/.exec(line)
      if (g) bundle.push(...g[1]!.trim().split(/\s+/))
      continue
    }

    const mid = /^a=mid:(.+)$/.exec(line)
    if (mid) { cur.mid = mid[1]!.trim(); continue }

    const dir = DIRECTIONS.find((d) => line === `a=${d}`)
    if (dir) { cur.direction = dir; continue }

    const rtpmap = /^a=rtpmap:(\d+) (.+)$/.exec(line)
    if (rtpmap) { cur.rtpmap.set(Number(rtpmap[1]), rtpmap[2]!.trim()); continue }

    const fmtp = /^a=fmtp:(\d+) (.+)$/.exec(line)
    if (fmtp) {
      const pt = Number(fmtp[1])
      const params = fmtp[2]!.trim()
      cur.fmtp.set(pt, params)
      const apt = /(?:^|;)\s*apt=(\d+)/.exec(params)
      if (apt) cur.rtx.set(pt, Number(apt[1]))
      continue
    }

    const ext = /^a=extmap:(\d+)(?:\/\w+)? (.+)$/.exec(line)
    if (ext) { cur.extmap.set(Number(ext[1]), ext[2]!.trim()); continue }

    if (line.startsWith('a=simulcast:send')) { cur.simulcastSend = true; continue }

    const fid = /^a=ssrc-group:FID (\d+) (\d+)$/.exec(line)
    if (fid) { cur.fid = [Number(fid[1]), Number(fid[2])]; continue }

    const ssrc = /^a=ssrc:(\d+) /.exec(line)
    if (ssrc) {
      const n = Number(ssrc[1])
      if (!cur.ssrcs.includes(n)) cur.ssrcs.push(n)
    }
  }
  flush()
  return { bundle, sections }
}

/** 연§9-4 — rtx 는 apt 로 원본 PT 에 매인다. 짝이 아니면 재전송을 원본으로 오인한다. */
export function rtxOf(m: MSection, pt: number): number | undefined {
  for (const [rtxPt, apt] of m.rtx) if (apt === pt) return rtxPt
  return undefined
}

/** rtpmap 원문에서 클럭만 떼어 본다 — rtx 줄이 원본과 같은 클럭이어야 한다. */
export function clockOf(rtpmap: string): number | undefined {
  const hz = Number(rtpmap.split('/')[1])
  return Number.isFinite(hz) ? hz : undefined
}

/** rtpmap 원문의 코덱 이름. 서버 목록과 견주는 자리다(연§9-4). */
export function codecOf(rtpmap: string): string {
  return rtpmap.split('/')[0] ?? ''
}
