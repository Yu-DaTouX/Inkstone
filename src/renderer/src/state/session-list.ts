import type { SessionSummary } from '../../../shared/ipc'

const serialized = new WeakMap<SessionSummary, string>()

function jsonOf(entry: SessionSummary): string {
  let json = serialized.get(entry)
  if (json === undefined) {
    json = JSON.stringify(entry)
    serialized.set(entry, json)
  }
  return json
}

export function reuseSessionSummaries(previous: readonly SessionSummary[], next: readonly SessionSummary[]): SessionSummary[] {
  const byPath = new Map<string, SessionSummary>()
  for (const entry of previous) byPath.set(entry.path, entry)
  let unchanged = previous.length === next.length
  const merged = next.map((entry, index) => {
    const old = byPath.get(entry.path)
    if (old && (old === entry || jsonOf(old) === jsonOf(entry))) {
      if (previous[index] !== old) unchanged = false
      return old
    }
    unchanged = false
    return entry
  })
  return unchanged ? (previous as SessionSummary[]) : merged
}
