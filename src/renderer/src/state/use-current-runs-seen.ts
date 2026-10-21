import { useEffect, useState } from 'react'
import { unreadRunIdsForSession } from '../features/sidebar/sidebar-model'
import { useRunsV3 } from './runs-v3'
import { useStore } from './store'

function windowAttended(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function markSessionRunsSeen(session: { id?: string | null; path?: string | null }): void {
  const runs = useRunsV3.getState()
  for (const runId of unreadRunIdsForSession(runs.runs, session)) runs.requestMarkSeen(runId)
}

export function useCurrentRunsSeen(): void {
  const sessionId = useStore((s) => s.session?.sessionId ?? null)
  const sessionFile = useStore((s) => s.session?.sessionFile ?? null)
  const runs = useRunsV3((s) => s.runs)
  const [attended, setAttended] = useState(windowAttended)

  useEffect(() => {
    const update = (): void => setAttended(windowAttended())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  useEffect(() => {
    if (!attended) return
    if (unreadRunIdsForSession(runs, { id: sessionId, path: sessionFile }).length === 0) return
    markSessionRunsSeen({ id: sessionId, path: sessionFile })
  }, [attended, runs, sessionId, sessionFile])
}
