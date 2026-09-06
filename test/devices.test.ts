import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DevicesHandle } from '../src/api/devices.js'
import { FakeDevices } from './_fakes.js'

function dev(deviceId: string, kind: 'audioinput' | 'audiooutput' | 'videoinput', groupId = 'g1', label = ''): {
  deviceId: string; kind: 'audioinput' | 'audiooutput' | 'videoinput'; groupId: string; label: string
} {
  return { deviceId, kind, groupId, label }
}

test('list 는 default 를 groupId 로 실제 장치에 정규화하고 중복을 지운다', async () => {
  const port = new FakeDevices()
  port.list = [dev('default', 'audioinput', 'gA'), dev('mic-a', 'audioinput', 'gA'), dev('mic-b', 'audioinput', 'gB')]
  const d = new DevicesHandle(port)
  const got = await d.list()
  assert.deepEqual(got.map((x) => x.deviceId), ['mic-a', 'mic-b'])
})

test('list 는 kind 로 거른다', async () => {
  const port = new FakeDevices()
  port.list = [dev('mic-a', 'audioinput'), dev('cam-a', 'videoinput'), dev('spk-a', 'audiooutput')]
  const d = new DevicesHandle(port)
  assert.deepEqual((await d.list({ kind: 'videoinput' })).map((x) => x.deviceId), ['cam-a'])
})

test('짝이 없는 default 는 그대로 남긴다 — 지어내지 않는다', async () => {
  const port = new FakeDevices()
  port.list = [dev('default', 'audiooutput', 'gZ')]
  const d = new DevicesHandle(port)
  assert.deepEqual((await d.list()).map((x) => x.deviceId), ['default'])
})

test('preferred 는 처음엔 비어 있고 prefer 로 정하고 null 로 지운다', async () => {
  const d = new DevicesHandle(new FakeDevices())
  assert.deepEqual(d.preferred, {})
  d.prefer('audioinput', 'mic-a')
  assert.equal(d.preferred.audioinput, 'mic-a')
  d.prefer('audioinput', null)
  assert.equal(d.preferred.audioinput, undefined)
})

test('꽂고 뽑으면 change 가 added·removed 로 온다', async () => {
  const port = new FakeDevices()
  port.list = [dev('mic-a', 'audioinput', 'gA')]
  const d = new DevicesHandle(port)
  await d.list()
  const seen: Array<{ added: string[]; removed: string[] }> = []
  d.on('change', (e) => seen.push({ added: e.added.map((x) => x.deviceId), removed: e.removed.map((x) => x.deviceId) }))
  d.watch()

  port.plug([dev('mic-a', 'audioinput', 'gA'), dev('mic-b', 'audioinput', 'gB')])
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(seen, [{ added: ['mic-b'], removed: [] }])

  port.plug([dev('mic-b', 'audioinput', 'gB')])
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(seen[1], { added: [], removed: ['mic-a'] })
})

test('목록이 그대로면 change 를 내지 않는다', async () => {
  const port = new FakeDevices()
  port.list = [dev('mic-a', 'audioinput', 'gA')]
  const d = new DevicesHandle(port)
  await d.list()
  let n = 0
  d.on('change', () => { n += 1 })
  d.watch()
  port.plug([dev('mic-a', 'audioinput', 'gA')])
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(n, 0)
})

test('close 뒤에는 더 안 온다 — 주인이 쥐고 주인이 놓는다', async () => {
  const port = new FakeDevices()
  port.list = [dev('mic-a', 'audioinput', 'gA')]
  const d = new DevicesHandle(port)
  await d.list()
  let n = 0
  d.on('change', () => { n += 1 })
  d.watch()
  d.close()
  port.plug([dev('mic-b', 'audioinput', 'gB')])
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(n, 0)
})
