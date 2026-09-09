export interface PageLifecycle {
  onLeave(fn: () => void): () => void
}

export const browserPage: PageLifecycle = {
  onLeave(fn: () => void): () => void {
    const w = typeof window === 'undefined' ? undefined : window
    if (!w?.addEventListener) return () => {}
    w.addEventListener('pagehide', fn)
    w.addEventListener('beforeunload', fn)
    return () => {
      w.removeEventListener('pagehide', fn)
      w.removeEventListener('beforeunload', fn)
    }
  },
}
