// 예제 ② PTT 단말 — 방 하나, 말하기 모드, 토글 버튼, 카메라 무전 영상.
import { createClient, OxLensError, type LocalTrack, type PttState } from '../src/index.js'

declare const app: {
  base: string
  roomId: string
  fetchToken(): Promise<string>
  button: HTMLButtonElement
  ui: {
    status(text: string): void
    ptt(s: PttState): void
    speaker(userId: string | null): void
    video(track: MediaStreamTrack | null): void
    error(e: OxLensError): void
  }
}

export async function main(): Promise<void> {
  const client = createClient({ base: app.base, token: await app.fetchToken() })
  client.on('session', (s) => app.ui.status(`${s.state}${s.recovering ? ' (recovering)' : ''}${s.reason ? ` · ${s.reason.name}` : ''}`))
  client.on('tokenRequired', () => { void app.fetchToken().then((t) => client.setToken(t)) })
  client.on('closed', (e) => { if (e.retryable) void client.connect() })            // 백오프 소진 → 다시

  // ★트랙 리스너는 join 전에 client 레벨로 — join 과 room.on 사이의 await(enable)가 초기 트랙을 놓치게 한다(§6-2).
  client.on('track', (_room, t) => { if (t.kind === 'video' && t.slot) app.ui.video(t.mediaStreamTrack) })   // 무전 슬롯 영상(userId 없음)
  client.on('audioPlayback', (ok) => { if (!ok) app.ui.status('tap to enable audio') })

  try { await client.connect() }
  catch (e: unknown) {
    if (e instanceof OxLensError && e.code === 2003) { client.setToken(await app.fetchToken()); await client.connect() }
    else throw e
  }

  // 말하기 모드로 입장 = 이 방이 발언 방(select:true). 다른 서버에 발언 방이 있으면 SDK 가 먼저 푼다(연§7-5-1).
  const room = await client.join(app.roomId, { mode: 'talk' })
  const ptt = room.ptt
  ptt.input = 'toggle'      // 큐에서 차례가 오면 T132 안에 다시 눌러야 발언이 열린다(연§7-7-2-1)
  ptt.priority = 0
  await ptt.enable({ capture: { noiseSuppression: true } })   // 미리 데운다 — 반이중이라 'ptt' 프로필(AGC·NS·EC·DTX·FEC 켬) 위에 개별 제약만 덮어쓴다

  ptt.on('state', (s) => { app.ui.ptt(s); app.button.disabled = !s.canRequest && s.phase !== 'has_permission' && s.phase !== 'queued' })
  ptt.on('speaker', (e) => app.ui.speaker(e.userId))
  app.button.addEventListener('pointerdown', () => { void client.media.audio.startAudio() }, { once: true })
  room.on('error', (e) => app.ui.status(`background: ${e.name}`))

  // ★토글은 로컬 플래그가 아니라 phase 로 가른다 — 큐 승계 뒤(acceptPending)의 "다시 누르기"는 수락, 그 전의 queued 클릭은 철회다.
  app.button.addEventListener('click', () => {
    const s = ptt.state
    const wantPress = s.phase === 'off' || s.phase === 'no_permission' || (s.phase === 'queued' && s.acceptPending)
    void (wantPress ? ptt.press({ source: 'user' }) : ptt.release()).catch((e: unknown) => {
      if (e instanceof OxLensError) app.ui.error(e)
    })
  })

  // 카메라를 무전 영상으로 — 이 방 슬롯의 코덱·fmtp 는 SDK 가 맞춘다(연§6-3). 송출은 발언권 동안만.
  let cam: LocalTrack | null = null
  try {
    cam = await ptt.enableVideo({ simulcast: false })
  } catch (e: unknown) {
    if (e instanceof OxLensError && e.code === 1006) app.ui.status(`codec mismatch: ${JSON.stringify(e.details)}`)
    else if (e instanceof OxLensError && e.category === 'device') app.ui.status(`camera blocked by ${String(e.details?.['blockedBy'])}`)
    else throw e
  }
  cam?.on('ended', (e) => { if (e.reason === 'server_lost') app.ui.status('server forgot the camera — enable again') })   // RESUME publish_failed

  window.addEventListener('pagehide', () => { void cam?.stop(); void client.close() })
}
