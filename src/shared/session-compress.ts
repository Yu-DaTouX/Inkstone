import { normalizeLayoutPath } from './session-path'

export const COMPRESS_IDLE_DAYS = 7
export const COMPRESS_MIN_BYTES = 256 * 1024
const DAY = 86_400_000

export interface CompressCandidate {
  path: string
  archived: boolean
  size: number
  mtimeMs: number
  lastOpenedAt?: number
}

export interface CompressedStamp {
  size: number
  mtimeMs: number
}

export function selectCompressible(
  items: readonly CompressCandidate[],
  options: { now: number; busyFiles: readonly (string | undefined)[]; done: ReadonlyMap<string, CompressedStamp>; idleDays?: number }
): string[] {
  const cutoff = options.now - (options.idleDays ?? COMPRESS_IDLE_DAYS) * DAY
  const busy = new Set(options.busyFiles.filter((file): file is string => !!file).map(normalizeLayoutPath))
  return items
    .filter((item) => {
      if (!item.archived || item.size < COMPRESS_MIN_BYTES) return false
      if (Math.max(item.mtimeMs, item.lastOpenedAt ?? 0) >= cutoff) return false
      const key = normalizeLayoutPath(item.path)
      if (busy.has(key)) return false
      const stamp = options.done.get(key)
      return !(stamp && stamp.size === item.size && stamp.mtimeMs === item.mtimeMs)
    })
    .map((item) => item.path)
}
