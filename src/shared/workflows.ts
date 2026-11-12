export type WorkflowStatus = 'running' | 'paused' | 'done' | 'failed' | 'stopped' | 'interrupted'

export type WorkflowAgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'cached'

export interface WorkflowMeta {
  name: string
  description: string
  phases?: string[]
}

export interface WorkflowAgentView {
  seq: number
  label?: string
  phase?: string
  status: WorkflowAgentStatus
  subagentId?: string
  retries?: number
  error?: string
}

export interface WorkflowRunView {
  id: string
  sessionId?: string
  parentRunId?: string
  parentGeneration?: number
  parentMessageId?: string
  cwd: string
  name: string
  description: string
  declaredPhases: string[]
  status: WorkflowStatus
  startedAt: number
  endedAt?: number
  attempt: number
  concurrency: number
  agents: WorkflowAgentView[]
  logs: string[]
  error?: string
  dir: string
  hasResult?: boolean
}

export interface WorkflowPhaseStat {
  title: string
  total: number
  done: number
  failed: number
  stopped: number
  running: number
  queued: number
}

export const WORKFLOW_LIMITS = {
  defaultConcurrency: 8,
  maxConcurrency: 24,
  globalSlots: 24,
  maxAgents: 200,
  maxItems: 1000,
  schemaRetries: 3,
  largeAgents: 25,
  maxLogs: 20
} as const

export const WORKFLOW_ID = /^wf-[0-9a-f]{8}$/

export const WORKFLOW_ANCHOR_PREFIX = 'workflow:'

export function normalizeWorkflowId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : ''
  return WORKFLOW_ID.test(id) ? id : null
}

export function workflowAnchor(id: string): string {
  return `${WORKFLOW_ANCHOR_PREFIX}${id}`
}

export function workflowIdOfAnchor(anchor: string | undefined): string | null {
  return anchor?.startsWith(WORKFLOW_ANCHOR_PREFIX) ? normalizeWorkflowId(anchor.slice(WORKFLOW_ANCHOR_PREFIX.length)) : null
}

export function isLiveWorkflow(status: WorkflowStatus): boolean {
  return status === 'running' || status === 'paused'
}

export function isLargeWorkflow(run: Pick<WorkflowRunView, 'agents'>): boolean {
  return run.agents.length > WORKFLOW_LIMITS.largeAgents
}

export function agentFinished(status: WorkflowAgentStatus): boolean {
  return status === 'done' || status === 'cached' || status === 'failed' || status === 'stopped'
}

export function workflowPhaseStats(run: Pick<WorkflowRunView, 'agents' | 'declaredPhases'>): WorkflowPhaseStat[] {
  const order: string[] = []
  const stats = new Map<string, WorkflowPhaseStat>()
  const ensure = (title: string): WorkflowPhaseStat => {
    let stat = stats.get(title)
    if (!stat) {
      stat = { title, total: 0, done: 0, failed: 0, stopped: 0, running: 0, queued: 0 }
      stats.set(title, stat)
      order.push(title)
    }
    return stat
  }
  for (const title of run.declaredPhases) ensure(title)
  for (const agent of run.agents) {
    const stat = ensure(agent.phase ?? '')
    stat.total += 1
    if (agent.status === 'done' || agent.status === 'cached') stat.done += 1
    else if (agent.status === 'failed' || agent.status === 'stopped') {
      stat.failed += 1
      if (agent.status === 'stopped') stat.stopped += 1
    }
    else if (agent.status === 'running') stat.running += 1
    else stat.queued += 1
  }
  return order.map((title) => stats.get(title)!).filter((stat) => stat.title !== '' || stat.total > 0)
}

export function workflowTotals(run: Pick<WorkflowRunView, 'agents'>): { total: number; done: number; failed: number; stopped: number; running: number; queued: number } {
  const totals = { total: run.agents.length, done: 0, failed: 0, stopped: 0, running: 0, queued: 0 }
  for (const agent of run.agents) {
    if (agent.status === 'done' || agent.status === 'cached') totals.done += 1
    else if (agent.status === 'failed' || agent.status === 'stopped') {
      totals.failed += 1
      if (agent.status === 'stopped') totals.stopped += 1
    }
    else if (agent.status === 'running') totals.running += 1
    else totals.queued += 1
  }
  return totals
}
