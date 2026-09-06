import { collect, ProbeSources } from '../internal/probe.js'
import { Bus } from './emitter.js'
import { Diagnostics, DiagnosticsEvents, LogLevel, LogRecord, ProbeResult } from './types.js'

const ORDER: ReadonlyArray<LogLevel> = ['trace', 'debug', 'info', 'warn', 'error']

export class DiagnosticsHandle extends Bus<DiagnosticsEvents> implements Diagnostics {
  private level: LogLevel | 'silent' = 'info'

  constructor(private readonly src: ProbeSources) {
    super()
  }

  async probe(): Promise<ProbeResult> {
    return (await collect(this.src)) as unknown as ProbeResult
  }

  setLogLevel(level: LogLevel | 'silent'): void { this.level = level }

  log(level: LogLevel, module: string, msg: string, ctx?: Record<string, unknown>): void {
    if (!this.enabled(level)) return
    const rec: LogRecord = {
      ts: Date.now(), level, module, msg, ...(ctx === undefined ? {} : { ctx }),
    }
    this.emit('log', rec)
  }

  private enabled(level: LogLevel): boolean {
    if (this.level === 'silent') return false
    return ORDER.indexOf(level) >= ORDER.indexOf(this.level)
  }
}
