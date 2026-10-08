/**
 * 自动归档的选择规则：闲置够久、没置顶、没有运行实例的会话。
 *
 * 纯函数，主进程在列会话时调用；写盘与推送不在这里。
 */
import { normalizeLayoutPath } from './session-path'

export interface ArchiveCandidate {
  id: string
  path: string
  updatedAt: number
  lastActivityAt?: number
  archivedAt?: number
  pinned?: boolean
}

const DAY = 86_400_000
/** 设置页允许的上限；超过按 365 处理，非数字、负数、小数一律当作「从不」或向下取整。 */
export const MAX_AUTO_ARCHIVE_DAYS = 365

export function normalizeAutoArchiveDays(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0
  return n <= 0 ? 0 : Math.min(n, MAX_AUTO_ARCHIVE_DAYS)
}

/**
 * @param busyFiles 有运行实例的会话文件（运行中、等待回答或空闲的实例都算，实例在就说明用户还在用）
 */
export function selectAutoArchive(
  items: readonly ArchiveCandidate[],
  options: { days: number; now: number; busyFiles: readonly (string | undefined)[] }
): string[] {
  const days = normalizeAutoArchiveDays(options.days)
  if (!days) return []
  const cutoff = options.now - days * DAY
  const busy = new Set(options.busyFiles.filter((f): f is string => !!f).map(normalizeLayoutPath))
  return items
    .filter((s) => !s.archivedAt && !s.pinned && (s.lastActivityAt ?? s.updatedAt) < cutoff && !busy.has(normalizeLayoutPath(s.path)))
    .map((s) => s.id)
}
