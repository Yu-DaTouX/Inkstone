import type { Store } from '../../state/store'
import { viewIdentityOf } from '../../state/view-identity'
import { CONTEXT_USAGE_STATUS_KEY } from '../../state/context-sources'
import { PROMPT_SUGGESTION_STATUS_KEY } from '../composer/prompt-suggestion'
import { sessionViewIdentity } from '../session/view-state'

export function selectContextSession({ session }: Pick<Store, 'session'>) {
  return session ? {
    sessionId: session.sessionId,
    model: session.model,
    lastCompaction: session.lastCompaction,
    contextFrom: session.contextFrom,
    isStreaming: session.isStreaming,
    isAgentRunning: session.isAgentRunning,
    isCompacting: session.isCompacting,
    autoCompactionEnabled: session.autoCompactionEnabled
  } : null
}

export function selectOverviewSession(s: Pick<Store, 'session' | 'peekedSessionId' | 'peekedPath'>) {
  const { session } = s
  const { sessionId, key } = sessionViewIdentity(s)
  return {
    sessionId,
    key,
    model: session?.model,
    lastCompaction: session?.lastCompaction,
    running: !!(session?.isAgentRunning || session?.isStreaming),
    bridgeConfigured: session?.antigravity?.bridgeConfigured,
    mcpServers: session?.antigravity?.mcpServers
  }
}

export function selectTerminalJobView(s: Parameters<typeof viewIdentityOf>[0]) {
  const { sessionId, sessionFile } = viewIdentityOf(s)
  return { sessionId, sessionFile }
}

export function selectMcpView(s: Pick<Store, 'session' | 'activeRunnerId' | 'peekedSessionId' | 'peekedPath'>) {
  return [s.activeRunnerId, s.session?.sessionId ?? null, s.peekedSessionId, s.peekedPath] as const
}

export function createLogStatusSelector() {
  let previous: Store['statuses'] | undefined
  let entries: [string, string][] = []
  return ({ statuses }: Pick<Store, 'statuses'>): [string, string][] => {
    if (statuses === previous) return entries
    previous = statuses
    const next = Object.entries(statuses).filter(([key]) => key !== PROMPT_SUGGESTION_STATUS_KEY && key !== CONTEXT_USAGE_STATUS_KEY)
    if (next.length !== entries.length || next.some(([key, value], index) => {
      const entry = entries[index]
      return entry[0] !== key || entry[1] !== value
    })) entries = next
    return entries
  }
}
