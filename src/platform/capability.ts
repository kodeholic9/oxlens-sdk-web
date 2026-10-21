// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:RULE-PLAT-PC-MODE · 연:RULE-LINK-SDP-1PC-MODE · model: claude-opus-5-5
import { userAgent } from './env.js'

export type PcMode = '1pc' | '2pc'
export type UaFamily = 'chrome' | 'safari' | 'firefox' | 'android-libwebrtc'

export interface CapabilityRow {
  readonly ua: UaFamily
  readonly from: number
  readonly pcMode: PcMode
}

/**
 * 갖춰 둔 표 — 3층 라이브 실측 행만 싣는다(SDK:RULE-PLAT-PC-MODE).
 * chrome 행은 실측 문자열 HeadlessChrome/153 의 엔진 판(Chromium 153)부터다 · firefox 행은 Firefox/155 부터다.
 */
export const TABLE: readonly CapabilityRow[] = [
  { ua: 'chrome', from: 153, pcMode: '1pc' },
  { ua: 'firefox', from: 155, pcMode: '1pc' },
]

export function familyOf(ua: string): { family: UaFamily; major: number } | null {
  const ff = /Firefox\/(\d+)/.exec(ua)
  if (ff) return { family: 'firefox', major: Number(ff[1]) }
  if (/Android/.test(ua) && !/Chrome\//.test(ua)) return null
  const cr = /(?:HeadlessChrome|Chrome|Chromium)\/(\d+)/.exec(ua)
  if (cr && !/Edg\//.test(ua)) return { family: 'chrome', major: Number(cr[1]) }
  if (/Safari\//.test(ua) && /Version\//.test(ua)) {
    const v = /Version\/(\d+)/.exec(ua)
    return { family: 'safari', major: Number(v?.[1] ?? 0) }
  }
  return null
}

/** 붙기 전 판정 — 표에 없는(모르는) 브라우저는 2pc · 앱 지정이 이긴다 · 런타임 폴백은 없다 */
export function decide(asked: PcMode | 'auto', ua: string = userAgent()): PcMode {
  if (asked !== 'auto') return asked
  const f = familyOf(ua)
  if (!f) return '2pc'
  const row = TABLE.find((r) => r.ua === f.family && f.major >= r.from)
  return row ? row.pcMode : '2pc'
}
