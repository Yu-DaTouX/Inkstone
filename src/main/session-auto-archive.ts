import { selectAutoArchive, type ArchiveCandidate } from '../shared/session-archive'

export const AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface AutoArchiveSweepInput<T extends ArchiveCandidate> {
  sessions: readonly T[]
  days: unknown
  busyFiles: readonly (string | undefined)[]
  archive: (ids: string[]) => Promise<unknown>
  now?: number
}

export async function runAutoArchiveSweep<T extends ArchiveCandidate>(input: AutoArchiveSweepInput<T>): Promise<string[]> {
  const ids = selectAutoArchive(input.sessions, {
    days: Number(input.days),
    now: input.now ?? Date.now(),
    busyFiles: input.busyFiles
  })
  if (!ids.length) return []
  try {
    await input.archive(ids)
  } catch {
    return []
  }
  return ids
}
