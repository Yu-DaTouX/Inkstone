import { createContext, useContext } from 'react'
import { useStore } from '../../state/store'
import type { SessionState, UIMessage } from '../../../../shared/ipc'
import type { SessionViewIdentity } from './view-state'

export interface TurnScope {
  messages: readonly UIMessage[]
  session: SessionState | null
  cwd?: string
  view?: SessionViewIdentity
}

export const TurnScopeContext = createContext<TurnScope | null>(null)

const NO_MESSAGES: readonly UIMessage[] = []

export function subagentTurnScope(runId: string, cwd: string): TurnScope {
  return { messages: NO_MESSAGES, session: null, cwd, view: { sessionId: null, sessionFile: null, key: `subagent:${runId}` } }
}

export function useTurnScope(): TurnScope | null {
  return useContext(TurnScopeContext)
}

export function useTurnSession<T>(pick: (session: SessionState | null | undefined) => T): T {
  const scope = useTurnScope()
  return useStore((s) => pick(scope ? scope.session : s.session))
}
