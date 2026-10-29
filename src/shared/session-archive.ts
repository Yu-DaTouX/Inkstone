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
export const MAX_AUTO_ARCHIVE_DAYS = 365

export function normalizeAutoArchiveDays(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0
  return n <= 0 ? 0 : Math.min(n, MAX_AUTO_ARCHIVE_DAYS)
}

export const FLAT_AUTO_ARCHIVE_DAYS = 3

export function effectiveAutoArchiveDays(settings: { autoArchiveDays?: number; sidebarLayout?: 'projects' | 'flat' } | null | undefined): number {
  if (typeof settings?.autoArchiveDays === 'number') return normalizeAutoArchiveDays(settings.autoArchiveDays)
  return settings?.sidebarLayout === 'flat' ? FLAT_AUTO_ARCHIVE_DAYS : 0
}

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
