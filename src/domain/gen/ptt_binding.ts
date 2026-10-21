// ★생성 파일 — spec/sdk/gen/binding.py 가 SDK 정의서 원천(areas/flr 의 입구 표 · 효과 표)에서 짓는다. 손으로 고치지 않는다.
// 위(연동규격서)가 지은 FLR 클라 상태기를 SDK 표면에 잇는다 — 위가 입구 · 효과를 바꾸면 이 파일의 타입 검사가 깨져 SDK 짓기가 멈춘다.
// 집행은 부르는 쪽이 plan() 의 목록대로 직접 한다 — 콜백을 주입하지 않는다.
import * as F from './floor_client.js'

/** SDK 가 앱에 내는 이벤트(효과 표의 app.* 행) */
export type PttEvent = 'denied' | 'granted' | 'queued' | 'revoked' | 'speaker' | 'state'
/** SDK 가 하는 동작(효과 표의 그 밖 행) */
export type PttAction = 'playback.render'

/** 위 입구 — 입구 표에서 SDK 가 넣는 것. SDK 표면이 이것을 부른다 */
export const ENTRY = {
  press: F.press,
  release: F.release,
  intent: F.intent,
  queuePosition: F.queuePosition,
  rtpTx: F.rtpTx,
  rtpRx: F.rtpRx,
  registerHalf: F.registerHalf,
  pubSelect: F.pubSelect,
  pubAway: F.pubAway,
  leave: F.leave,
  down: F.down,
  dcDown: F.dcDown,
  dcUp: F.dcUp,
  expire: F.expire,
  receive: F.receive,
} as const

/** 위 코드가 내놓는 입구 전부(Step 을 돌려주는 함수) — 입구 표가 하나라도 빠지거나 남으면 여기서 깨진다 · false = 넣지 않는다(판정표에 사유) */
type EntryName = { [K in keyof typeof F]: (typeof F)[K] extends (s: F.Cl, ...a: never[]) => F.Step | null ? K : never }[keyof typeof F]
export const ENTRY_ALL: Record<EntryName, boolean> = { press: true, release: true, intent: true, queuePosition: true, rtpTx: true, rtpRx: true, registerHalf: true, pubSelect: true, pubAway: true, leave: true, down: true, dcDown: true, dcUp: true, expire: true, receive: true }

/** 위 효과 하나 → SDK 가 낼 이벤트 · 할 동작(효과 표) — 위 효과가 늘거나 줄면 여기서 깨진다 */
export function effect(f: F.Fx): { readonly event?: PttEvent; readonly action?: PttAction; readonly seam?: string } {
  switch (f) {
    case 'media.render': return { action: 'playback.render' }
    case 'app.granted': return { event: 'granted' }
    case 'app.granted_queued': return { event: 'granted' }
    case 'app.denied': return { event: 'denied' }
    case 'app.queued': return { event: 'queued' }
    case 'app.revoked': return { event: 'revoked' }
    case 'app.speaker': return { event: 'speaker' }
    case 'app.speaker_none': return { event: 'speaker' }
    case 'app.request_timeout': return { event: 'state' }
    case 'app.queue_timeout': return { event: 'state' }
    case 'app.grant_expired': return { event: 'state' }
    case 'app.floor_unreliable': return { event: 'state' }
    case 'app.floor_reliable': return { event: 'state' }
    case 'mic.close': return { seam: 'PUB' }   // 위 이음매 — 받는 곳은 위가 정했다
    case 'mic.open': return { seam: 'PUB' }   // 위 이음매 — 받는 곳은 위가 정했다
    default: {
      const missing: never = f
      throw new Error(`효과 표에 없는 위 효과: ${String(missing)}`)
    }
  }
}

/** 한 걸음의 집행 목록 — 보낼 것 · 걸 타이머 · ACK는 위가 정한 그대로, 이벤트 · 동작은 효과 표대로 */
export interface Plan {
  readonly state: F.Cl
  readonly label: string
  readonly send: readonly F.Tx[]
  readonly ack: readonly F.Ack[]
  readonly routed: readonly F.Fx[]   // 위 이음매로 넘길 효과(위 IR seams)
  readonly timers: readonly F.TimerName[]
  readonly events: readonly PttEvent[]
  readonly actions: readonly PttAction[]
}
export function plan(step: F.Step): Plan {
  const events: PttEvent[] = []
  const actions: PttAction[] = []
  const routed: F.Fx[] = []
  for (const f of step.fx) {
    const e = effect(f)
    if (e.seam) routed.push(f)
    if (e.event) events.push(e.event)
    if (e.action) actions.push(e.action)
  }
  return { state: step.s, label: step.label, send: step.out, ack: step.ack, routed, timers: step.start, events, actions }
}
