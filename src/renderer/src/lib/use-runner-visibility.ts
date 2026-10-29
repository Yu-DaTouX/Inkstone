import { useLayoutEffect, useMemo } from 'react'
import type { VisibleRunnerSession } from '../../../shared/ipc'

export function useRunnerVisibility(sessions: readonly { sessionId?: string; path?: string }[]): void {
  const visible = useMemo<VisibleRunnerSession[]>(
    () => sessions.flatMap(({ sessionId, path }) => (sessionId || path ? [{ sessionId, sessionFile: path }] : [])),
    [sessions]
  )
  useLayoutEffect(() => {
    void window.yan.setVisibleRunnerSessions(visible).catch((error) => console.error('[runner-visibility]', error))
  }, [visible])
}
