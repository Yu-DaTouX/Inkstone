import type { QuotaWindow } from '../../../../shared/ipc'

export function selectFiniteQuotaWindow<T extends Pick<QuotaWindow, 'used' | 'total'>>(
  windows: readonly T[]
): T | null {
  let best: T | null = null
  for (const window of windows) {
    if (!Number.isFinite(window.used) || !Number.isFinite(window.total) || window.total <= 0) continue
    if (!best || window.used / window.total > best.used / best.total) best = window
  }
  return best
}

export function indexVisiblePaths(paths: readonly string[]): Map<string, number> {
  return new Map(paths.map((path, index) => [path, index]))
}

export function sessionSourceStorageKey(sessionId: string): string {
  return `yan.source-links.v1:${encodeURIComponent(sessionId)}`
}

export function shouldIncludeSyntheticCurrent(showArchivedSessions: boolean, currentPath?: string): boolean {
  return !!currentPath && !showArchivedSessions
}
