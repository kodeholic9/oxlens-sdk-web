// ★생성 파일 — spec/sdk/gen/binding.py 가 SDK 정의서 원천(areas/aff 의 입구 표 · 효과 표)에서 짓는다. 손으로 고치지 않는다.
// 위(연동규격서)가 지은 AFF 클라 상태기를 SDK 표면에 잇는다 — 위가 입구 · 효과를 바꾸면 이 파일의 타입 검사가 깨져 SDK 짓기가 멈춘다.
// 집행은 부르는 쪽이 plan() 의 목록대로 직접 한다 — 콜백을 주입하지 않는다.
import * as F from './aff_client.js'

/** SDK 가 앱에 내는 이벤트(효과 표의 app.* 행) */
export type AffEvent = 'speakingRoom' | 'speakingRoomFailed'
/** SDK 가 하는 동작(효과 표의 그 밖 행) */
export type AffAction = never

/** 위 입구 — 입구 표에서 SDK 가 넣는 것. SDK 표면이 이것을 부른다 */
export const ENTRY = {
  select: F.select,
  deselect: F.deselect,
  res: F.res,
  left: F.left,
} as const

/** 위 코드가 내놓는 입구 전부(Step 을 돌려주는 함수) — 입구 표가 하나라도 빠지거나 남으면 여기서 깨진다 · false = 넣지 않는다(판정표에 사유) */
type EntryName = { [K in keyof typeof F]: (typeof F)[K] extends (s: F.St, ...a: never[]) => F.Step | null ? K : never }[keyof typeof F]
export const ENTRY_ALL: Record<EntryName, boolean> = { select: true, deselect: true, res: true, left: true }

/** 위 효과 하나 → SDK 가 낼 이벤트 · 할 동작(효과 표) — 위 효과가 늘거나 줄면 여기서 깨진다 */
export function effect(f: F.Fx): { readonly event?: AffEvent; readonly action?: AffAction } {
  switch (f) {
    case 'app.affiliation': return { event: 'speakingRoom' }
    case 'app.aff_failed': return { event: 'speakingRoomFailed' }
    default: {
      const missing: never = f
      throw new Error(`효과 표에 없는 위 효과: ${String(missing)}`)
    }
  }
}

/** 한 걸음의 집행 목록 — 보낼 것 · 걸 타이머 · 이음매(받는 곳은 위가 정한다)는 위가 정한 그대로, 이벤트 · 동작은 효과 표대로 */
export interface Plan {
  readonly state: F.St
  readonly label: string
  readonly send: readonly F.Tx[]
  readonly seams: readonly F.Seam[]
  readonly timers: readonly F.TimerName[]
  readonly events: readonly AffEvent[]
  readonly actions: readonly AffAction[]
}
export function plan(step: F.Step): Plan {
  const events: AffEvent[] = []
  const actions: AffAction[] = []
  for (const f of step.fx) {
    const e = effect(f)
    if (e.event) events.push(e.event)
    if (e.action) actions.push(e.action)
  }
  return { state: step.s, label: step.label, send: step.out, seams: step.seams, timers: step.start, events, actions }
}
