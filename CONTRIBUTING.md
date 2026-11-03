# 기여 안내 — 층 · 게이트 · 구조

표면이 계약이다. SDK 의 정본은 SDK 정의서(규격 저장소 · 비공개)이고, 그 위의 진실은
[클라 통신 규격](https://github.com/kodeholic9/oxlens-sfu/blob/main/docs/protocol/README.md)(공개)이다.
이 저장소는 규격을 옮길 뿐 규격을 정하지 않는다. 소스 머리의 `연:` · `SDK:` 라벨이 그 규격의 문장을 가리킨다.

## 층

| 층 | 무엇을 재나 | 명령 |
|---|---|---|
| 1층 | 순수 함수·상태기·wire codec. 시계와 소켓은 대역으로 갈아 끼운다 | `npm test` |
| 3층 | 실 인코더·실 디코딩. 브라우저가 판정한다 | `npm run gate:live` |

2층(와이어 적합성)은 `oxlens/oxlens-labs/oxe2epy` 가 파이썬 봇으로 본다 — 이 저장소가 아니다.

## 게이트

```
npm run gate        # typecheck · arch · build · 1층        (서버 불필요)
npm run gate:live   # 위 + 3층 정규 + 3층 갈래B            (미디어 서버 필요)
```

3층 전에 빌드가 강제된다 — SDK 를 고치고 빌드를 잊으면 옛 코드를 시험하고 초록을 받는다.
갈래B(`qa/live/tests/fault/`)는 정규 게이트와 섞지 않는다. 섞으면 "의도된 빨강"과 "회귀 빨강"이
같은 색이 되어 게이트가 무의미해진다.

`SKIP` 은 통과가 아니다. 미실행에는 항상 사유가 붙는다.

## 구조

```
src/api/        공개 표면 — 핸들 · 이벤트 · 오류형
src/domain/     영역 — ses(세션) · room · aff(소속) · link(미디어 서버 연결) · pub · trk · flr(발언권) · diag · gen(규격에서 생성한 상태기)
src/internal/   wire · ses(신호) · link(전송 · SDP) · flr(MBCP) · probe
src/platform/   clock · net · emitter · webrtc · 장치 · 능력
```

의존은 위에서 아래 한 방향뿐이고, 모듈 사이는 직접 호출·직접 소유로 잇는다.
`npm run arch` 가 그것을 강제한다 — 위반은 게이트 실패다.

## 형제 저장소

- `oxlens/oxlens-spec/vectors/` — wire 벡터(비공개). 1층이 이 파일로 codec 을 판정한다
  (`OXLENS_SPEC_VECTORS` 로 위치를 옮길 수 있다)
- [oxlens-sfu](https://github.com/kodeholic9/oxlens-sfu) — 서버 · 공개 문서(`docs/`)

## 학습 문서 탐침

`qa/live/tests/probe/tour_capture.spec.ts` — 서버의 [학습 문서](https://github.com/kodeholic9/oxlens-sfu/blob/main/docs/learn/00_INDEX.md) 재료(WS 프레임 · SDP · SDK 전이 · 서버 로그)를 한 번에 거둔다. 판정하지 않고 게이트 밖(`chromium-probe`)이다.

```
cd qa/live && npx playwright test --project=chromium-probe tests/probe/tour_capture.spec.ts
```
