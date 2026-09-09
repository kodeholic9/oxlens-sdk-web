// OxLens SDK — 공개 표면 계약 (surface first).
//
// ★이 파일이 곧 `context/spec/oxlens_sdk_spec.md` §2~§7 이다. 절 번호를 주석에 단다.
// ★wire 어휘가 여기 없다 — 표면은 사용자 어휘(listen/talk/press/speaker)다(정의서 §1-1).
// ★여기 없는 것은 API 가 아니다. 내부(internal/)는 재수출하지 않는다(정의서 §1-2).
//      client 레벨 track 이벤트(초기 트랙 계약) · 허가 전 release · acceptPending/talkingSince · 프로필은 duplex 가 고름(EC 켬) ·
//      AudioEncoding 은 answer+setParameters · LocalTrack.server 단수 · media.publish 전이중 전용 · OxLensError 클래스가 표면.

// ───────────────────────── 공통 ─────────────────────────

/** 이벤트 구독 규약 — 정의서 §2-2. 같은 방의 이벤트는 서버 도착 순서. 핸들러 안의 API 호출은 다음 tick. */
export interface Emitter<E extends Record<string, (...args: never[]) => void>> {
  on<K extends keyof E>(event: K, fn: E[K]): this
  off<K extends keyof E>(event: K, fn: E[K]): this
  once<K extends keyof E>(event: K, fn: E[K]): this
}

/** 정의서 §2-3. `code` 는 연동규격서 §10-2 의 숫자 그대로 — SDK 가 합치거나 바꾸지 않는다. wire 가 아닌 실패는 code 0 + name. */
export type ErrorCategory =
  | 'bug'          // 1xxx — 앱 코드를 고친다
  | 'auth'         // 2xxx
  | 'state'        // 3xxx · code 0 'STATE_*'(wire 를 안 탄 상태 오류 — 예: STATE_NO_SPEAKING_ROOM)
  | 'limit'        // 4xxx
  | 'server'       // 5xxx — SDK 가 3회(§2-2, 연§7-0-1 4) 다시 시도한 뒤에도 안 되면 온다
  | 'device'       // 장치 획득 실패 (code 0, name 'DEVICE_*', details = DeviceErrorDetails — kind·blockedBy)
  | 'negotiation'  // SDP 조립·적용 실패 · pc_mode 불일치 (code 0, name 'NEGOTIATION_*')
  | 'closed'       // 닫힌 핸들에 API · 접속 끊긴 채 대기 종료 (code 0, name 'CLOSED')

/** category 'device' 의 details.blockedBy — DEVICE_PERMISSION_DENIED 에만 실린다 (정의서 §2-3 "device 세부").
 *  user = 사이트 권한 차단(재호출 소용없음, 사이트 설정 안내) · dismissed = 프롬프트 닫음(재호출하면 다시 뜸) ·
 *  system = OS 가 브라우저를 차단(OS 설정 안내) · unknown = 못 가름(재호출 한 번, 그래도면 user 처방).
 *  판별 2층: Chromium cause.message("Permission dismissed"/"denied by system"/"denied") → permissions.query 'denied' → unknown. Firefox/Safari 는 대개 unknown. */
export type DeviceBlockedBy = 'user' | 'dismissed' | 'system' | 'unknown'

/** category 'device' 의 details 형 (정의서 §2-3). 한 호출은 한 kind 라 kind 는 항상 하나. */
export interface DeviceErrorDetails {
  readonly kind: 'audio' | 'video'
  readonly blockedBy?: DeviceBlockedBy
  /** DEVICE_OVERCONSTRAINED — OverconstrainedError.constraint */
  readonly constraint?: string
}

export interface OxLensErrorShape {
  readonly code: number
  readonly name: string
  readonly permanent: boolean
  readonly category: ErrorCategory
  readonly details?: Readonly<Record<string, unknown>>
  /** 원 Error(getUserMedia·RTCPeerConnection 이 던진 것). 선례: LiveKit Error.cause */
  readonly cause?: unknown
}

/** 표면의 오류 클래스 — reject 와 'error' 이벤트 모두 이것이다(instanceof 로 가른다). */
export class OxLensError extends Error implements OxLensErrorShape {
  override readonly name: string
  readonly code: number
  readonly permanent: boolean
  readonly category: ErrorCategory
  readonly details?: Readonly<Record<string, unknown>>
  override readonly cause?: unknown
  constructor(init: OxLensErrorShape & { readonly message?: string }) {
    super(init.message ?? init.name)
    this.name = init.name
    this.code = init.code
    this.permanent = init.permanent
    this.category = init.category
    if (init.details !== undefined) this.details = init.details
    if (init.cause !== undefined) this.cause = init.cause
  }
}

/** 클라 getStats 로 산출한 연결 품질 — 서버 계수가 아니다 (§11-2). 선례: LiveKit ConnectionQuality */
export type ConnectionQuality = 'excellent' | 'good' | 'poor' | 'lost'

// ───────────────────────── 세션 (§3) ─────────────────────────

/** 연동규격서 §2-2 의 넷 그대로. */
export type ConnectionState = 'disconnected' | 'connecting' | 'active' | 'resuming'

export interface CloseReason {
  /** 서버 Close 면 연동규격서 §10-3 close code(4000~4006). 망 절단·T-bind 만료·BIND 실패는 0 + name. */
  readonly code: number
  /** 'TRANSPORT' | 'BIND_TIMEOUT' | 'BIND_FAILED' | 연§10-3 이름. 로그용 — 판단은 code 로. */
  readonly name: string
}

export interface SessionInfo {
  readonly state: ConnectionState
  /** ★`active` 인데 어느 방이 재구축 중(RESUME failed·media_lost·축출 재입장). 어느 방인지는 Room.rebuilding. §3-1 */
  readonly recovering: boolean
  readonly userId: string | null
  readonly pcMode: '1pc' | '2pc' | null
  /** 마지막으로 끊긴 사유. 없으면 클라 주도 종료 또는 아직 안 끊김. */
  readonly reason?: CloseReason
  /** 신호 막대의 재료. 바뀌면 'session' 이벤트. */
  readonly quality: ConnectionQuality
}

export interface ClientOptions {
  /** 앱이 준다 — 스킴·호스트·기본 경로까지 (연§5-0). */
  readonly base: string
  /** 앱 백엔드가 발급한 JWT. SDK 는 /auth/token 을 부르지 않는다 (연§5-2). */
  readonly token: string
  /** 기본 'auto' = SDK 능력표(§12-3). '2pc' 강제 가능. 런타임 폴백은 없다 — 1pc 협상 실패는 negotiation 으로 오고 앱이 close() 뒤 2pc 로 다시 맺는다. */
  readonly pcMode?: '1pc' | '2pc' | 'auto'
  /** 클라 프로토콜 세대. 이 SDK 판 = 1 (연§6-1). */
  readonly clientVer?: number
  /** pagehide/beforeunload 에 close() 시도. 기본 true (§12-1). 선례: LiveKit disconnectOnPageLeave */
  readonly disconnectOnPageLeave?: boolean
  /** RemoteTrack.attach() 한 영상의 크기·가시성으로 setLayer(paused·spatial·priority)를 대신 한다. 기본 true (§6-2). 선례: LiveKit adaptiveStream */
  readonly adaptiveStream?: boolean
  /** getUserMedia 대기 상한(프롬프트 방치 포함). 만료 = DEVICE_TIMEOUT, 늦게 온 스트림은 SDK 가 stop. 기본 30,000 (정책서 §4-1 deviceAcquireTimeoutMs). 호출별 opts.timeoutMs 가 덮는다. */
  readonly deviceAcquireTimeoutMs?: number
  /** session.quality·diagnostics.stats 의 getStats 주기. 0 = 끔. 기본 5,000 (정책서 §4-1 statsIntervalMs). §11-2 */
  readonly statsIntervalMs?: number
  /** DC 만 끊겼을 때 같은 PeerLink 위 재개설 횟수·간격. 소진하면 그 서버를 재입장(연§7-5-7). 기본 3회·1,000ms (정책서 §4-1 dcReopen). */
  readonly dcReopen?: { readonly attempts: number; readonly intervalMs: number }
  /** 1pc 에서 PeerLink 단위로 굳는 opus fmtp 선호(2단계 협상 때 한 번). 2pc 는 쓰지 않는다. 기본 = ptt 프로필 값(정책서 §4-1 opusFmtpDefault). §6-3 */
  readonly opusFmtpDefault?: { readonly dtx?: boolean; readonly fec?: boolean; readonly stereo?: boolean; readonly maxAverageBitrate?: number }
}

export type ClientEvents = {
  session: (s: SessionInfo) => void
  /**
   * 새 토큰이 필요하다 — 2003 을 받았다(재접속 BIND 연§7-3-2-1, 또는 HTTP 401).
   * 앱이 setToken 을 부를 때까지 SDK 는 기다린다. resume_window_ms 를 넘기면 미디어를 닫고 closed{retryable:true}. §3-2
   * ★최초 connect() 의 2003 은 이 이벤트가 아니라 reject 다(연§7-2-3).
   * ★Close 4004(SESSION_REVOKED)가 그 자리에서 이것을 내지는 않는다 — SDK 가 세션을 버리고 session_id 없이
   * 다시 붙고(연§7-0-3 3), 자격이 정말로 사라졌으면 그 BIND 가 2003 을 주어 그때 난다.
   */
  tokenRequired: (e: { readonly cause: 'expired' }) => void
  /** 끝났다. retryable=false = 다시 붙어도 소용없는 사유(4000·4001·4002·4005). true = 백오프 소진 — connect() 를 다시 부르면 새 세션이다. ★rooms 는 비고 방은 앱이 다시 join 한다. */
  closed: (e: { readonly code: number; readonly name: string; readonly retryable: boolean }) => void
  /**
   * ★어느 방이든 장착 가능한 트랙 — RoomEvents.track 과 같은 순간·같은 핸들. join 전에 걸 수 있는 유일한 자리라
   * 초기 트랙(join resolve 다음 tick)을 놓치지 않는다. 다방 앱은 이것 하나로 붙인다. §6-2
   */
  track: (room: Room, t: RemoteTrack) => void
  trackUnreachable: (room: Room, t: RemoteTrackInfo) => void
  /** 지금 발언 방(pub_room)이 바뀌었다. null = 없다. §4 */
  speakingRoom: (room: Room | null) => void
  /** 브라우저 autoplay 정책 — false 면 사용자 제스처 핸들러 안에서 media.startAudio() 를 부른다 (§6-2·§12-1). */
  audioPlayback: (allowed: boolean) => void
}

export interface OxLensClient extends Emitter<ClientEvents> {
  readonly session: SessionInfo
  /** 살아 있는 방만. closed 는 빠진다. */
  readonly rooms: ReadonlyMap<string, Room>
  /** ★지금 발언 방(pub_room). Room.mode(입장 시점 select)와 다르다. */
  readonly speakingRoom: Room | null
  readonly media: Media
  readonly diagnostics: Diagnostics

  /** 소켓 열고 BIND 성공까지. 실패 = auth(2002·2003·2005) · bug(1004) · limit(4003 동시 세션) · closed(T-bind 만료·망). 최초 접속의 2003 은 reject. §3-1 */
  connect(): Promise<void>
  /** 새 토큰 주입 — tokenRequired 뒤에 부르면 재접속을 이어간다. */
  setToken(token: string): void
  /** 방 전부 나가고 소켓·미디어를 닫는다. 같은 객체로 connect() 를 다시 부를 수 있다. */
  close(): Promise<void>

  /**
   * 입장. 기본 mode='listen'(select:false — wire 기본과 반대, 지령대 모니터링이 기본 경로).
   * 'talk' 는 이 방을 발언 방으로(select:true). active 전에 부르면 기다린다(연§7-5-1 1).
   * 초기 트랙은 resolve 다음 tick 에 'track' 으로 온다 — 그 사이에 await 를 두면 방 리스너는 놓친다:
   * client.on('track') 을 join 전에 걸거나 room.tracks 를 훑는다(장착은 멱등). §4 · §6-2
   */
  join(roomId: string, opts?: JoinOptions): Promise<Room>
  /**
   * ★누르기 전에 발언 방을 고른다 — pub_select/pub_deselect 만 낸다(요청 없음). 다른 서버면 연§6-4 열차.
   * 선례: MCOP changeSelectedContact · Apple activeChannelUUID. press() 의 암묵 전환은 그대로다.
   * ★다른 방에서 has_permission 이면 §5-5 와 같이 먼저 그 방을 release() 하고 확인 뒤 옮긴다.
   */
  setSpeakingRoom(roomId: string | null): Promise<void>
  /** 입장 전 미리보기 — 정원을 먹지 않고 명단에 오르지 않는다 (연§5-5 ①). 401 은 auth reject + tokenRequired. */
  preview(roomId: string): Promise<RoomPreview>
  listRooms(): Promise<ReadonlyArray<RoomSummary>>
}

export interface JoinOptions {
  readonly mode?: 'listen' | 'talk'
  /** 앱이 붙이는 라벨. 권한이 아니다 (연§4-4). 기본 255 */
  readonly role?: number
  /** 플랫폼 시스템 UI 용 표시(iOS PushToTalk 의 PTChannelDescriptor). 웹은 무시. §12-2 */
  readonly descriptor?: { readonly name: string; readonly image?: Blob }
}

export interface RoomSummary {
  readonly roomId: string
  readonly name: string
  readonly capacity: number
  readonly userCount: number
  readonly createdAt: number
  /** 녹화 참가자 존재 (연§5-3) — ★투명이어도 참이다. 녹화 사실은 감추지 않는다. */
  readonly rec: boolean
}

export interface RoomVersion { readonly epoch: string; readonly seq: number }

export interface RoomPreview extends RoomSummary {
  readonly participants: ReadonlyArray<Participant>
  readonly version: RoomVersion
}

// ───────────────────────── 방 (§4) ─────────────────────────

export type RoomState = 'joining' | 'joined' | 'leaving' | 'closed'

export interface Participant {
  readonly userId: string
  /** 라벨 (연§4-4) */
  readonly role: number
  /** 토큰이 정한 종류 (연§4-4·§5-2) — wire u8 0·1·2 그대로. 클라 선언이 아니다. */
  readonly participantType: 'user' | 'recorder' | 'bot'
  /** 토큰이 서명한 신원(이름·프로필). 앱이 정한 불투명 JSON이고 ★갱신 통지가 없다(발급 시점 고정). */
  readonly metadata?: unknown
  /** 그 사람의 입장 시점 select (연§4-4) — Room.mode 와 같은 축·같은 값. ★발언 자격이 아니다(방에 있으면 누구나 말한다): listen 으로 들어와 말하는 사람도 'listen' 그대로. "지금 누가 말하나"는 ptt.speaker. */
  readonly mode: 'listen' | 'talk'
}

/** 서버가 이 방에서 나를 뺐다 (연§6-7). moderate 는 소속 부분 갱신이라 'affiliation' 으로, media_lost 는 rebuilding 으로 따로 온다. 'system' = 플랫폼 정책(iOS systemPolicy, §12-2). */
export type ForcedCause = 'kick' | 'room_closed' | 'moderate' | 'system'

export type RoomEvents = {
  participants: (list: ReadonlyArray<Participant>) => void
  participantJoined: (p: Participant) => void
  participantLeft: (p: { readonly userId: string }) => void
  /** ★장착 가능한 순간 — mediaStreamTrack 이 있다. 초기 트랙은 join() resolve 다음 tick(놓치지 않으려면 client.on('track') 또는 room.tracks). RESUME·재동기·mid 재발급 트랙은 그 처리 직후 (연§4-1). */
  track: (t: RemoteTrack) => void
  /** mid 고갈로 받을 수 없는 트랙 (연§4-1). 나중에 mid 가 재발급되면 'track' 으로 온다. */
  trackUnreachable: (t: RemoteTrackInfo) => void
  /** 서버가 이 방에서 나를 뺐다 → state='closed', client.rooms 에서 빠진다. 재입장은 앱이 정한다. */
  forced: (e: { readonly cause: ForcedCause }) => void
  /** 중재 — 응답의 affiliation 대로 소속을 부분 갱신한다(연§6-7 moderate). ★결말은 목록이 정한다: 이 방이 sub_rooms 에 있으면 이 이벤트(방 유지), 없으면 forced{cause:'moderate'} 로 닫힌다. 발언 방이 바뀌면 speakingRoom 이벤트가 같이 난다. */
  affiliation: (e: { readonly cause: 'moderate' }) => void
  /** 미디어 연결이 죽어 SDK 가 이 방을 다시 세우는 중 (연§7-5-7). 같은 핸들이다. */
  rebuilding: () => void
  rebuilt: () => void
  /** SDK 가 스스로 재동기(GET ?tracks=1)를 마쳤다 (연§5-5 ②③). 그동안 이 방 이벤트는 멈춰 있었다. */
  resync: () => void
  message: (m: { readonly userId: string; readonly content: string }) => void
  /** ★내 요청이 아닌 실패 — 재조립 협상·READY·재동기 HTTP. 로그만 남기지 않는다. §6-2 */
  error: (e: OxLensError) => void
}

export interface RoomAudio {
  readonly muted: boolean
  /** 0.0 ~ 1.0 */
  readonly volume: number
  setMuted(muted: boolean): void
  setVolume(volume: number): void
}

export interface Room extends Emitter<RoomEvents> {
  readonly id: string
  readonly state: RoomState
  /** 내 select — 입장 시점 값·고정 (연§4-4). ★발언 가능 여부가 아니다 — listen 방에서도 setSpeakingRoom/press() 로 말한다. 지금 발언 방은 client.speakingRoom. */
  readonly mode: 'listen' | 'talk'
  /** 이 방을 맡은 미디어 서버(server_config.sfu_id) — cross-sfu 에서 PeerLink 를 고르는 축. track.server 와 같은 값 공간. */
  readonly server: string
  readonly participants: ReadonlyArray<Participant>
  /** 장착 가능한 트랙 전량 (unreachable 은 없다). */
  readonly tracks: ReadonlyArray<RemoteTrack>
  /** ★이 방의 수신 오디오는 SDK 가 재생한다. 앱은 영상만 장착한다. §6-2 */
  readonly audio: RoomAudio
  readonly ptt: Ptt
  /** 그 방만 나간다. 발행 방이었으면 발언권·pub_room 도 SDK 가 정리한다. 진행 중 join 이면 응답 뒤 LEAVE 를 보낸다. */
  leave(): Promise<void>
  sendMessage(content: string): Promise<{ readonly msgId: string }>
}

// ───────────────────────── 발언 PTT (§5) ─────────────────────────

/** 연동규격서 §2-5 의 여섯. 'off' = 이 서버에 반이중 마이크가 아직 없다(enable 전). */
export type PttPhase =
  | 'off'
  | 'no_permission'
  | 'pending_request'
  | 'has_permission'
  | 'pending_release'
  | 'queued'

export type MicPower = 'hot' | 'hot_standby' | 'cold'

/** 'user' = 화면 버튼(기본) · 'accessory' = 블루투스/유선 PTT 버튼(§12 가 번역) · 'app' = 앱 로직 */
export type TransmitSource = 'user' | 'accessory' | 'app'

/** no_permission 으로 떨어진 이유 — 회수/거절 사유와 다른 축. §5-3 */
export type PttEndCause =
  | 'released'        // 내가 놓았다 (연§7-7-5)
  | 'revoked'         // REVOKE (lastRevoke 참조)
  | 'denied'          // DENY (lastDeny 참조)
  | 't1_reclaimed'    // RTP 를 안 보내 서버가 회수 — IDLE/남의 TAKEN 으로 안다 (연§7-7-7 3)
  | 't132_expired'    // 큐 승계 뒤 의지 표시 없음 (연§7-7-2-2)
  | 'no_response'     // 요청/반환 재전송 소진 (연§8-4 C101/C100)
  | 'moved'           // 다른 방에서 말하려고 SDK 가 놓았다 (§5-5)
  | 'left'            // 이 방을 나갔다 / 발언 방을 풀었다 (연§6-4)
  | 'rebuilt'         // 재구축 (연§7-3-4 1-1 · §7-5-7)

export interface PttState {
  readonly phase: PttPhase
  /** GRANTED 에 실려 온 값(초). 표의 기본값이 아니다 (연§8-5). */
  readonly remainingSec?: number
  /** 서버가 허가한 우선순위 */
  readonly priority?: number
  /** QUEUE_INFO 로 갱신. queued 진입 때 한 번 묻고, 30초(연§8-4 T-queuepos) 소식 없으면 다시 묻는다(§5-3). */
  readonly queue?: { readonly position: number; readonly size: number }
  /** ★큐 승계 GRANTED 뒤 T132 가 도는 중 — toggle 의 press() 가 수락이 되는 창. 그 전의 queued 에서 클릭은 철회다. */
  readonly acceptPending: boolean
  /** ★SDK 가 오디오를 흘리기 시작한 시각(ms epoch) — remainingSec 카운트다운의 시작점(연§8-4 T2 = 첫 RTP). has_permission 밖에서는 없다. */
  readonly talkingSince?: number
  /** 거절 사유 — 연§11-3 (1~7·100·255). 7(만석)과 4(잠깐 뒤)는 사용자가 할 일이 반대다. */
  readonly lastDeny?: { readonly cause: number; readonly text?: string }
  /** 회수 사유 — 연§11-3 (1~7·255). 2(상한)와 4(선점)는 처방이 반대다. */
  readonly lastRevoke?: { readonly cause: number; readonly text?: string }
  readonly lastEnd?: PttEndCause
  /** ★새 요청을 낼 수 있는가(joined ∧ trusted ∧ phase∈{off,no_permission} ∧ T9 아님 ∧ 재구축 아님). 버튼 활성 = canRequest ∨ has_permission(놓기) ∨ queued(철회/수락). 선례: MCOP requestAllowed */
  readonly canRequest: boolean
  /** 마지막 press 의 출처 (Apple didBeginTransmittingFrom 의 짝) */
  readonly source?: TransmitSource
  /** ★REVOKE 뒤 T3 3초 — 마이크는 껐는데 소리는 나간다 (연§7-7-6 4). */
  readonly draining: boolean
  /** ★false = DC 가 끊겨 이 표시를 믿을 수 없다 (연§7-7-8). 미디어 지표로는 안 잡힌다. */
  readonly trusted: boolean
  readonly mic: MicPower
}

export type PttEvents = {
  state: (s: PttState) => void
  granted: (s: PttState) => void
  denied: (s: PttState) => void
  revoked: (s: PttState) => void
  queued: (s: PttState) => void
  released: (s: PttState) => void
  /** 이 방의 화자 (연§11-7). null = 아무도 안 말한다. 슬롯 트랙이 아직 없으면 trackIds 는 빈 배열이고 트랙이 오면 다시 난다. */
  speaker: (e: { readonly userId: string | null; readonly trackIds: ReadonlyArray<string> }) => void
}

export interface Ptt extends Emitter<PttEvents> {
  readonly state: PttState
  /**
   * 큐 승계 GRANTED 의 "의지 표시" 해석 (연§7-7-2-1). 기본 'hold'.
   * hold: press 뒤 release 가 없으면 즉시 발언. toggle: queued 에서 T132 안(acceptPending)의 press() 가 수락(새 요청이 아니다), 없으면 SDK 가 RELEASE.
   * T132 중에 바꾸면 다음 허가부터.
   */
  input: 'hold' | 'toggle'
  /** 요청에 실을 희망 우선순위 0~255, 기본 0 (연§11-4). 권위는 토큰 — 허가값은 state.priority. */
  priority: number
  /**
   * 이 서버에 반이중 마이크가 없으면 등록한다(미리 데우기). 부르지 않아도 press() 가 한다. 던짐: device · limit(4002) · negotiation
   * track = 앱이 만든 MediaStreamTrack(처리기) — 반이중 외부 트랙은 여기로(기준 방 = 이 방). 옵션은 서버당 첫 enable 것이 이긴다.
   */
  enable(opts?: MicrophoneOptions & { readonly track?: MediaStreamTrack }): Promise<void>
  /**
   * 발언 의지. (등록 없으면 등록) → (발언 방이 아니면 전환) → REQUEST. resolve = 요청이 나갔다(허가는 'granted').
   * 상태별: pending_request = 무시 · queued(T132 전) = 무시 · queued(acceptPending) = 수락 · pending_release = 확인 뒤 새 요청 ·
   * has_permission = 새 REQUEST(서버 재허가로 remainingSec 갱신, 연§11-5). joining/rebuilding 이면 기다린다.
   * reject = device · limit(4002) · negotiation · state(3002·STATE_*) · bug(1006 슬롯 코덱 불일치) · closed.
   * toggle 앱은 state.phase·acceptPending 으로 press/release 를 갈라야 한다 — 로컬 플래그로 반전하면 큐 승계 뒤 대기를 철회한다.
   */
  press(opts?: { readonly source?: TransmitSource }): Promise<void>
  /**
   * 발언 끝 / 대기 철회 / ★허가 전에 뗌(pending_request → RELEASE → pending_release, 연§7-7-1-1). resolve = RELEASE 가 나갔다.
   * 서버 건너기 열차 중이면 열차를 멈춘다. 큐 철회는 확인 사건이 없어 표시는 즉시 no_permission·lastEnd 'released'(연§7-7-2-3).
   */
  release(): Promise<void>
  /** cold 진입을 미룬다(ms). 0 = 기본값(정책서). §5-4 */
  keepWarm(ms: number): void
  /**
   * ★반이중 영상 — 이 방의 슬롯 코덱·fmtp 에 맞춰 등록한다(연§6-3, 슬롯이 없으면 encoding.codec 선호 ∩ server_config.codecs, 없으면 서버 순서).
   * 송출은 has_permission 동안만(SDK 가 게이트). READY{camera} 는 트랙당 첫 프레임 1회. 1006 이면 details.codec·fmtp. track = 앱 처리기 트랙.
   */
  enableVideo(opts?: CameraOptions & { readonly track?: MediaStreamTrack }): Promise<LocalTrack>
}

// ───────────────────────── 미디어 (§6) ─────────────────────────

export type TrackKind = 'audio' | 'video'
/** SDK 표면의 출처 — wire 의 source 는 video 만 갖는다(연§6-3), 'microphone' 은 SDK 가 audio 에 붙이는 라벨. */
export type TrackSource = 'microphone' | 'camera' | 'screen'
export type Duplex = 'full' | 'half'
/** 연동규격서 §2-4 넷. 반이중 마이크는 등록된 채 'registered' 가 정상(발화 중에만 'sending'). */
/** 연§2-4 넷 앞에 acquired(트랙은 있고 발행 전 — acquire 의 자리). 전이는 한 칸씩, 실패는 그 단만 되돌린다(협상·등록 실패 → acquired, 트랜시버는 둔다). §6-1·§6-5 */
export type LocalTrackState = 'idle' | 'acquired' | 'staged' | 'registered' | 'sending'

// ── 미디어 품질 설정 (§6-3) — 값이 아니라 프로필. 선례: LiveKit AudioCaptureOptions·TrackPublishDefaults·AudioPresets ──

/** ★트랙의 duplex 가 고른다 — half = 'ptt'(AGC·NS·EC 켬, mono, speech, dtx·fec 켬, 낮은 playout delay) · full = 'conference'(music, dtx 끔). 트랙마다 덮어쓴다. EC 를 켜는 이유: 지령대는 다른 채널을 스피커로 들으며 말한다. */
export type AudioProfile = 'ptt' | 'conference'

/** getUserMedia 제약 — wire 무관. 수동 입력 게인은 없다(브라우저가 노출하지 않는다 — 처리기는 media.publish 로). */
export interface AudioCaptureOptions {
  readonly deviceId?: string
  readonly autoGainControl?: boolean
  readonly echoCancellation?: boolean
  readonly noiseSuppression?: boolean
  readonly voiceIsolation?: boolean
  readonly channelCount?: 1 | 2
  readonly sampleRate?: number
  readonly latency?: number
}

/** opus 인코딩 — 길은 둘: fmtp 받는 쪽 선호(usedtx·useinbandfec·maxaveragebitrate·stereo)는 SDK 가 조립하는 answer(연§9-4 예외, RFC 7587 §6.1) · maxBitrate 는 RTCRtpSender.setParameters. 브라우저 offer 는 안 만진다. 상한은 server_config.max_bitrate_bps. */
export interface AudioEncodingOptions {
  /** telephone 12k · speech 24k · music 48k */
  readonly preset?: 'telephone' | 'speech' | 'music'
  readonly maxBitrate?: number
  readonly dtx?: boolean
  readonly fec?: boolean
  readonly stereo?: boolean
}

export interface VideoLayerEncoding {
  readonly maxBitrate?: number
  readonly maxFramerate?: number
  readonly scaleResolutionDownBy?: number
}

/** 영상 인코딩 — codec 은 server_config.codecs 안의 선호 순서일 뿐, 협상 산물은 연§9-4 */
export interface VideoEncodingOptions {
  readonly codec?: ReadonlyArray<'VP8' | 'H264' | 'VP9' | 'AV1'>
  /** 시뮬캐스트 두 단(l, h) 순 */
  readonly layers?: readonly [VideoLayerEncoding, VideoLayerEncoding]
  readonly degradationPreference?: 'maintain-framerate' | 'maintain-resolution' | 'balanced'
  readonly contentHint?: 'motion' | 'detail' | 'text'
}

/** 수신측 — jitter buffer 목표. 무전은 낮게. */
export interface ReceiveOptions { readonly playoutDelayMs?: number }

/** timeoutMs — 이 호출의 getUserMedia 대기 상한. 없으면 ClientOptions.deviceAcquireTimeoutMs. */
export interface MicrophoneOptions { readonly deviceId?: string; readonly profile?: AudioProfile; readonly capture?: AudioCaptureOptions; readonly encoding?: AudioEncodingOptions; readonly timeoutMs?: number }
export interface CameraOptions {
  readonly deviceId?: string
  readonly simulcast?: boolean
  readonly width?: number
  readonly height?: number
  readonly frameRate?: number
  readonly encoding?: VideoEncodingOptions
  readonly timeoutMs?: number
}
export interface ScreenOptions { readonly audio?: boolean; readonly encoding?: VideoEncodingOptions; readonly timeoutMs?: number }

export type LocalTrackEvents = {
  state: (s: LocalTrackState) => void
  /** 'stopped' = 앱이 stop · 'server_lost' = RESUME.publish_failed(연§6-1) — 앱이 다시 enable 한다 · 'closed' = client.close · 'device_lost' = 장치가 뽑히거나 OS 가 빼앗음 */
  ended: (e: { readonly reason: 'stopped' | 'server_lost' | 'closed' | 'device_lost' }) => void
  /** 마이크가 죽었다 — 전이중은 발행 직후, 반이중은 has_permission 첫 1초가 완전 무음일 때. 1회. 선례: LiveKit LocalAudioSilenceDetected */
  silence: () => void
}

/** 소유권 (정의서 §6-1 소유권 이동 — 저수준 경로 + 발행으로 넘김).
 *  app = acquire 직후~publish resolve 전(앱 것 — SDK 는 cold·switchDevice·silence·재획득·close 시 정지를 하지 않는다) ·
 *  sdk = enable* 진입부터 / publish(LocalTrack) resolve 뒤 / replaceSource(null) 복귀 뒤(장치 수명 전부 SDK) ·
 *  external = publish(mediaStreamTrack) / replaceSource(track) 뒤(등록·전송만 — 장치 수명 관리 대상 아님). 선례: LiveKit isUserProvided */
export type TrackOwner = 'app' | 'sdk' | 'external'

export interface LocalTrack extends Emitter<LocalTrackEvents> {
  readonly id: string
  readonly owner: TrackOwner
  readonly kind: TrackKind
  readonly source: TrackSource
  readonly duplex: Duplex
  readonly state: LocalTrackState
  readonly muted: boolean
  /** 등록된 서버(sfu_id) — ★한 시점에 한 서버(연§6-4 서버 건너기 = remove + add). idle 이면 null. */
  readonly server: string | null
  /** 반이중 마이크가 cold 면 readyState 'ended' 인 옛 트랙이다 — 데울 때 replaceTrack 으로 바뀐다(§5-4). */
  readonly mediaStreamTrack: MediaStreamTrack
  /** 등록 해제 + 트랙 정지 → state 'idle'. 트랜시버는 남긴다 (연§7-4-6). owner 무관 — 부른 쪽이 끝낸다. */
  stop(): Promise<void>
  /**
   * 소스만 갈아끼운다(Encoder.source 갱신 — SSRC·등록·발언권 보존, 재협상 없음). 처리기 on/off 토글의 자리 (§6-1).
   * ★반이중 트랙은 게이트가 닫혀 있으면 보관만 하고, 허가로 게이트가 열리는 순간 sender 에 얹는다(§6-5 셋째 축) — 허가 없이 소리가 나가지 않는다.
   * track 을 넣으면 owner 'external', null 이면 SDK 가 살려 둔 자기 장치 트랙으로 복귀하며 owner 'sdk'.
   * 앱은 this.mediaStreamTrack 을 처리기 입력으로 읽는다. 선례: LiveKit replaceTrack(track, userProvidedTrack)
   */
  replaceSource(track: MediaStreamTrack | null): Promise<void>
  setMuted(muted: boolean): Promise<void>
  /** 3006 은 permanent — 시뮬캐스트를 끄기 전엔 같다 (연§6-3). half 의 기준 방은 speakingRoom(없으면 state · code 0 'STATE_NO_SPEAKING_ROOM' — wire 를 안 탔다). */
  setDuplex(duplex: Duplex): Promise<void>
  /** 인코딩 값만(maxBitrate·maxFramerate·레이어 active — setParameters). 레이어 구조(시뮬캐스트 개수)는 발행 시점에 정해져 못 바꾼다 — stop → 재발행. §6-3 */
  setEncoding(encoding: AudioEncodingOptions | VideoEncodingOptions): Promise<void>
  /** 이 트랙의 getStats — 양단 비교 재료 (§11-2) */
  getStats(): Promise<RTCStatsReport>
}

export interface LayerRequest {
  readonly spatial?: number
  readonly temporal?: number
  readonly paused?: boolean
  readonly priority?: number
}

/** 트랙 정체 — track / trackUnreachable 공통. */
export interface RemoteTrackInfo {
  readonly id: string
  readonly roomId: string
  readonly kind: TrackKind
  /** 무전 슬롯은 없다 — 화자는 ptt 'speaker' 가 준다 (연§11-7). */
  readonly userId?: string
  /** = userId 부재 (track_id 를 파싱하지 않는다, 연§11-7 5) */
  readonly slot: boolean
  /** "L{n}T{m}" — 시뮬캐스트일 때만 */
  readonly scalability?: string
}

export type RemoteTrackEvents = {
  ended: () => void
  /** 잔존(false)·복귀(true) — 같은 mid 의 항목 교체는 같은 핸들이다 (연§4-1). */
  active: (active: boolean) => void
  muted: (muted: boolean) => void
  live: () => void
}

export interface RemoteTrack extends RemoteTrackInfo, Emitter<RemoteTrackEvents> {
  readonly active: boolean
  /** 'track' 이벤트 시점부터 있다 — null 이 아니다. */
  readonly mediaStreamTrack: MediaStreamTrack
  /** 값은 상한 (연§6-3). 범위는 scalability. */
  setLayer(req: LayerRequest): Promise<void>
  /** 수신 품질 (§6-3) */
  setReceive(opts: ReceiveOptions): Promise<void>
  /**
   * 영상 장착 헬퍼. 붙이면 adaptiveStream(기본 on)이 엘리먼트 크기·가시성으로 setLayer 를 대신 한다 —
   * 안 보는 채널은 정지·priority 1, 보는 채널은 priority 200, 작은 타일은 낮은 단. 앱이 srcObject 를 직접 쓰면 자동은 없다.
   * ★video 만 — audio 트랙에 부르면 bug(SDK 가 재생한다). 선례: LiveKit Track.attach
   */
  attach(element: HTMLMediaElement): HTMLMediaElement
  detach(element?: HTMLMediaElement): void
  /** audio 트랙의 볼륨 0.0~1.0 (전이중 개인 오디오용 — 슬롯은 room.audio). video 면 무시 */
  volume: number
  getStats(): Promise<RTCStatsReport>
}

export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput'
/** 표준 MediaDeviceInfo 그대로. groupId = 헤드셋의 마이크·스피커를 한 짝으로 묶는 축 — 앱은 입력·출력을 groupId 로 함께 고른다. 권한 전엔 label '' (§6-4) */
export interface DeviceInfo { readonly deviceId: string; readonly kind: DeviceKind; readonly label: string; readonly groupId: string }
/** 핫플러그 — SDK 가 스스로 한 일(선택 정책)의 결과를 알린다. 앱이 해야 할 일이 아니다. */
export type DevicesEvents = {
  change: (e: { readonly added: ReadonlyArray<DeviceInfo>; readonly removed: ReadonlyArray<DeviceInfo>; readonly list: ReadonlyArray<DeviceInfo> }) => void
}
export interface Devices extends Emitter<DevicesEvents> {
  /** requestPermissions=true 면 라벨을 얻기 위해 권한을 요청한다. 'default' 는 groupId 로 실제 장치에 정규화. 선례: LiveKit DeviceManager.getDevices */
  list(opts?: { readonly kind?: DeviceKind; readonly requestPermissions?: boolean }): Promise<ReadonlyArray<DeviceInfo>>
  /**
   * 선택 정책 (§6-4): kind 마다 없으면 자동(OS 기본 추종 — 헤드셋을 꽂으면 owner 'sdk' 트랙이 그리로 간다),
   * 있으면 명시 고정(새 장치를 따라가지 않는다 · 뽑히면 자동으로 임시 복귀, 다시 꽂히면 명시로). switchDevice(kind, id|null) 가 쓴다.
   */
  readonly preferred: Readonly<Partial<Record<DeviceKind, string>>>
}

/** 수신 오디오 재생 — SDK 가 재생한다(§6-2). autoplay 정책의 표면. */
export interface AudioPlayback {
  /** false = 사용자 제스처 전. 'audioPlayback' 이벤트로 바뀜을 안다 */
  readonly playbackAllowed: boolean
  /** 사용자 제스처(클릭/탭) 핸들러 안에서 부른다. 선례: LiveKit Room.startAudio */
  startAudio(): Promise<void>
}

export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unknown'

/** acquire 의 키 — kind 마다 따로 getUserMedia. true = 기본 옵션. */
export interface AcquireOptions {
  readonly microphone?: MicrophoneOptions | true
  readonly camera?: CameraOptions | true
  readonly screen?: ScreenOptions | true
}

export interface Media {
  /** 전량 — acquire 만 한 앱 소유 트랙(state idle)도 보인다. ptt.enable/enableVideo 가 만든 반이중 트랙도(duplex 'half'). */
  readonly tracks: ReadonlyArray<LocalTrack>
  /**
   * ★저수준 경로 1/2 — 획득만. 접속·방·발언 방 없이 된다(로비: 장치 고르기·레벨 미터·권한 프롬프트 시점).
   * 결과는 state 'idle'·server null·owner 'app'. 전부 아니면 전무 — 하나 실패하면 획득한 것 stop 후 device reject(details.kind). §6-1
   * 선례: LiveKit createLocalTracks
   */
  acquire(opts: AcquireOptions): Promise<ReadonlyArray<LocalTrack>>
  /**
   * ★저수준 경로 2/2 — 획득한 트랙을 발행으로 넘긴다(트랜시버→협상→등록→송신). resolve 때 owner 'sdk'.
   * reject 면 트랙은 앱 것 그대로(정지 안 함). 발언 방 규칙·실패 집합은 enable* 와 같다. §6-1 선례: LiveKit publishTrack
   */
  publish(track: LocalTrack): Promise<LocalTrack>
  readonly devices: Devices
  /**
   * 전이중 발행(연§7-4 한 덩어리). ★발언 방(speakingRoom)이 없으면 state · code 0 'STATE_NO_SPEAKING_ROOM' —
   * room.ptt.press() 는 방이 정해져 있어 pub_select 를 대행하지만 media.enable* 는 client 단위라 SDK 가 방을 고르지 않는다.
   * setSpeakingRoom(roomId) 뒤에 부른다(listen 으로 들어온 방도 된다 — 자격 축 없음). 실패 device·negotiation·state·limit(4002). §6-1
   */
  /** = acquire + publish 한 덩어리(설탕). 실패하면 자기가 만든 트랙을 SDK 가 stop. */
  enableMicrophone(opts?: MicrophoneOptions): Promise<LocalTrack>
  enableCamera(opts?: CameraOptions): Promise<LocalTrack>
  enableScreen(opts?: ScreenOptions): Promise<LocalTrack>
  /** ★예외 경로 — SDK 가 소스를 못 잡는 것(캔버스·파일·외부 캡처)을 전이중으로 발행. owner 'external'(장치 수명 관리 대상 아님). 처리기 on/off 는 이 길이 아니라 track.replaceSource. 반이중 외부 트랙은 room.ptt.enable({track})·enableVideo({track}). */
  publish(track: MediaStreamTrack, opts: { readonly source: TrackSource; readonly encoding?: AudioEncodingOptions | VideoEncodingOptions }): Promise<LocalTrack>
  /** 기본 장치를 바꾸고 산 트랙에도 즉시 적용 — replaceTrack 이라 SSRC 보존·재등록 없음. 선례: LiveKit switchActiveDevice */
  /** 대상은 owner 'sdk' 트랙만 — 앱·외부 소유는 건너뛴다 (§6-1). deviceId 는 명시 선택(devices.preferred), null = 자동으로 복귀. cold 중이면 저장 제약만 바꾼다(§6-4). */
  switchDevice(kind: DeviceKind, deviceId: string | null): Promise<void>
  readonly audio: AudioPlayback
  /** SDK 가 재생하는 모든 방 오디오의 출력 장치. setSinkId 가 있는 플랫폼만 (§12-1) */
  audioOutput(deviceId: string | null): Promise<void>
  permissions(): Promise<{ readonly microphone: PermissionState; readonly camera: PermissionState }>
}

// ───────────────────────── 진단 (§11) ─────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'
export interface LogRecord {
  readonly ts: number
  readonly level: LogLevel
  /** 모듈 이름 (§8-2) */
  readonly module: string
  readonly msg: string
  readonly ctx?: Readonly<Record<string, unknown>>
}

/** 연동규격서 §6-6 result — 못 모은 칸은 없다 (null 로 채우지 않는다). 형은 연§6-6 표가 정본. */
export interface ProbeResult {
  readonly error?: string
  readonly pub_tracks?: ReadonlyArray<Record<string, unknown>>
  readonly sub_tracks?: ReadonlyArray<Record<string, unknown>>
  readonly env?: Record<string, unknown>
  readonly devices?: ReadonlyArray<Record<string, unknown>>
  readonly permissions?: Record<string, unknown>
  readonly state: Record<string, unknown>
  readonly network?: Record<string, unknown>
}

export type DiagnosticsEvents = {
  log: (r: LogRecord) => void
  probe: (r: ProbeResult) => void
  stats: (r: ProbeResult) => void
}

export interface Diagnostics extends Emitter<DiagnosticsEvents> {
  probe(): Promise<ProbeResult>
  setLogLevel(level: LogLevel | 'silent'): void
}
