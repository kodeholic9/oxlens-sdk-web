// author: kodeholic (powered by Claude)
// ★생성 파일 — context/spec/policy/keys.ts SDK_DEFAULTS 가 정본(gen/policy.mts). 값이 연 원장 · SDK 정의서에 있는 것(canon)은 여기 없다. 앱이 안 준 칸(undefined · null)은 이 값으로 채운다.
export const DEFAULTS = {
  micColdAfterMs: 30000,   // 무발화 뒤 `cold` 진입
  deviceAcquireTimeoutMs: 30000,   // `getUserMedia` 대기 상한(프롬프트 방치 포함)
  opusFmtpDefault: {"usedtx":1,"useinbandfec":1,"stereo":0},   // `1pc` 에서 `PeerLink` 단위로 굳는 opus `fmtp` 선호
  simulcastLayers: [{"rid":"l","scaleResolutionDownBy":2,"maxBitrate":250000,"maxFramerate":15},{"rid":"h","scaleResolutionDownBy":1,"maxBitrate":1650000,"maxFramerate":30}],   // 카메라 시뮬캐스트 두 단 — `sendEncodings`(낮은 품질부터 `l` → `h`)
  cameraCapture: {"width":1280,"height":720,"frameRate":30},   // 카메라 획득 제약 기본
  screenShare: {"simulcast":false,"contentHint":"detail","degradationPreference":"maintain-resolution","maxBitrate":1500000,"maxFramerate":15},   // 화면공유 발행 기본
  playoutDelayMs: null,   // 수신 지터 버퍼 목표
  silenceWindowMs: 1000,   // `silence` 판정 창
  adaptiveStreamSettleMs: 500,   // `adaptiveStream` 바뀜 묶음
  dcReopen: {"tries":3,"intervalMs":1000},   // DC 만 끊겼을 때 같은 `PeerLink` 위 재개설
  wobblyGraceMs: 2000,   // ICE `disconnected` 뒤 재시작 전 기다림
  iceRestartTimeoutMs: 5000,   // 재시작 적용 뒤 `connected` 대기
  wsProbeTimeoutMs: 2000,   // WS 점검 시한
  massJitterMs: 5000,   // 재구축 칸 첫 `ROOM_JOIN` 분산 창
  unreachableAfter: 3,   // 경로 불가 표시 문턱(회)
  wakeDetectMs: 2000,   // 깨어남 판정 문턱
  statsIntervalMs: 5000,   // `diagnostics.stats` 주기
  quality: {"excellent":{"lossPct":2,"rttMs":150},"good":{"lossPct":5,"rttMs":400}},   // 4단 문턱
} as const
