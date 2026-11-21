import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore, type Store } from '../../state/store'
import { deriveWorkspaceOwner, type OwnerViewSession } from './ownership'
import type { WorkspaceOwner } from './types'

function ownerSession({ session }: Pick<Store, 'session'>): OwnerViewSession | null {
  return session ? {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    conversationId: session.conversationId,
    conversationFile: session.conversationFile,
    cwd: session.cwd
  } : null
}

export function useWorkspaceOwner(): WorkspaceOwner {
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const session = useStore(useShallow(ownerSession))
  const pendingActivation = useStore((s) => s.pendingActivation)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const runners = useStore((s) => s.runners)
  const sessions = useStore((s) => s.sessions)

  return useMemo(
    () =>
      deriveWorkspaceOwner({
        peekedSessionId,
        peekedPath,
        session,
        pendingActivation,
        activeRunnerId,
        runners,
        sessions
      }),
    [peekedSessionId, peekedPath, session, pendingActivation, activeRunnerId, runners, sessions]
  )
}

export function currentWorkspaceOwner(): WorkspaceOwner {
  const s = useStore.getState()
  return deriveWorkspaceOwner({
    peekedSessionId: s.peekedSessionId,
    peekedPath: s.peekedPath,
    session: ownerSession(s),
    pendingActivation: s.pendingActivation,
    activeRunnerId: s.activeRunnerId,
    runners: s.runners,
    sessions: s.sessions
  })
}
