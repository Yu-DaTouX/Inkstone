import { useLayoutEffect } from 'react'
import type { SplitSessionRef } from '../state/split-view'
import type { VisibleRunnerSession } from '../../../shared/ipc'

export function useRunnerVisibility(sessions: readonly SplitSessionRef[]): void {
  const key = JSON.stringify(sessions.flatMap(({ sessionId, path }) =>
    sessionId || path ? [{ sessionId, sessionFile: path }] : []
  ))
  useLayoutEffect(() => {
    const visible = JSON.parse(key) as VisibleRunnerSession[]
    void window.yan.setVisibleRunnerSessions(visible).catch((error) => console.error('[runner-visibility]', error))
  }, [key])
}
