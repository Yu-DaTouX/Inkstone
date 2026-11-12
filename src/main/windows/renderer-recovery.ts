const NO_RELOAD = new Set(['clean-exit', 'launch-failed', 'integrity-failure'])

export function createRendererRecovery(options: { limit?: number; windowMs?: number; now?: () => number } = {}): (reason: string) => boolean {
  const limit = options.limit ?? 3
  const windowMs = options.windowMs ?? 5 * 60_000
  const now = options.now ?? Date.now
  const recent: number[] = []
  return (reason) => {
    if (NO_RELOAD.has(reason)) return false
    const at = now()
    while (recent.length && at - recent[0] > windowMs) recent.shift()
    if (recent.length >= limit) return false
    recent.push(at)
    return true
  }
}
