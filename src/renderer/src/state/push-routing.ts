import type { MainPush, RunnerStatus, SessionState } from '../../../shared/ipc'
import { migrateSessionRuntime, reduceSessionRuntime, pruneSessionRuntimes, type SessionRuntimeMap } from './session-runtime'

export interface PushRoutingView {
  runners: RunnerStatus[]
  activeRunnerId: string | null
  sessionRuntimes: SessionRuntimeMap
  peekedSessionId: string | null
  peekedPath?: string | null
  session: SessionState | null
  visibleSessionIds?: string[]
}

export interface PushRoute {
  patch: { sessionRuntimes?: SessionRuntimeMap; activeRunnerId?: string } | null
  project: boolean
}

export function viewingSessionId(s: Pick<PushRoutingView, 'peekedSessionId' | 'session'>): string | undefined {
  return s.peekedSessionId ?? s.session?.sessionId ?? undefined
}

export function routePush(s: PushRoutingView, m: MainPush): PushRoute {
  if (m.runtime) {
    const currentRunner = s.runners.find((runner) => (runner.runId ?? runner.id) === m.runtime!.runId)
    if (currentRunner && m.runtime.generation < currentRunner.generation) return { patch: null, project: false }

    const active = s.activeRunnerId
      ? s.activeRunnerId === m.runtime.runId &&
        (!currentRunner || m.runtime.generation >= currentRunner.generation)
      : true
    let cache = migrateSessionRuntime(
      reduceSessionRuntime(s.sessionRuntimes, m.runtime, m),
      m.runtime
    )
    if (m.ch === 'sync' || m.ch === 'state') {
      const keep = new Set([viewingSessionId(s) ?? '', m.runtime.sessionId || `run:${m.runtime.runId}`, ...(s.visibleSessionIds ?? [])])
      for (const runner of s.runners) if (runner.running || runner.waiting || runner.isActive) {
        keep.add(runner.sessionId || `run:${runner.runId}`)
      }
      cache = pruneSessionRuntimes(cache, keep)
    }
    const patch = {
      sessionRuntimes: cache,
      ...(s.activeRunnerId ? {} : { activeRunnerId: m.runtime.runId })
    }
    const viewing = viewingSessionId(s)
    if (s.peekedPath && !viewing) return { patch, project: false }
    const belongsToView = !viewing || !m.runtime.sessionId || m.runtime.sessionId === viewing
    const viewingFrame = !!viewing && m.runtime.sessionId === viewing
    return { patch, project: belongsToView && (active || viewingFrame) }
  }
  return { patch: null, project: true }
}
