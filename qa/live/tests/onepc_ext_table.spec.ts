// author: kodeholic (powered by Claude)
// ★연§9-10-1 — `READY{transport}` 로 신고하는 것은 **받기 절이 쓰는 표**다(`sdes:mid` 제외).
// 시험 항목서 `C-cond-idx-13`.
//
// mid 가 신고표에 섞이면 서버가 egress 에 ★발행자의 mid 값을 구독자가 읽는 번호로 옮겨 적는다.
// 받는 쪽은 그 이름을 자기 보내기 m-line 으로 읽고, 그 SSRC 의 주인을 그리로 옮긴다 — 신고한
// SSRC 의 결속이 남의 것이 되어, 그 m-line 을 다시 등록할 때 거부된다.
//
// ★브라우저에게 로컬 offer 를 시키는 것은 **탐침**이다 — 그것이 받기 절의 demuxer 기준을 다시
// 등록시켜, 결속이 성한지를 밖에서 볼 수 있는 유일한 자리다. 규격이 허용하는 경로가 아니다
// (협상은 언제나 서버 offer — 연§9-10 규칙 1).
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'
import { TrackStat } from '../fixtures/delta.js'

const S = new Scope('onepcext')
const ROOM = S.room()
const peerAudio = (t: TrackStat): boolean => t.kind === 'audio' && !t.id.startsWith('ptt-')

interface Probe { refused: boolean; message: string; mids: string[] }

test.afterEach(async () => { await S.teardown() })

test('ONEPC-03 받기 오디오가 둘이어도 demuxer 결속이 성하다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('EA'), pcMode: '1pc' })
  await a.call('join', ROOM, 'talk')

  // 받기 오디오가 무전 슬롯 하나뿐일 때는 이 결함이 숨는다 — 대조군이 그것을 보인다.
  const one = await a.call<Probe>('forceBrowserOffer')
  expect(one.refused, '받기가 하나면 언제나 성했다 — 여기서는 아무것도 안 갈린다').toBe(false)

  // 남이 들어와 개인 오디오가 붙는다. 받기 오디오가 둘이 되는 순간이 갈림이다.
  const b = await S.open(ctx, { userId: S.user('EB'), pcMode: '1pc' })
  await b.call('join', ROOM, 'talk')
  await b.call('enableMic')
  await expect.poll(() => a.call<TrackStat[]>('trackStats').then((s) => s.filter(peerAudio).length), {
    message: '상대 오디오가 붙는다',
  }).toBe(1)
  await expect.poll(() => a.call<TrackStat[]>('trackStats').then((s) => s.find(peerAudio)?.packets ?? 0), {
    message: '붙은 것과 흐르는 것은 다르다 — 결속은 패킷이 와야 옮겨진다',
  }).toBeGreaterThan(0)

  const two = await a.call<Probe>('forceBrowserOffer')
  expect(two.refused, `받기가 둘이어도 성하다 — 어긋나면 ${two.message}`).toBe(false)
  expect(two.mids, '받기 절이 둘인 상태였다').toContain('33:recvonly')
})
