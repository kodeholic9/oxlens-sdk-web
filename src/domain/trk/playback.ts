// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-SRC-BLOCKS Playback(소유 = rooms · RemoteTrack) · SDK:IMPL-TRK-RECEIVE room.audio · SDK:RULE-SRC-DEVICES audioOutput · SDK:RULE-MOD-AREA-MIRROR domain/trk · model: claude-opus-5-5
// 옛 domain/media-registry.ts 의 Playback 을 옮겨 왔다 — 받는 쪽 블록이라 발행(PUB) 몫이 아니다.
import { Emitter } from '../../platform/emitter.js'
import type { Logger } from '../../platform/log.js'
import { canSetSink, documentTarget } from '../../platform/env.js'

/** 재생 — 방 오디오 요소 · autoplay 정책 · 출력 장치 · 클라이언트 객체 하나에 하나(방 목록이 든다) */
export class Playback {
  allowed = true
  sink: string | null = null
  readonly events = new Emitter<{ audioPlayback: [boolean] }>()
  private readonly els = new Set<HTMLAudioElement>()

  constructor(private readonly log: Logger) {
    const doc = documentTarget()
    if (doc) doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible' && !this.allowed) void this.start() })
  }

  /** 재생 요소는 문서에 붙인다(숨김) — 떼어 낸 요소는 탭 정책에 따라 재생이 멎는다 */
  add(el: HTMLAudioElement): void {
    this.els.add(el)
    const doc = documentTarget()
    if (doc?.body && !el.isConnected) { el.hidden = true; doc.body.appendChild(el) }
    if (this.sink && canSetSink()) void (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(this.sink).catch(() => undefined)
  }

  remove(el: HTMLAudioElement): void { this.els.delete(el); try { el.pause() } catch { /* 없다 */ } el.remove() }

  play(el: HTMLAudioElement): void {
    void el.play().then(() => this.mark(true), (e: unknown) => { if (e && typeof e === 'object' && (e as { name?: string }).name === 'NotAllowedError') this.mark(false) })
  }

  private mark(ok: boolean): void {
    if (ok === this.allowed) return
    this.allowed = ok
    this.events.emit('audioPlayback', ok)
  }

  /** 앱이 사용자 제스처 안에서 부른다 */
  async start(): Promise<void> {
    let ok = true
    for (const el of this.els) { try { await el.play() } catch { ok = false } }
    this.mark(ok)
  }

  async output(deviceId: string | null): Promise<void> {
    this.sink = deviceId
    if (!canSetSink()) { this.log.warn('setSinkId 가 없다 — audioOutput 은 동작하지 않는다'); return }
    for (const el of this.els) await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId ?? '')
  }
}
