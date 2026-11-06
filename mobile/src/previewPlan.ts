export const PREVIEW_COUNT = 8
export const PREVIEW_MIN_GAP_MS = 5000

export interface PreviewCandidate {
  id: string
  lastActivityAt?: number
  updatedAt: number
}

export function planPreviews(
  sessions: readonly PreviewCandidate[],
  versions: ReadonlyMap<string, number>,
  fetchedAt: ReadonlyMap<string, number>,
  now: number
): { fetch: string[]; retryIn: number | null } {
  const recent = [...sessions].sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt)).slice(0, PREVIEW_COUNT)
  const fetch: string[] = []
  let retryIn: number | null = null
  for (const session of recent) {
    if (versions.get(session.id) === (session.lastActivityAt ?? session.updatedAt)) continue
    const last = fetchedAt.get(session.id)
    const wait = last === undefined ? 0 : last + PREVIEW_MIN_GAP_MS - now
    if (wait > 0) retryIn = retryIn === null ? wait : Math.min(retryIn, wait)
    else fetch.push(session.id)
  }
  return { fetch, retryIn }
}
