import { create } from 'zustand'
import { isLiveSubagentRun, subagentRunTokens } from '../../../../shared/subagent-task-rows'
import type { SubagentRun } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'

const SUBAGENT_LIST_SHOWN = 5

type SubagentListRank = 0 | 1 | 2 | 3

type PhaseKind = RunSnapshot['phase']['kind']

const WAITING_PHASES: ReadonlySet<PhaseKind> = new Set<PhaseKind>(['queued', 'needs-you', 'stalled'])

export function subagentListRank(run: Pick<SubagentRun, 'status' | 'dismissedAt'>, phase?: PhaseKind | null): SubagentListRank {
  if (run.status === 'error') return typeof run.dismissedAt === 'number' ? 3 : 0
  if (run.status === 'done' || run.status === 'cancelled') return 3
  if (run.status === 'starting') return 2
  if (phase && WAITING_PHASES.has(phase)) return 2
  return 1
}

export function orderSubagentRuns(
  runs: readonly SubagentRun[],
  phases: Readonly<Record<string, PhaseKind | null | undefined>> = {}
): SubagentRun[] {
  return runs
    .map((run, index) => ({ run, index, rank: subagentListRank(run, phases[run.id]) }))
    .sort((a, b) => a.rank - b.rank || a.run.startedAt - b.run.startedAt || a.index - b.index)
    .map((item) => item.run)
}

export interface SubagentListTotals {
  total: number
  live: number
  failed: number
  done: number
  stopped: number
  toolCalls: number
  tokens: number
  spanMs: number | null
  ended: boolean
}

export function subagentListTotals(runs: readonly SubagentRun[]): SubagentListTotals {
  let live = 0
  let failed = 0
  let done = 0
  let stopped = 0
  let toolCalls = 0
  let tokens = 0
  let first = Infinity
  let last = -Infinity
  for (const run of runs) {
    if (isLiveSubagentRun(run)) live += 1
    else if (run.status === 'error') failed += 1
    else if (run.status === 'cancelled') stopped += 1
    else done += 1
    toolCalls += Math.max(0, Math.floor(run.toolCalls ?? 0))
    tokens += subagentRunTokens(run) ?? 0
    first = Math.min(first, run.startedAt)
    if (typeof run.endedAt === 'number') last = Math.max(last, run.endedAt)
  }
  const ended = runs.length > 0 && live === 0
  return {
    total: runs.length,
    live,
    failed,
    done,
    stopped,
    toolCalls,
    tokens,
    spanMs: ended && Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : null,
    ended
  }
}

export function subagentListOpen(stored: boolean | undefined, totals: Pick<SubagentListTotals, 'ended'>): boolean {
  return stored ?? !totals.ended
}

export function subagentListSlice<T extends { id: string }>(
  ordered: readonly T[],
  showAll: boolean,
  selectedId: string | null,
  max = SUBAGENT_LIST_SHOWN
): { shown: T[]; hidden: number } {
  if (ordered.length <= max) return { shown: [...ordered], hidden: 0 }
  const selectedAt = selectedId === null ? -1 : ordered.findIndex((item) => item.id === selectedId)
  if (showAll || selectedAt >= max) return { shown: [...ordered], hidden: 0 }
  return { shown: ordered.slice(0, max), hidden: ordered.length - max }
}

export function subagentNeighbor(ids: readonly string[], id: string, step: 1 | -1): string | null {
  const at = ids.indexOf(id)
  if (at < 0) return null
  return ids[at + step] ?? null
}

export function subagentRowFocusTarget(key: string, index: number, count: number): number | null {
  if (key === 'ArrowDown') return index < count - 1 ? index + 1 : null
  if (key === 'ArrowUp') return index > 0 ? index - 1 : null
  if (key === 'Home') return index > 0 ? 0 : null
  if (key === 'End') return index < count - 1 ? count - 1 : null
  return null
}

export function subagentSiblings(runs: readonly SubagentRun[], run: SubagentRun): SubagentRun[] {
  return runs.filter((item) =>
    item.parentSessionId === run.parentSessionId &&
    item.review !== 'merged' &&
    item.review !== 'discarded' &&
    (run.parentRunId ? item.parentRunId === run.parentRunId : !!run.parentMessageId && item.parentMessageId === run.parentMessageId)
  )
}

export function subagentSessionPeers(runs: readonly SubagentRun[], run: SubagentRun): SubagentRun[] {
  return orderSubagentRuns(runs.filter((item) => {
    if (item.id === run.id) return true
    return !!run.parentSessionId && item.parentSessionId === run.parentSessionId && isLiveSubagentRun(item) && item.review !== 'merged' && item.review !== 'discarded'
  }))
}

const GROUPS_LIMIT = 400

interface SubagentGroupsState {
  byRun: Record<string, readonly string[]>
  publish: (ids: readonly string[]) => void
}

export const useSubagentGroups = create<SubagentGroupsState>((set, get) => ({
  byRun: {},
  publish: (ids) => {
    if (!ids.length) return
    const current = get().byRun
    const signature = ids.join('\n')
    if (ids.every((id) => current[id]?.join('\n') === signature)) return
    const group = [...ids]
    const next: Record<string, readonly string[]> = {}
    const kept = Object.keys(current).filter((id) => !group.includes(id)).slice(-Math.max(0, GROUPS_LIMIT - group.length))
    for (const id of kept) next[id] = current[id]
    for (const id of group) next[id] = group
    set({ byRun: next })
  }
}))
