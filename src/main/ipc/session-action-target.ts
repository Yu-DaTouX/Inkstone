import type { ExpectedRuntimeOwner } from '../../shared/ipc'
import type { SessionHost } from '../session-host'

export const SESSION_ACTION_CHANGED = '会话已切换，操作已取消'

export function sessionActionAgent(host: Pick<SessionHost, 'ac' | 'runners'>, expected?: ExpectedRuntimeOwner) {
  if (expected === undefined) return host.ac()
  if (!expected || typeof expected.runId !== 'string' || !expected.runId || !Number.isSafeInteger(expected.generation)) return null
  const registry = host.runners()
  const status = registry?.statuses().find(item => (item.runId ?? item.id) === expected.runId)
  if (!status || status.generation !== expected.generation || (expected.sessionId && status.sessionId !== expected.sessionId) || (expected.projectId && status.projectId !== expected.projectId)) return null
  const agent = registry?.agentOf(expected.runId)
  if (!agent || (expected.sessionId && agent.getState()?.sessionId !== expected.sessionId)) return null
  return agent
}
