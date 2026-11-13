import type { SubagentRun } from '../../../shared/ipc'

export interface SubagentScope {
  sessionIds: string[]
  runIds?: string[]
}

export interface SubagentGroups {
  attached: SubagentRun[]
  detached: SubagentRun[]
  foreign: SubagentRun[]
  unattributed: SubagentRun[]
  all: SubagentRun[]
  running: number
}

export function dedupeRuns(runs: SubagentRun[]): SubagentRun[] {
  const byId = new Map<string, SubagentRun>()
  for (const run of runs) byId.set(run.id, run)
  return [...byId.values()]
}

export function normalizeSubagentPath(value?: string): string {
  return (value ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

export interface SubagentRunnerRef {
  id: string
  runId?: string
  sessionId?: string
  sessionFile?: string
  projectId?: string
  generation?: number
}

export interface SubagentViewInput {
  peekedSessionId: string | null
  peekedPath: string | null
  session: { sessionId?: string; sessionFile?: string; conversationId?: string } | null
  runners: readonly SubagentRunnerRef[]
}

export function subagentScopeForView(input: SubagentViewInput): SubagentScope {
  const peeking = !!(input.peekedSessionId || input.peekedPath)
  const sessionId = peeking ? input.peekedSessionId ?? undefined : input.session?.sessionId ?? undefined
  const path = peeking ? input.peekedPath ?? undefined : input.session?.sessionFile ?? undefined
  const conversationId = peeking ? undefined : input.session?.conversationId
  const sessionIds = [sessionId, conversationId].filter((v): v is string => !!v)
  const viewRunner = findViewRunner(input, sessionId, path)
  const viewRunnerId = viewRunner ? viewRunner.runId ?? viewRunner.id : undefined
  return { sessionIds, runIds: viewRunnerId ? [viewRunnerId] : [] }
}

function findViewRunner(
  input: SubagentViewInput,
  sessionId: string | undefined,
  path: string | undefined
): SubagentRunnerRef | undefined {
  return input.runners.find(
    (runner) =>
      (!!sessionId && sessionId.startsWith('pending:') && (runner.runId ?? runner.id) === sessionId.slice('pending:'.length)) ||
      (!!sessionId && !sessionId.startsWith('pending:') && runner.sessionId === sessionId) ||
      (!!path && !!runner.sessionFile && normalizeSubagentPath(runner.sessionFile) === normalizeSubagentPath(path))
  )
}

function belongsToScope(run: SubagentRun, ids: Set<string>, runIds: Set<string>): boolean | null {
  if (run.parentSessionId) return ids.has(run.parentSessionId)
  if (run.parentRunId && runIds.has(run.parentRunId)) return true
  return null
}

export function selectSubagentRuns(runs: SubagentRun[], scope: SubagentScope): SubagentGroups {
  const ids = new Set(scope.sessionIds.filter(Boolean))
  const runIds = new Set(scope.runIds ?? [])
  const attached: SubagentRun[] = []
  const detached: SubagentRun[] = []
  const foreign: SubagentRun[] = []
  const unattributed: SubagentRun[] = []
  for (const run of dedupeRuns(runs)) {
    const owned = belongsToScope(run, ids, runIds)
    if (owned === null) unattributed.push(run)
    else if (!owned) foreign.push(run)
    else if (run.parentMessageId) attached.push(run)
    else detached.push(run)
  }
  const all = [...attached, ...detached]
  return {
    attached,
    detached,
    foreign,
    unattributed,
    all,
    running: all.filter((run) => run.status === 'running' || run.status === 'starting').length
  }
}

export function viewSubagentRuns(input: SubagentViewInput & { subagents: SubagentRun[] }): SubagentRun[] {
  return selectSubagentRuns(input.subagents, subagentScopeForView(input)).all
}

export interface TurnSubagentScope {
  sessionIds: string[]
  parentRunIds?: string[]
}

export function subagentRunsForTurnScope(runs: SubagentRun[], scope: TurnSubagentScope): SubagentRun[] {
  const ids = new Set(scope.sessionIds.filter(Boolean))
  const parents = new Set((scope.parentRunIds ?? []).filter(Boolean))
  return dedupeRuns(runs).filter(
    (run) => (!!run.parentSessionId && ids.has(run.parentSessionId)) || (!!run.parentRunId && parents.has(run.parentRunId))
  )
}

export function subagentCost(runs: readonly SubagentRun[]): number {
  return dedupeRuns([...runs]).reduce((sum, run) => {
    const cost = run.usage?.cost
    return sum + (typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0)
  }, 0)
}

export function subagentTokens(runs: readonly SubagentRun[]): number {
  let sum = 0
  for (const run of runs) {
    const u = run.usage
    if (!u) continue
    const parts = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
    sum += parts > 0 ? parts : Math.max(0, u.totalTokens ?? 0)
  }
  return sum
}
