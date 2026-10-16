import type { SessionState, VisibleRunnerSession } from '../shared/ipc'

export const IDLE_RECLAIM_ENABLED = true
export const IDLE_RECLAIM_AFTER_MS = 10 * 60_000
export const IDLE_RECLAIM_SCAN_MS = 60_000

export interface IdleReclaimFacts {
  active: boolean
  hidden: boolean
  busy: boolean
  busyCwd: boolean
  ready: boolean
  saved: boolean
  queued: boolean
  visible: boolean
  parentProtected: boolean
  restarting: boolean
  lastActiveAt: number
}

export function canReclaimIdle(facts: IdleReclaimFacts, now: number, afterMs = IDLE_RECLAIM_AFTER_MS): boolean {
  return !facts.active && !facts.hidden && !facts.busy && !facts.busyCwd && facts.ready && facts.saved &&
    !facts.queued && !facts.visible && !facts.parentProtected && !facts.restarting &&
    Number.isFinite(facts.lastActiveAt) && now - facts.lastActiveAt >= afterMs
}

const pathKey = (value: string): string => value.replaceAll('\\', '/').toLowerCase()

export class RunnerVisibility {
  private sessions: VisibleRunnerSession[] | null = null

  reset(): void {
    this.sessions = null
  }

  update(input: unknown): boolean {
    if (!Array.isArray(input) || input.length > 5) return false
    const sessions: VisibleRunnerSession[] = []
    for (const item of input) {
      if (!item || typeof item !== 'object') return false
      const { sessionId, sessionFile } = item
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256)) return false
      if (sessionFile !== undefined && (typeof sessionFile !== 'string' || !sessionFile || sessionFile.length > 4096)) return false
      if (!sessionId && !sessionFile) return false
      sessions.push({ sessionId, sessionFile })
    }
    this.sessions = sessions
    return true
  }

  includes(state: Pick<SessionState, 'sessionId' | 'sessionFile'> | null): boolean {
    if (!this.sessions) return true
    return this.sessions.some((item) =>
      (!!item.sessionId && item.sessionId === state?.sessionId) ||
      (!!item.sessionFile && !!state?.sessionFile && pathKey(item.sessionFile) === pathKey(state.sessionFile))
    )
  }
}
