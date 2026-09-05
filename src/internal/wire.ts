// author: kodeholic (powered by Claude)
// 연§6 op 전량 16 과 연§3-2 우선순위 단. 숫자가 계약이라 이름은 여기 한 곳에서만 짓는다.

export const Op = {
  Bind: 0x0101,
  Resume: 0x0102,
  Heartbeat: 0x0103,
  RoomJoin: 0x0201,
  RoomLeave: 0x0202,
  PublishTracks: 0x0301,
  Ready: 0x0302,
  SubscribeLayer: 0x0303,
  TrackSet: 0x0304,
  Affiliation: 0x0401,
  Message: 0x0501,
  Task: 0x0601,
  ParticipantEvent: 0x0701,
  TrackEvent: 0x0702,
  TrackState: 0x0703,
  RoomEvent: 0x0704,
} as const

export type OpCode = (typeof Op)[keyof typeof Op]

const NAMES = new Map<number, string>(
  Object.entries(Op).map(([name, code]) => [code, name.replace(/[a-z](?=[A-Z])/g, '$&_').toUpperCase()]),
)

/** 모르는 번호는 숫자 그대로 — 로그가 비지 않는다. */
export function opName(op: number): string {
  return NAMES.get(op) ?? `0x${op.toString(16).padStart(4, '0')}`
}

/** 연§3-2 — 0 복구 · 1 세션·방·미디어 · 2 데이터 · 3 진단. 방 상태를 나르는 것은 전부 1단이다. */
export function tierOf(op: number): 0 | 1 | 2 | 3 {
  if (op === Op.Resume) return 0
  if (op === Op.Message) return 2
  if (op === Op.Task) return 3
  return 1
}

/** 연§3-2 — RESUME 만 윈도우 밖이다. */
export function countsTowardWindow(op: number): boolean {
  return op !== Op.Resume
}

/** 연§4-5 실패 응답 body. */
export interface Failure {
  readonly code: number
  readonly name: string
  readonly message?: string
  readonly details?: Readonly<Record<string, unknown>>
}

/** 연§10-3 — 클라는 code 로 판단한다. 이 넷이 아니면 백오프로 다시 붙는다. */
export function reconnectable(closeCode: number): boolean {
  return closeCode !== 4000 && closeCode !== 4001 && closeCode !== 4002 && closeCode !== 4005
}
