# oxlens-sdk-web — OxLens 웹 클라이언트 SDK

브라우저에서 [OxLens SFU](https://github.com/kodeholic9/oxlens-sfu) 에 붙는 TypeScript SDK 다. 무전(PTT — 발언권 · 다방 청취)과 화상회의(전이중 · 시뮬캐스트)를 한 클라이언트로 쓴다.
*Browser SDK for the OxLens SFU — push-to-talk and video conferencing. The documents are in Korean.*

- 서버와의 계약: [클라 통신 규격](https://github.com/kodeholic9/oxlens-sfu/blob/main/docs/protocol/README.md)
- 서버와 SDK 가 실제로 주고받는 흐름(실측): [학습 문서](https://github.com/kodeholic9/oxlens-sfu/blob/main/docs/learn/00_INDEX.md)
- 기여 · 시험 · 구조: [CONTRIBUTING.md](CONTRIBUTING.md)

## 빠른 시작

**1. 서버를 띄운다** — [oxlens-sfu 빠른 시작](https://github.com/kodeholic9/oxlens-sfu#quick-start). 기본 접속점은 `http://127.0.0.1:1974/media` 다.

**2. SDK 를 짓는다** — 아직 npm 에 올리지 않았다. 저장소를 받아 짓고 `dist/`(ES 모듈)를 쓴다.

```bash
git clone https://github.com/kodeholic9/oxlens-sdk-web
```

```bash
cd oxlens-sdk-web && npm install && npm run build
```

**3. 토큰과 방은 앱 백엔드가 만든다** — 토큰은 hub 의 `POST {base}/auth/token` 이 API 키로 발급한다. ★API 비밀은 브라우저에 두지 않는다. 아래는 개발용 데모 계정(서버 `system.toml` 의 `ox_k_demo` / `ox_s_demo`)으로 백엔드에서 부르는 예다.

```ts
// 백엔드(Node 18+)
const BASE = 'http://127.0.0.1:1974/media'
export async function tokenFor(userId: string): Promise<string> {
  const r = await fetch(`${BASE}/auth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'ox_k_demo', api_secret: 'ox_s_demo', user_id: userId }),
  })
  return (await r.json()).token
}
export async function createRoom(roomId: string, token: string): Promise<void> {
  const r = await fetch(`${BASE}/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ room_id: roomId, name: roomId }),
  })
  if (!r.ok && r.status !== 409) throw new Error(`room ${r.status}`)   // 409 = 이미 있다
}
```

**4. 붙는다** — 회의 방에 들어가 마이크 · 카메라를 켜고, 남의 영상을 화면에 붙인다.

```ts
import { createClient, OxLensError } from './oxlens-sdk-web/dist/index.js'

const client = createClient({ base: 'http://127.0.0.1:1974/media', token: await myBackend.token() })

// 받는 트랙은 join 전에 client 에 건다 — 입장 직후 오는 트랙을 놓치지 않는다
client.on('track', (room, t) => {
  if (t.kind !== 'video') return                     // 오디오는 SDK 가 재생한다
  const v = document.createElement('video')
  v.autoplay = true; v.playsInline = true
  t.attach(v)                                        // 보이는지 · 크기를 SDK 가 재서 받을 층을 고른다
  document.body.append(v)
  t.on('ended', () => v.remove())
})
client.on('audioPlayback', (ok) => { if (!ok) showTapToEnableAudio() })   // 브라우저 자동재생 정책
client.on('tokenRequired', async () => client.setToken(await myBackend.token()))

await client.connect()
const room = await client.join('my-room', { mode: 'talk' })   // 기본은 'listen'(듣기만)
await client.media.enableMicrophone()
await client.media.enableCamera()

room.on('participants', (list) => renderRoster(list))
window.addEventListener('pagehide', () => { void client.close() })
```

무전(PTT)은 방 핸들의 `ptt` 로 한다.

```ts
const ch = await client.join('ch-1', { mode: 'talk' })   // 말하기 모드로 들어간 방이 발언 방 — 듣기만 하는 방은 'listen' 으로 여럿
await ch.ptt.enable()                                     // 마이크를 미리 데운다(무전 프로필)
ch.ptt.on('state', (s) => renderPtt(s))
ch.ptt.on('speaker', (e) => showSpeaker(e.userId))
button.onpointerdown = () => { void ch.ptt.press() }
button.onpointerup = () => { void ch.ptt.release() }
// 말할 방을 바꿀 때: await client.setSpeakingRoom(otherRoom.id)
```

더 긴 예: [`examples/dispatch-console.ts`](examples/dispatch-console.ts)(지령대 — 채널 열 개 청취 + 한 채널 PTT) · [`examples/ptt-handset.ts`](examples/ptt-handset.ts)(PTT 단말 — 토글 · 무전 영상).

## 표면 한눈에

| 핸들 | 무엇 | 주요 멤버 |
|---|---|---|
| `createClient(opts)` → `OxLensClient` | 세션 하나 — 만드는 길은 이것 하나 | `connect()` · `close()` · `join(roomId, {mode})` · `setSpeakingRoom(id)` · `setToken(t)` · `listRooms()` · `preview(roomId)` · 이벤트 `session` · `track` · `link` · `closed` · `tokenRequired` · `audioPlayback` · `speakingRoom` |
| `client.media` | 내 장치와 발행 | `enableMicrophone()` · `enableCamera()` · `enableScreen()` · `acquire()` · `publish()` · `switchDevice()` · `startAudio()` · `devices` |
| `Room` | 들어간 방 하나 | `leave()` · `participants` · `tracks` · `sendMessage()` · `audio`(음량 · 음소거) · `ptt` · 이벤트 `track` · `trackUnreachable` · `participants` · `message` · `forced` · `state` |
| `Ptt` | 그 방의 발언권 | `press()` · `release()` · `input`(hold · toggle) · `priority` · `enable()` · `enableVideo()` · 이벤트 `state` · `speaker` · `granted` · `denied` · `revoked` |
| `LocalTrack` | 내가 보내는 트랙 | `trackId` · `state` · `muted` · `duplex` · `mediaStreamTrack` |
| `RemoteTrack` | 받는 트랙 | `attach(el)` · `detach()` · `setLayer()` · `volume` · `userId` · `type`(individual · slot) · 이벤트 `ended` · `active` |
| `OxLensError` | 모든 실패 | `code` · `name` · `category` · `retryable` |
| `client.diagnostics` | 진단 | `logs()` · `setLogLevel()` · `probe()` · 이벤트 `transition` |

`ClientOptions` 의 손잡이(연결 방식 `pcMode` · `adaptiveStream` · 복구 시계 등)는 [`src/domain/defaults.ts`](src/domain/defaults.ts) 에 있다.

## 지원 · 한계

- 브라우저: 시험은 Chromium 으로 돈다(Playwright). Firefox · Safari 는 아직 정규 시험 밖이다.
- 영상 무전(비디오 발언권)은 보류 중이다 — 브라우저의 송신 pacer 를 앱에서 다룰 수 없다.
- 판 번호: 서버 · SDK 가 같은 이름(`v1.N`)으로 함께 태그된다. 같은 태그끼리 맞춰 쓴다.
