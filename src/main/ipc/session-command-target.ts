import type { ExpectedRuntimeOwner } from '../../shared/ipc'
import type { SessionHost } from '../session-host'
import { sessionActionAgent } from './session-action-target'

export async function abortBashFor(host: Pick<SessionHost, 'ac' | 'runners'>, expected?: ExpectedRuntimeOwner): Promise<void> {
  await sessionActionAgent(host, expected)?.abortBash()
}

export async function lastAssistantTextFor(host: Pick<SessionHost, 'ac' | 'runners'>, expected?: ExpectedRuntimeOwner): Promise<string | null> {
  return sessionActionAgent(host, expected)?.lastAssistantText() ?? null
}
