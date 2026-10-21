import { useLayoutEffect, useMemo } from 'react'
import type { SplitSessionRef } from '../state/split-view'
import type { VisibleRunnerSession } from '../../../shared/ipc'

export function useRunnerVisibility(sessions: readonly SplitSessionRef[]): void {
  const visible = useMemo<VisibleRunnerSession[]>(
    () => sessions.flatMap(({ sessionId, path }) => (sessionId || path ? [{ sessionId, sessionFile: path }] : [])),
    [sessions]
  )
  useLayoutEffect(() => {
    void window.yan.setVisibleRunnerSessions(visible).catch((error) => console.error('[runner-visibility]', error))
  }, [visible])
}
