/**
 * 把 store 里的正式状态喂给纯推导 `deriveWorkspaceOwner`，供外壳与面板共用。
 *
 * 只读，不写 store；不改会话归属，也不触发激活。
 */
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
