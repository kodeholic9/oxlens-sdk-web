// author: kodeholic (powered by Claude)
// 연§4-6 세 규칙과 연§4-1 보관본 규율. 네 경로가 이 함수 하나를 지나는지도 여기서 본다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TrackEntry, TrackStore, Version } from '../src/domain/store.js'

const V = (seq: number, epoch = 'sfu-1'): Version => ({ epoch, seq })

function track(mid: string, over: Partial<TrackEntry> = {}): TrackEntry {
  return {
    room_id: 'r1', kind: 'audio', ssrc: 1000 + Number(mid), track_id: `t${mid}`, mid, pt: 111, ...over,
  }
}

function seeded(): TrackStore {
  const s = new TrackStore()
  s.apply('join', 'r1', V(10), { kind: 'snapshot', tracks: [track('0'), track('1')] })
  return s
}

test('낡은 응답이 최신 통지를 되감지 못한다', () => {
  const s = seeded()
  const r = s.apply('http', 'r1', V(9), { kind: 'snapshot', tracks: [] })
  assert.deepEqual(r, { accepted: false, why: 'stale' })
  assert.equal(s.tracks('r1').length, 2, 'seq 를 안 견주면 여기서 비어 버린다')
})

test('같은 seq 도 버린다 — 오르지 않았으면 새 사실이 아니다', () => {
  assert.deepEqual(seeded().apply('event', 'r1', V(10), { kind: 'add', tracks: [track('2')] }),
    { accepted: false, why: 'stale' })
})

test('epoch 가 갈리면 통째로 버리고 재구축한다', () => {
  const s = seeded()
  const r = s.apply('join', 'r1', V(1, 'sfu-2'), { kind: 'snapshot', tracks: [track('0')] })
  assert.equal(r.accepted, true)
  assert.equal(r.reset, true, 'epoch 를 안 보면 재기동 뒤 통지를 영원히 버린다')
  assert.deepEqual(s.tracks('r1').map((t) => t.mid), ['0'])
  assert.equal(s.seats().length, 1, '재기동은 자리까지 버린다')
})

test('epoch 가 갈리면 seq 가 작아도 받는다 — 그것이 재기동이다', () => {
  const s = seeded()
  assert.equal(s.apply('join', 'r1', V(1, 'sfu-2'), { kind: 'snapshot', tracks: [] }).accepted, true)
})

test('seq 갭은 놓친 것이다 — 받지 않고 재동기로 넘긴다', () => {
  const s = seeded()
  assert.deepEqual(s.apply('event', 'r1', V(12), { kind: 'add', tracks: [track('2')] }),
    { accepted: false, why: 'gap' })
  assert.equal(s.isDesynced('r1'), true)
  assert.equal(s.tracks('r1').length, 2, '갭을 받으면 보관본이 조용히 어긋난다')
})

test('갭 뒤의 통지는 이어서 막힌다 — 통짜가 와야 풀린다', () => {
  const s = seeded()
  s.apply('event', 'r1', V(12), { kind: 'add', tracks: [track('2')] })
  assert.deepEqual(s.apply('event', 'r1', V(13), { kind: 'add', tracks: [track('3')] }),
    { accepted: false, why: 'desync' })

  const fix = s.apply('http', 'r1', V(13), { kind: 'snapshot', tracks: [track('0'), track('2')] })
  assert.equal(fix.accepted, true)
  assert.equal(s.isDesynced('r1'), false)
  assert.deepEqual(s.tracks('r1').map((t) => t.mid), ['0', '2'])
})

test('같은 mid 가 다시 오면 통째로 바뀐다 — 병합이 아니다', () => {
  const s = seeded()
  s.apply('event', 'r1', V(11), {
    kind: 'add', tracks: [track('1', { kind: 'video', codec: 'VP8', pt: 96, ssrc: 77 })],
  })
  const got = s.tracks('r1').find((t) => t.mid === '1')!
  assert.equal(got.kind, 'video')
  assert.equal(got.ssrc, 77)
  assert.equal(got.codec, 'VP8')
})

test('remove 는 항목을 지우되 그 mid 자리는 남는다', () => {
  const s = new TrackStore()
  s.apply('join', 'r1', V(1), {
    kind: 'snapshot', tracks: [track('0'), track('1', { kind: 'video', codec: 'H264', pt: 102, fmtp: 'packetization-mode=1' })],
  })
  s.apply('event', 'r1', V(2), { kind: 'remove', tracks: [track('1')] })

  assert.deepEqual(s.tracks('r1').map((t) => t.mid), ['0'])
  const seats = s.seats()
  assert.deepEqual(seats.map((x) => x.mid), ['0', '1'], '자리를 안 남기면 m-line 이 줄어 협상이 깨진다')
  const seat = seats[1] as { pt?: number; codec?: string; fmtp?: string }
  assert.equal(seat.pt, 102, '지우기 직전 pt 가 자리 지킴 m-line 의 재료다')
  assert.equal(seat.codec, 'H264')
  assert.equal(seat.fmtp, 'packetization-mode=1')
})

test('같은 kind 의 새 트랙이 그 mid 로 오면 자리가 되살아난다', () => {
  const s = new TrackStore()
  s.apply('join', 'r1', V(1), { kind: 'snapshot', tracks: [track('0')] })
  s.apply('event', 'r1', V(2), { kind: 'remove', tracks: [track('0')] })
  s.apply('event', 'r1', V(3), { kind: 'add', tracks: [track('0', { track_id: 'other' })] })

  assert.equal(s.seats().length, 1)
  assert.equal(s.tracks('r1')[0]!.track_id, 'other')
})

test('조립 순서는 mid 수치다 — 문자열이면 10 이 2 보다 앞선다', () => {
  const s = new TrackStore()
  s.apply('join', 'r1', V(1), { kind: 'snapshot', tracks: [track('10'), track('2'), track('0')] })
  assert.deepEqual(s.tracks('r1').map((t) => t.mid), ['0', '2', '10'])
})

test('mid 없는 트랙은 조립에 안 넣고 받을 수 없다고 알린다', () => {
  const s = new TrackStore()
  const r = s.apply('event', 'r1', V(1), {
    kind: 'add', tracks: [{ room_id: 'r1', kind: 'audio', ssrc: 5, track_id: 'x' }],
  })
  assert.equal(r.accepted, true)
  assert.equal(r.unreachable.length, 1, '조용히 없는 것처럼 두지 않는다')
  assert.equal(s.tracks('r1').length, 0)
})

test('active:false 는 지우라는 뜻이 아니다 — 자리도 항목도 남는다', () => {
  const s = seeded()
  s.apply('event', 'r1', V(11), { kind: 'add', tracks: [track('1', { active: false })] })
  const got = s.tracks('r1').find((t) => t.mid === '1')!
  assert.equal(got.active, false)
  assert.equal(s.tracks('r1').length, 2)
})

test('보관본은 방을 room_id 로만 가른다', () => {
  const s = new TrackStore()
  s.apply('join', 'r1', V(1), { kind: 'snapshot', tracks: [track('0')] })
  s.apply('join', 'r2', V(1), { kind: 'snapshot', tracks: [track('1', { room_id: 'r2' })] })

  assert.deepEqual(s.tracks('r1').map((t) => t.mid), ['0'])
  assert.deepEqual(s.tracks('r2').map((t) => t.mid), ['1'])
  assert.equal(s.seats().length, 2, '한 연결의 m-line 은 방을 가리지 않고 한 줄이다')
})

test('방을 나가면 그 방 항목과 자리가 사라진다', () => {
  const s = new TrackStore()
  s.apply('join', 'r1', V(1), { kind: 'snapshot', tracks: [track('0')] })
  s.apply('join', 'r2', V(1), { kind: 'snapshot', tracks: [track('1', { room_id: 'r2' })] })
  s.dropRoom('r1')

  assert.equal(s.tracks('r1').length, 0)
  assert.deepEqual(s.seats().map((x) => x.mid), ['1'])
  assert.equal(s.versionOf('r1'), undefined)
})

test('한 방의 seq 는 다른 방을 막지 않는다', () => {
  const s = new TrackStore()
  s.apply('join', 'r1', V(100), { kind: 'snapshot', tracks: [] })
  assert.equal(s.apply('join', 'r2', V(1), { kind: 'snapshot', tracks: [track('0', { room_id: 'r2' })] }).accepted,
    true, 'seq 는 방마다다 — 서버 전체 일련번호가 아니다')
})
