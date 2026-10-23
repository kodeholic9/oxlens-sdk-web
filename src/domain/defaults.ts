// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-SES-API createClient · 정책:sdk · model: claude-opus-5-5
import { DEFAULTS } from './gen/sdk_defaults.js'
import { TIMER_MS as SES_MS, LADDER } from './gen/session_client.js'

export interface Layer {
  readonly rid?: string
  readonly scaleResolutionDownBy?: number
  readonly maxBitrate?: number
  readonly maxFramerate?: number
}

export interface ScreenShareDefaults {
  readonly simulcast?: boolean
  readonly contentHint?: string
  readonly degradationPreference?: RTCDegradationPreference
  readonly maxBitrate?: number
  readonly maxFramerate?: number
}

export interface CameraDefaults {
  readonly width?: number
  readonly height?: number
  readonly frameRate?: number
}

export interface OpusFmtp {
  readonly usedtx?: number
  readonly useinbandfec?: number
  readonly stereo?: number
  readonly maxaveragebitrate?: number
}

/** createClient 옵션 — 안 준 칸(undefined · null)은 정책서 SDK 기본값으로 채우고 호출별 옵션이 이긴다 */
export interface ClientOptions {
  readonly base: string
  readonly token: string
  readonly pcMode?: 'auto' | '1pc' | '2pc' | null
  readonly clientVer?: number | null
  readonly disconnectOnPageLeave?: boolean | null
  readonly adaptiveStream?: boolean | null
  readonly deviceAcquireTimeoutMs?: number | null
  readonly statsIntervalMs?: number | null
  readonly dcReopen?: { readonly tries?: number; readonly intervalMs?: number } | null
  readonly opusFmtpDefault?: OpusFmtp | null
  readonly wobblyGraceMs?: number | null
  readonly iceRestartTimeoutMs?: number | null
  readonly iceRestartBackoffMs?: readonly number[] | null
  readonly recoveryStableMs?: number | null
  readonly wakeDetectMs?: number | null
  readonly wsProbeTimeoutMs?: number | null
  readonly massJitterMs?: number | null
  readonly unreachableAfter?: number | null
  readonly publishDefaults?: { readonly simulcastLayers?: readonly Layer[] | null; readonly screenShare?: ScreenShareDefaults | null } | null
  readonly captureDefaults?: { readonly camera?: CameraDefaults | null } | null
  readonly silenceWindowMs?: number | null
  readonly adaptiveStreamSettleMs?: number | null
}

export interface Settings {
  readonly base: string
  readonly token: string
  readonly pcMode: 'auto' | '1pc' | '2pc'
  readonly clientVer: number
  readonly disconnectOnPageLeave: boolean
  readonly adaptiveStream: boolean
  readonly deviceAcquireTimeoutMs: number
  readonly statsIntervalMs: number
  readonly dcReopen: { readonly tries: number; readonly intervalMs: number }
  readonly opusFmtpDefault: OpusFmtp
  readonly wobblyGraceMs: number
  readonly iceRestartTimeoutMs: number
  readonly iceRestartBackoffMs: readonly number[]
  readonly recoveryStableMs: number
  readonly wakeDetectMs: number
  readonly wsProbeTimeoutMs: number
  readonly massJitterMs: number
  readonly unreachableAfter: number
  readonly simulcastLayers: readonly Layer[]
  readonly screenShare: ScreenShareDefaults
  readonly cameraCapture: CameraDefaults
  readonly silenceWindowMs: number
  readonly adaptiveStreamSettleMs: number
  readonly micColdAfterMs: number
  readonly playoutDelayMs: number | null
  readonly quality: typeof DEFAULTS.quality
}

function pick<T>(v: T | null | undefined, d: T): T {
  return v === undefined || v === null ? d : v
}

/** 내장 기본값 위에 주입값을 덮는다 — 묶음은 묶음마다 병합(정책:sdk 4-1) */
export function settle(o: ClientOptions): Settings {
  return {
    base: o.base,
    token: o.token,
    pcMode: pick(o.pcMode, 'auto'),
    clientVer: pick(o.clientVer, 1),
    disconnectOnPageLeave: pick(o.disconnectOnPageLeave, true),
    adaptiveStream: pick(o.adaptiveStream, true),
    deviceAcquireTimeoutMs: pick(o.deviceAcquireTimeoutMs, DEFAULTS.deviceAcquireTimeoutMs),
    statsIntervalMs: pick(o.statsIntervalMs, DEFAULTS.statsIntervalMs),
    dcReopen: { tries: pick(o.dcReopen?.tries, DEFAULTS.dcReopen.tries), intervalMs: pick(o.dcReopen?.intervalMs, DEFAULTS.dcReopen.intervalMs) },
    opusFmtpDefault: { ...DEFAULTS.opusFmtpDefault, ...(o.opusFmtpDefault ?? {}) },
    wobblyGraceMs: pick(o.wobblyGraceMs, DEFAULTS.wobblyGraceMs),
    iceRestartTimeoutMs: pick(o.iceRestartTimeoutMs, DEFAULTS.iceRestartTimeoutMs),
    iceRestartBackoffMs: pick(o.iceRestartBackoffMs, LADDER.waits as readonly number[]),
    recoveryStableMs: pick(o.recoveryStableMs, SES_MS.TStable ?? 10000),
    wakeDetectMs: pick(o.wakeDetectMs, DEFAULTS.wakeDetectMs),
    wsProbeTimeoutMs: pick(o.wsProbeTimeoutMs, DEFAULTS.wsProbeTimeoutMs),
    massJitterMs: pick(o.massJitterMs, DEFAULTS.massJitterMs),
    unreachableAfter: pick(o.unreachableAfter, DEFAULTS.unreachableAfter),
    simulcastLayers: pick(o.publishDefaults?.simulcastLayers, DEFAULTS.simulcastLayers as readonly Layer[]),
    screenShare: { ...DEFAULTS.screenShare, ...(o.publishDefaults?.screenShare ?? {}) } as ScreenShareDefaults,
    cameraCapture: { ...DEFAULTS.cameraCapture, ...(o.captureDefaults?.camera ?? {}) },
    silenceWindowMs: pick(o.silenceWindowMs, DEFAULTS.silenceWindowMs),
    adaptiveStreamSettleMs: pick(o.adaptiveStreamSettleMs, DEFAULTS.adaptiveStreamSettleMs),
    micColdAfterMs: DEFAULTS.micColdAfterMs,
    playoutDelayMs: DEFAULTS.playoutDelayMs,
    quality: DEFAULTS.quality,
  }
}

/** opus answer fmtp 의 바탕 — 방 코덱의 고정 opus 값(연:RULE-LINK-SDP-PUB-MLINE 예외 · 구독 줄 선언과 같다). */
export const ROOM_OPUS_FMTP = 'minptime=10;useinbandfec=1'

/** 클라가 조립하는 answer 의 opus fmtp — 바탕 위에 받는 쪽 선호(정책:sdk.opusFmtpDefault)를 더한다(연:RULE-LINK-SDP-PUB-MLINE · SDK 정의서 오디오 인코딩).
 *  ★DTX(usedtx=1)는 이 설정이 정한다(20261023 — 고정값에 막혀 무시되던 것). 받는 쪽 선호는 PT 튜플 밖이라 서버는 보지 않는다. */
export function opusFmtpLine(f: OpusFmtp): string {
  const parts = [`minptime=10`, `useinbandfec=${f.useinbandfec === 0 ? 0 : 1}`]
  if (f.usedtx === 1) parts.push('usedtx=1')
  if (f.stereo === 1) parts.push('stereo=1')
  if (f.maxaveragebitrate !== undefined) parts.push(`maxaveragebitrate=${f.maxaveragebitrate}`)
  return parts.join(';')
}
