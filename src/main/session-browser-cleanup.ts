type BrowserSessionCloser = (sessionId: string) => Promise<unknown>

const SHARED_SESSION_IDS = new Set(['workspace'])

let closer: BrowserSessionCloser | null = null

export function setSessionBrowserCloser(next: BrowserSessionCloser | null): void {
  closer = next
}

export async function closeBrowserForSessions(
  sessionIds: Iterable<string | null | undefined>,
  options: { skip?: (sessionId: string) => boolean } = {}
): Promise<string[]> {
  const unique = new Set<string>()
  for (const id of sessionIds) {
    if (typeof id === 'string' && id && !SHARED_SESSION_IDS.has(id) && !options.skip?.(id)) unique.add(id)
  }
  const failed: string[] = []
  const close = closer
  if (!close) return failed
  for (const id of unique) {
    try {
      await close(id)
    } catch {
      failed.push(id)
    }
  }
  return failed
}
