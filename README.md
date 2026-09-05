# oxlens-sdk-web — OxLens 웹 클라이언트 SDK

표면이 계약이다. 정본은 `context/spec/oxlens_sdk_spec.md`(SDK§) 이고 그 위의 진실은
`oxlens_client_protocol.md`(연§) 다. 이 저장소는 규격을 옮길 뿐 규격을 정하지 않는다.

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

## 구조 (SDK§8-1)

```
src/api/        공개 표면 — 핸들·이벤트·오류형
src/domain/     session · rooms · store · floor · media-registry
src/internal/   signaling · transport · sdp · mbcp · probe
src/platform/   clock · socket · 장치·능력
```

의존은 위에서 아래 한 방향뿐이고, 모듈 사이는 직접 호출·직접 소유로 잇는다.
`npm run arch` 가 그것을 강제한다 — 위반은 게이트 실패다.

## 형제 저장소

- `oxlens/oxlens-spec/vectors/` — wire 벡터 정본. 1층이 이 파일로 codec 을 판정한다
  (`OXLENS_SPEC_VECTORS` 로 자리를 옮길 수 있다)
- `oxlens/oxlens-sfu` — 서버
