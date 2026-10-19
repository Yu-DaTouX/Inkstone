export interface StopIntent {
  sessionId: string
  at: number
}

let current: StopIntent | null = null
const listeners = new Set<() => void>()

export function markStopRequested(sessionId: string | null | undefined, at = Date.now()): void {
  if (!sessionId) return
  current = { sessionId, at }
  for (const listener of [...listeners]) listener()
}

export function stopIntent(): StopIntent | null {
  return current
}

export function subscribeStopIntent(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isStopRequested(intent: StopIntent | null, sessionId: string | null | undefined, runStartedAt: number | null): boolean {
  if (!intent || !sessionId || intent.sessionId !== sessionId) return false
  return runStartedAt === null || intent.at >= runStartedAt
}
