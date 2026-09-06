import { MediaTrackLike } from './webrtc.js'

export interface AudioElementLike {
  volume: number
  muted: boolean
  srcObject: unknown
  play(): Promise<void>
  pause(): void
  release(): void
  setSinkId?(deviceId: string): Promise<void>
}

export interface AudioOut {
  create(track: MediaTrackLike): AudioElementLike
  onVisible(fn: () => void): () => void
}

export const browserAudio: AudioOut = {
  create(track: MediaTrackLike): AudioElementLike {
    const el = document.createElement('audio')
    el.autoplay = true
    ;(el as { playsInline?: boolean }).playsInline = true
    el.srcObject = new MediaStream([track as MediaStreamTrack])
    el.style.display = 'none'
    document.body.appendChild(el)
    const sink = (el as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId
    return {
      get volume() { return el.volume },
      set volume(v: number) { el.volume = v },
      get muted() { return el.muted },
      set muted(v: boolean) { el.muted = v },
      get srcObject() { return el.srcObject },
      set srcObject(v: unknown) { el.srcObject = v as MediaProvider | null },
      play: () => el.play(),
      pause: () => el.pause(),
      release: () => { el.pause(); el.srcObject = null; el.remove() },
      ...(sink ? { setSinkId: (id: string) => sink.call(el, id) } : {}),
    }
  },

  onVisible(fn: () => void): () => void {
    if (typeof document === 'undefined' || !document.addEventListener) return () => {}
    const h = (): void => { if (document.visibilityState === 'visible') fn() }
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  },
}

export const headlessAudio: AudioOut = {
  create(): AudioElementLike {
    let volume = 1
    let muted = false
    let srcObject: unknown = null
    return {
      get volume() { return volume },
      set volume(v: number) { volume = v },
      get muted() { return muted },
      set muted(v: boolean) { muted = v },
      get srcObject() { return srcObject },
      set srcObject(v: unknown) { srcObject = v },
      play: () => Promise.resolve(),
      pause: () => {},
      release: () => { srcObject = null },
    }
  },
  onVisible: () => () => {},
}
