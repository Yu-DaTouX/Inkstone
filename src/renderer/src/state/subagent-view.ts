import { subagentOutcome } from '../../../shared/subagent-outcome'
import type { ExpectedRuntimeOwner, SubagentRun } from '../../../shared/ipc'

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

export interface SubagentViewOwnership {
  expectedRuntime?: ExpectedRuntimeOwner
  needsRunner: boolean
}

export function subagentOwnerForView(input: SubagentViewInput): SubagentViewOwnership {
  const peeking = !!(input.peekedSessionId || input.peekedPath)
  const sessionId = peeking ? input.peekedSessionId ?? undefined : input.session?.sessionId ?? undefined
  const path = peeking ? input.peekedPath ?? undefined : input.session?.sessionFile ?? undefined
  const conversationId = peeking ? undefined : input.session?.conversationId
  const runner = findViewRunner(input, sessionId, path)
  if (runner) {
    const runId = runner.runId ?? runner.id
    if (runId) {
      return {
        expectedRuntime: {
          ...(runner.sessionId ? { sessionId: runner.sessionId } : {}),
          runId,
          ...(runner.projectId ? { projectId: runner.projectId } : {}),
          ...(runner.generation !== undefined ? { generation: runner.generation } : {})
        },
        needsRunner: false
      }
    }
  }
  return { needsRunner: !!(sessionId || path || conversationId) }
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

export function subagentTabId(runId: string): string {
  return `subagent:${runId}`
}

export const RECENT_DONE_MS = 5 * 60_000

export function visibleSubagentRuns(runs: SubagentRun[], scope: SubagentScope, now = Date.now()): SubagentRun[] {
  return selectSubagentRuns(runs, scope).all.filter((run) => {
    if (run.status === 'starting' || run.status === 'running' || run.status === 'error') return true
    if (run.review === 'pending' || run.review === 'conflict') return true
    if (run.review === 'merged' || run.review === 'discarded' || run.review === 'archived') return false
    return run.status === 'done' && !!run.endedAt && now - run.endedAt < RECENT_DONE_MS
  })
}

export function activeSubagentRuns(runs: SubagentRun[], scope: SubagentScope): SubagentRun[] {
  return selectSubagentRuns(runs, scope).all.filter((run) => {
    const outcome = subagentOutcome(run)
    return outcome.live || outcome.attention
  })
}

export function hasVisibleSubagents(s: { subagents: SubagentRun[]; session?: { sessionId?: string; conversationId?: string } | null }): boolean {
  const sessionIds = [s.session?.sessionId, s.session?.conversationId].filter((v): v is string => !!v)
  return visibleSubagentRuns(s.subagents, { sessionIds }).length > 0
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
