import { createContext, useContext } from 'react'
import { useStore } from '../../state/store'
import type { SessionState, UIMessage } from '../../../../shared/ipc'

export interface TurnScope {
  messages: readonly UIMessage[]
  session: SessionState | null
}

export const TurnScopeContext = createContext<TurnScope | null>(null)

export function useTurnScope(): TurnScope | null {
  return useContext(TurnScopeContext)
}

export function useTurnSession<T>(pick: (session: SessionState | null | undefined) => T): T {
  const scope = useTurnScope()
  return useStore((s) => pick(scope ? scope.session : s.session))
}
