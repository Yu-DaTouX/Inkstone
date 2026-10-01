import type { HubTask } from './agent-hub'
import type { SubagentRun } from './ipc'

/** 只读运行投影：保留正式后端身份，操作回到各自事实源。 */
export interface AgentWorkspaceRun {
  key: string
  source: 'hub' | 'subagent'
  id: string
  title: string
  agent: string
  status: string
  live: boolean
  attention: boolean
  terminal: boolean
  startedAt: number
}
export function agentWorkspaceRuns(tasks: readonly HubTask[], subagents: readonly SubagentRun[]): AgentWorkspaceRun[] {
  return [
    ...tasks.map(t => ({ key: `hub:${t.id}`, source: 'hub' as const, id: t.id, title: t.title, agent: t.agent, status: t.status, live: ['queued', 'preparing', 'running', 'waiting_input'].includes(t.status), attention: ['waiting_input', 'needs_review', 'failed', 'uncertain'].includes(t.status), terminal: t.mode === 'terminal', startedAt: t.createdAt })),
    ...subagents.filter(t => !['merged', 'discarded', 'archived'].includes(t.review)).map(t => ({ key: `subagent:${t.id}`, source: 'subagent' as const, id: t.id, title: t.task, agent: 'pi', status: t.status, live: ['starting', 'running'].includes(t.status), attention: ['pending', 'conflict'].includes(t.review) || t.status === 'error', terminal: false, startedAt: t.startedAt }))
  ].sort((a,b) => Number(b.live)-Number(a.live) || Number(b.attention)-Number(a.attention) || b.startedAt-a.startedAt)
}
