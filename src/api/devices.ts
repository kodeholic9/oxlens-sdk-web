import { Devices as PlatformPort, PlatformDeviceInfo } from '../platform/media.js'
import { Bus } from './emitter.js'
import { DeviceInfo, DeviceKind, Devices, DevicesEvents } from './types.js'

export class DevicesHandle extends Bus<DevicesEvents> implements Devices {
  private known: ReadonlyArray<DeviceInfo> = []
  private readonly chosen: Partial<Record<DeviceKind, string>> = {}
  private stopWatch: (() => void) | null = null

  constructor(private readonly port: PlatformPort) {
    super()
  }

  get preferred(): Readonly<Partial<Record<DeviceKind, string>>> { return this.chosen }

  async list(opts?: { readonly kind?: DeviceKind; readonly requestPermissions?: boolean }): Promise<ReadonlyArray<DeviceInfo>> {
    if (opts?.requestPermissions) await this.warmLabels()
    const all = normalize(await this.port.enumerate())
    this.known = all
    return opts?.kind ? all.filter((d) => d.kind === opts.kind) : all
  }

  prefer(kind: DeviceKind, deviceId: string | null): void {
    if (deviceId === null) delete this.chosen[kind]
    else this.chosen[kind] = deviceId
  }

  watch(): void {
    if (this.stopWatch) return
    this.stopWatch = this.port.onChange(() => { void this.diff() })
  }

  close(): void {
    this.stopWatch?.()
    this.stopWatch = null
  }

  private async diff(): Promise<void> {
    const before = this.known
    const after = normalize(await this.port.enumerate())
    this.known = after
    const key = (d: DeviceInfo): string => `${d.kind}:${d.deviceId}`
    const had = new Set(before.map(key))
    const has = new Set(after.map(key))
    const added = after.filter((d) => !had.has(key(d)))
    const removed = before.filter((d) => !has.has(key(d)))
    if (added.length === 0 && removed.length === 0) return
    this.emit('change', { added, removed, list: after })
  }

  private async warmLabels(): Promise<void> {
    try {
      const track = await this.port.capture({ kind: 'microphone' })
      track.stop()
    } catch {
      return
    }
  }
}

function normalize(list: ReadonlyArray<PlatformDeviceInfo>): ReadonlyArray<DeviceInfo> {
  const real = list.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
  return list
    .map((d) => {
      if (d.deviceId !== 'default' && d.deviceId !== 'communications') return d
      const same = real.find((r) => r.kind === d.kind && r.groupId === d.groupId)
      return same ?? d
    })
    .filter((d, i, arr) => arr.findIndex((x) => x.kind === d.kind && x.deviceId === d.deviceId) === i)
    .map((d) => ({ deviceId: d.deviceId, kind: d.kind as DeviceKind, label: d.label, groupId: d.groupId }))
}
