import type { SessionSummary } from '../../../shared/ipc'

export function reuseSessionSummaries(previous: readonly SessionSummary[], next: readonly SessionSummary[]): SessionSummary[] {
  const byPath = new Map<string, { entry: SessionSummary; json: string }>()
  for (const entry of previous) byPath.set(entry.path, { entry, json: JSON.stringify(entry) })
  let unchanged = previous.length === next.length
  const merged = next.map((entry, index) => {
    const old = byPath.get(entry.path)
    if (old && old.json === JSON.stringify(entry)) {
      if (previous[index] !== old.entry) unchanged = false
      return old.entry
    }
    unchanged = false
    return entry
  })
  return unchanged ? (previous as SessionSummary[]) : merged
}
