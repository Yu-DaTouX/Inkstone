import { useMemo } from 'react'
import { useStore } from '../../state/store'
import { deriveWorkspaceOwner, type OwnerViewRunner } from './ownership'
import type { WorkspaceOwner } from './types'

export function useWorkspaceOwner(): WorkspaceOwner {
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const session = useStore((s) => s.session)
  const pendingActivation = useStore((s) => s.pendingActivation)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const runners = useStore((s) => s.runners)
  const sessions = useStore((s) => s.sessions)

  return useMemo(
    () =>
      deriveWorkspaceOwner({
        peekedSessionId,
        peekedPath,
        session: session
          ? {
              sessionId: session.sessionId,
              sessionFile: session.sessionFile,
              conversationId: session.conversationId,
              conversationFile: session.conversationFile,
              cwd: session.cwd
            }
          : null,
        pendingActivation,
        activeRunnerId,
        runners: runners.map(
          (runner): OwnerViewRunner => ({
            id: runner.id,
            runId: runner.runId,
            sessionId: runner.sessionId,
            sessionFile: runner.sessionFile,
            cwd: runner.cwd,
            generation: runner.generation,
            isActive: runner.isActive
          })
        ),
        sessions: sessions.map((item) => ({ id: item.id, path: item.path, cwd: item.cwd }))
      }),
    [peekedSessionId, peekedPath, session, pendingActivation, activeRunnerId, runners, sessions]
  )
}

export function currentWorkspaceOwner(): WorkspaceOwner {
  const s = useStore.getState()
  return deriveWorkspaceOwner({
    peekedSessionId: s.peekedSessionId,
    peekedPath: s.peekedPath,
    session: s.session
      ? {
          sessionId: s.session.sessionId,
          sessionFile: s.session.sessionFile,
          conversationId: s.session.conversationId,
          conversationFile: s.session.conversationFile,
          cwd: s.session.cwd
        }
      : null,
    pendingActivation: s.pendingActivation,
    activeRunnerId: s.activeRunnerId,
    runners: s.runners,
    sessions: s.sessions
  })
}
