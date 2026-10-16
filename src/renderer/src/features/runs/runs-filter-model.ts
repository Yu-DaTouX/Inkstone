import type { RunsHistoryRecord } from '../../../../shared/ipc'
import { isTerminalPhase, type RunKind, type RunModel, type RunSnapshot } from '../../../../shared/runs'

export type RunsStatusFilter = 'all' | 'attention' | 'active' | 'done' | 'stopped'

export const RUNS_STATUS_FILTERS: readonly RunsStatusFilter[] = ['all', 'attention', 'active', 'done', 'stopped']

export const RUN_KINDS: readonly RunKind[] = ['session', 'subagent', 'scheduled', 'review']

export const RUNS_FILTER_ALL = 'all'

export interface RunsFilter {
  status: RunsStatusFilter
  kind: RunKind | typeof RUNS_FILTER_ALL
  projectId: string
  modelId: string
  query: string
}

export const DEFAULT_RUNS_FILTER: RunsFilter = {
  status: 'all',
  kind: RUNS_FILTER_ALL,
  projectId: RUNS_FILTER_ALL,
  modelId: RUNS_FILTER_ALL,
  query: ''
}

export function isTerminalRun(run: RunSnapshot): boolean {
  return isTerminalPhase(run.phase)
}

export function isStoppableRun(run: RunSnapshot): boolean {
  return !isTerminalPhase(run.phase)
}

function statusMatchesLive(run: RunSnapshot, status: RunsStatusFilter): boolean {
  const kind = run.phase.kind
  switch (status) {
    case 'all':
      return true
    case 'attention':
      return kind === 'needs-you' || kind === 'stalled' || kind === 'failed'
    case 'active':
      return kind === 'queued' || kind === 'running'
    case 'done':
      return kind === 'done'
    case 'stopped':
      return kind === 'stopped'
    default:
      return true
  }
}

function statusMatchesHistory(record: RunsHistoryRecord, status: RunsStatusFilter): boolean {
  switch (status) {
    case 'all':
      return true
    case 'attention':
      return record.terminal === 'failed'
    case 'active':
      return false
    case 'done':
      return record.terminal === 'done'
    case 'stopped':
      return record.terminal === 'stopped'
    default:
      return true
  }
}

export function modelKey(model: RunModel | undefined): string | null {
  const id = model?.id?.trim()
  return id ? id : null
}

function matchesQuery(parts: readonly string[], query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return parts.some((part) => part.toLowerCase().includes(needle))
}

function liveSearchParts(run: RunSnapshot): string[] {
  return [run.code, run.title, run.model?.label ?? '', run.model?.id ?? '']
}

function historySearchParts(record: RunsHistoryRecord): string[] {
  return [record.code, record.title, record.model?.label ?? '', record.model?.id ?? '']
}

export function matchesLiveFilter(run: RunSnapshot, filter: RunsFilter): boolean {
  if (!statusMatchesLive(run, filter.status)) return false
  if (filter.kind !== RUNS_FILTER_ALL && run.kind !== filter.kind) return false
  if (filter.projectId !== RUNS_FILTER_ALL && run.projectId !== filter.projectId) return false
  if (filter.modelId !== RUNS_FILTER_ALL && modelKey(run.model) !== filter.modelId) return false
  return matchesQuery(liveSearchParts(run), filter.query)
}

export function matchesHistoryFilter(record: RunsHistoryRecord, filter: RunsFilter): boolean {
  if (!statusMatchesHistory(record, filter.status)) return false
  if (filter.kind !== RUNS_FILTER_ALL && record.kind !== filter.kind) return false
  if (filter.projectId !== RUNS_FILTER_ALL && record.projectId !== filter.projectId) return false
  if (filter.modelId !== RUNS_FILTER_ALL && modelKey(record.model) !== filter.modelId) return false
  return matchesQuery(historySearchParts(record), filter.query)
}

export function filterLiveRuns(runs: readonly RunSnapshot[], filter: RunsFilter): RunSnapshot[] {
  return runs.filter((run) => matchesLiveFilter(run, filter))
}

export function filterHistoryRecords(
  records: readonly RunsHistoryRecord[],
  filter: RunsFilter
): RunsHistoryRecord[] {
  return records.filter((record) => matchesHistoryFilter(record, filter))
}

export interface RunsFilterOption {
  id: string
  label: string
}

export function collectProjectOptions(
  runs: readonly RunSnapshot[],
  records: readonly RunsHistoryRecord[],
  projects: readonly { id: string; name?: string }[]
): RunsFilterOption[] {
  const names = new Map<string, string>()
  for (const project of projects) {
    const id = project?.id?.trim()
    if (id) names.set(id, project.name?.trim() || id)
  }
  const seen = new Map<string, string>()
  const add = (projectId: string | undefined): void => {
    const id = projectId?.trim()
    if (!id || seen.has(id)) return
    seen.set(id, names.get(id) ?? id)
  }
  for (const run of runs) add(run.projectId)
  for (const record of records) add(record.projectId)
  return [...seen.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function collectModelOptions(
  runs: readonly RunSnapshot[],
  records: readonly RunsHistoryRecord[]
): RunsFilterOption[] {
  const seen = new Map<string, string>()
  const add = (model: RunModel | undefined): void => {
    const id = modelKey(model)
    if (!id || seen.has(id)) return
    seen.set(id, model?.label?.trim() || id)
  }
  for (const run of runs) add(run.model)
  for (const record of records) add(record.model)
  return [...seen.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function collectKindOptions(
  runs: readonly RunSnapshot[],
  records: readonly RunsHistoryRecord[]
): RunKind[] {
  const present = new Set<RunKind>()
  for (const run of runs) present.add(run.kind)
  for (const record of records) present.add(record.kind)
  return RUN_KINDS.filter((kind) => present.has(kind))
}

export function hasActiveFilters(filter: RunsFilter): boolean {
  return (
    filter.status !== 'all' ||
    filter.kind !== RUNS_FILTER_ALL ||
    filter.projectId !== RUNS_FILTER_ALL ||
    filter.modelId !== RUNS_FILTER_ALL ||
    filter.query.trim().length > 0
  )
}

export function clearRunsFilter(): RunsFilter {
  return { ...DEFAULT_RUNS_FILTER }
}
