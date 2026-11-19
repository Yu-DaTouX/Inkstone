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

export interface WorkflowModelStats {
  total: number
  done: number
  cached: number
  failed: number
  stopped: number
  running: number
  queued: number
  waitingQuota?: boolean
  phases?: WorkflowModelPhaseStat[]
  cells?: string
  cost?: number
  since?: number
  latest?: WorkflowModelLatest
  failures?: WorkflowModelFailure[]
}

export type WorkflowModelCellStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'cached'

export const MODEL_CELL_CODE: Record<WorkflowModelCellStatus, string> = { queued: 'q', running: 'r', done: 'd', failed: 'f', stopped: 's', cached: 'c' }

export interface WorkflowModelLatest {
  index: number
  label?: string
  text: string
  at: number
}

export interface WorkflowModelFailure {
  index: number
  label?: string
  error: string
}

export interface WorkflowModelCall {
  index: number
  label?: string
  status: WorkflowModelCellStatus
  startedAt?: number
  endedAt?: number
  error?: string
}

export interface WorkflowModelPhaseStat {
  title: string
  total: number
  done: number
  failed: number
  stopped: number
  running: number
  queued: number
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
  modelConcurrency?: number
  agents: WorkflowAgentView[]
  models?: WorkflowModelStats
  logs: string[]
  error?: string
  dir: string
  hasResult?: boolean
  resumeError?: string
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
  maxLogs: 20,
  maxModels: 5000,
  defaultModelConcurrency: 8,
  maxModelConcurrency: 32,
  defaultModelTimeoutMinutes: 5,
  defaultModelRetries: 1,
  maxModelPromptChars: 2_000_000,
  modelLatestChars: 120,
  modelFailuresShown: 50,
  modelErrorChars: 1000
} as const

export function clipModelText(value: unknown, max: number): string {
  let text = ''
  if (typeof value === 'string') text = value
  else if (value !== undefined && value !== null) {
    try {
      text = JSON.stringify(value) ?? ''
    } catch {
      text = String(value)
    }
  }
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

export function modelCellCounts(cells: string): { queued: number; running: number; done: number; failed: number; stopped: number } {
  const counts = { queued: 0, running: 0, done: 0, failed: 0, stopped: 0 }
  for (let i = 0; i < cells.length; i++) {
    const code = cells.charCodeAt(i)
    if (code === 100 || code === 99) counts.done += 1
    else if (code === 114) counts.running += 1
    else if (code === 102) counts.failed += 1
    else if (code === 115) counts.stopped += 1
    else counts.queued += 1
  }
  return counts
}

export function modelThroughput(models: Pick<WorkflowModelStats, 'done' | 'running' | 'queued' | 'since'>, now: number): { perMinute: number; etaMs: number | null } {
  const minutes = typeof models.since === 'number' ? (now - models.since) / 60_000 : 0
  if (minutes <= 0 || models.done <= 0) return { perMinute: 0, etaMs: null }
  const perMinute = models.done / minutes
  const left = models.running + models.queued
  return { perMinute, etaMs: left > 0 ? (left / perMinute) * 60_000 : null }
}

export function interruptedModelStats(models: WorkflowModelStats): WorkflowModelStats {
  return {
    ...models,
    stopped: models.stopped + models.running + models.queued,
    running: 0,
    queued: 0,
    waitingQuota: undefined,
    phases: models.phases?.map((phase) => ({ ...phase, stopped: phase.stopped + phase.running + phase.queued, running: 0, queued: 0 })),
    ...(models.cells ? { cells: models.cells.replace(/[rq]/g, MODEL_CELL_CODE.stopped) } : {})
  }
}

export function emptyModelStats(): WorkflowModelStats {
  return { total: 0, done: 0, cached: 0, failed: 0, stopped: 0, running: 0, queued: 0 }
}

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

export function workflowPhaseStats(run: Pick<WorkflowRunView, 'agents' | 'declaredPhases'> & Partial<Pick<WorkflowRunView, 'models'>>): WorkflowPhaseStat[] {
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
  for (const part of run.models?.phases ?? []) {
    const stat = ensure(part.title)
    stat.total += part.total
    stat.done += part.done
    stat.failed += part.failed + part.stopped
    stat.stopped += part.stopped
    stat.running += part.running
    stat.queued += part.queued
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
