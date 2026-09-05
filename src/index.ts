// author: kodeholic (powered by Claude)
// OxLens SDK 진입점. 표면은 api/types, 유일한 생성 경로는 createClient 다(SDK§2-1).
export * from './api/types.js'
export { NotImplementedError } from './api/not-implemented.js'
export type { Wiring } from './api/client.js'

import { Client, Wiring } from './api/client.js'
import { browserDevices } from './platform/media.js'
import type { ClientOptions, OxLensClient } from './api/types.js'

export function createClient(opts: ClientOptions, wiring: Wiring = {}): OxLensClient {
  return new Client(opts, { devices: browserDevices, ...wiring })
}
