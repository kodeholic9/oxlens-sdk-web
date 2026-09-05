// 예제 ① 지령대 — 채널 10개 상시 모니터링 + 선택 채널 PTT(hold).
// ★이 파일은 계약의 일부다(정의서 규율 "API 는 예제가 계약의 일부"). api.ts 만 보고 쓴다.
import { createClient, OxLensError, type Participant, type PttState, type RemoteTrack, type Room } from '../src/index.js'

declare const app: {
  base: string
  fetchToken(): Promise<string>
  channels: ReadonlyArray<string>
  ui: {
    connection(state: string, recovering: boolean): void
    roster(channel: string, list: ReadonlyArray<Participant>): void
    attachVideo(channel: string, track: RemoteTrack): void
    speaker(channel: string, userId: string | null): void
    speakingChannel(channel: string | null): void
    ptt(channel: string, s: PttState): void
    warn(msg: string): void
  }
}

export async function main(): Promise<void> {
  const client = createClient({ base: app.base, token: await app.fetchToken(), pcMode: 'auto' })

  client.on('session', (s) => app.ui.connection(s.state, s.recovering))          // 연§2-2 넷 + 복구 중
  client.on('tokenRequired', () => { void app.fetchToken().then((t) => client.setToken(t)) })  // 재접속 중의 2003 · Close 4004
  client.on('closed', (e) => app.ui.warn(`closed ${e.code} ${e.name} retryable=${e.retryable}`))
  client.on('speakingRoom', (r) => app.ui.speakingChannel(r?.id ?? null))       // 지금 송신 채널
  client.on('audioPlayback', (ok) => { if (!ok) app.ui.warn('click anywhere to enable audio') })   // autoplay 정책
  window.addEventListener('click', () => { void client.media.audio.startAudio() }, { once: true })
  // ★트랙은 client 레벨에서, join 전에 건다 — 초기 트랙(join resolve 다음 tick)을 allSettled 뒤의 루프가 놓치지 않는다(§6-2).
  client.on('track', (room, t) => { if (t.kind === 'video') app.ui.attachVideo(room.id, t) })   // ui 는 t.attach(el) 로 붙인다 → adaptiveStream 이 안 보는 채널을 멈춘다. 오디오는 SDK 가 재생한다
  client.on('trackUnreachable', (room, t) => app.ui.warn(`${room.id}: track ${t.id} unreachable (mid exhausted)`))

  try {
    await client.connect()
  } catch (e: unknown) {
    if (e instanceof OxLensError && e.code === 2003) { client.setToken(await app.fetchToken()); await client.connect() }
    else throw e
  }

  // 열 채널을 듣기만으로 — 명단에 오르고 정원을 먹는다(연§2-3). 기본 mode 가 listen 이다.
  // 한 채널이 3001 이어도 나머지가 붙게 allSettled.
  const results = await Promise.allSettled(app.channels.map((ch) => client.join(ch)))
  const rooms: Room[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') rooms.push(r.value)
    else app.ui.warn(`${app.channels[i]}: join failed ${(r.reason as OxLensError).code} ${(r.reason as OxLensError).name}`)
  })

  for (const room of rooms) {
    room.on('participants', (list) => app.ui.roster(room.id, list))                // mode 로 청취/참여 구분(입장 시점 select — 자격 아님)
    room.on('forced', (e) => app.ui.warn(`${room.id}: removed by server (${e.cause})`))
    room.on('rebuilding', () => app.ui.warn(`${room.id}: media lost, rebuilding`))
    room.on('error', (e) => app.ui.warn(`${room.id}: background failure ${e.name}`))
    room.ptt.on('speaker', (e) => app.ui.speaker(room.id, e.userId))              // 화자 표시는 발언권 축 하나(연§11-6)
    room.audio.setVolume(0.6)                                                       // 모니터링 채널은 낮게
  }

  // 지령대가 끼어드는 채널 하나 — 청취 전용으로 들어왔어도 press 가 등록부터 한다(연§7-7-1 0단계).
  const active = rooms[2]
  if (!active) return
  active.audio.setVolume(1.0)
  await client.setSpeakingRoom(active.id)                                          // 누르기 전에 채널을 고른다(MCOP·Apple 선례)
  active.ptt.input = 'hold'
  active.ptt.on('state', (s) => {
    app.ui.ptt(active.id, s)                                                          // 버튼 활성 = canRequest ∨ has_permission ∨ queued
    if (!s.trusted) app.ui.warn(`${active.id}: floor display untrusted (DC down)`)   // 연§7-7-8
    if (s.draining) app.ui.warn(`${active.id}: revoked — audio drains for up to 3s`)  // 연§7-7-6 4
    if (s.lastRevoke?.cause === 2) app.ui.warn('talked too long — wait T9 then press again')
    if (s.lastRevoke?.cause === 4) app.ui.warn('pre-empted — pressing again will be pre-empted too')
    if (s.lastEnd === 't1_reclaimed') app.ui.warn('server reclaimed the floor (no audio sent)')
  })

  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || ev.repeat) return
    void active.ptt.press().catch((e: unknown) => {
      if (e instanceof OxLensError && e.category === 'device') app.ui.warn(`mic blocked by ${String(e.details?.['blockedBy'])}`)
      else app.ui.warn(`press failed: ${(e as Error).message}`)
    })
  })
  window.addEventListener('keyup', (ev) => { if (ev.code === 'Space') void active.ptt.release() })

  window.addEventListener('pagehide', () => { void client.close() })
}
