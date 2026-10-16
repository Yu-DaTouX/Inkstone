/**
 * 运行总览的纯过滤模型（WP-54）。
 *
 * 项目 / 状态 / 模型 / 类型四个筛选与搜索的定义都在这里：当前运行快照与当天
 * 历史记录各有一个匹配函数，两边共用同一套判据。页面只负责渲染控件与组合，
 * 这里不读 React / DOM / IPC，纯函数便于直接单测。
 *
 * 缺字段的降级规则（历史记录尤其常见）：
 *   · 筛选值为「全部」时，缺字段的记录照常保留；
 *   · 筛选到具体项目 / 模型时，缺该字段的记录一律排除——不猜，也不把历史
 *     记录当成当前活跃运行。
 *   · 历史没有「运行中」，状态筛选里的「运行中」对历史恒为 false。
 */

import type { RunsHistoryRecord } from '../../../../shared/ipc'
import { isTerminalPhase, type RunKind, type RunModel, type RunSnapshot } from '../../../../shared/runs'

/** 状态筛选：全部 / 需要处理 / 运行中 / 已完成 / 已停止。 */
export type RunsStatusFilter = 'all' | 'attention' | 'active' | 'done' | 'stopped'

export const RUNS_STATUS_FILTERS: readonly RunsStatusFilter[] = ['all', 'attention', 'active', 'done', 'stopped']

/** 全部运行类型，顺序与设计规范的会话 / 子 Agent / 定时 / 评审一致。 */
export const RUN_KINDS: readonly RunKind[] = ['session', 'subagent', 'scheduled', 'review']

/** 「不筛选」哨兵值；项目 id / 模型 id / 类型都不会取到这个字符串。 */
export const RUNS_FILTER_ALL = 'all'

export interface RunsFilter {
  status: RunsStatusFilter
  kind: RunKind | typeof RUNS_FILTER_ALL
  /** 具体项目 id，或 {@link RUNS_FILTER_ALL}。 */
  projectId: string
  /** 具体模型 id，或 {@link RUNS_FILTER_ALL}。 */
  modelId: string
  /** 搜索词：编号 / 标题 / 模型；空串表示不过滤。 */
  query: string
}

export const DEFAULT_RUNS_FILTER: RunsFilter = {
  status: 'all',
  kind: RUNS_FILTER_ALL,
  projectId: RUNS_FILTER_ALL,
  modelId: RUNS_FILTER_ALL,
  query: ''
}

/** 终态：完成 / 停止 / 失败。与运行快照同一口径（`phase.kind`）。 */
export function isTerminalRun(run: RunSnapshot): boolean {
  return isTerminalPhase(run.phase)
}

/** 进行中的运行才可停：终态不重复发停止。 */
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
    /* 历史只有终态：不再把旧记录当成「运行中」的当前活跃。 */
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

/**
 * 模型筛选键：模型 id。没有 id 时退回 null（缺字段），不拿 label 冒充 id。
 * 与 `RunsHistoryQuery.filters.model` 的精确匹配口径一致。
 */
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

/** 当前运行快照是否命中全部筛选（状态 + 类型 + 项目 + 模型 + 搜索）。 */
export function matchesLiveFilter(run: RunSnapshot, filter: RunsFilter): boolean {
  if (!statusMatchesLive(run, filter.status)) return false
  if (filter.kind !== RUNS_FILTER_ALL && run.kind !== filter.kind) return false
  if (filter.projectId !== RUNS_FILTER_ALL && run.projectId !== filter.projectId) return false
  if (filter.modelId !== RUNS_FILTER_ALL && modelKey(run.model) !== filter.modelId) return false
  return matchesQuery(liveSearchParts(run), filter.query)
}

/** 当天历史记录是否命中全部筛选；缺字段与「运行中」按上面的降级规则处理。 */
export function matchesHistoryFilter(record: RunsHistoryRecord, filter: RunsFilter): boolean {
  if (!statusMatchesHistory(record, filter.status)) return false
  if (filter.kind !== RUNS_FILTER_ALL && record.kind !== filter.kind) return false
  if (filter.projectId !== RUNS_FILTER_ALL && record.projectId !== filter.projectId) return false
  if (filter.modelId !== RUNS_FILTER_ALL && modelKey(record.model) !== filter.modelId) return false
  return matchesQuery(historySearchParts(record), filter.query)
}

/** 过滤当前运行列表；顺序不变，排序仍由 `sortRuns` 负责。 */
export function filterLiveRuns(runs: readonly RunSnapshot[], filter: RunsFilter): RunSnapshot[] {
  return runs.filter((run) => matchesLiveFilter(run, filter))
}

/** 过滤当天历史记录；时间线与列表两种视图共用同一批结果。 */
export function filterHistoryRecords(
  records: readonly RunsHistoryRecord[],
  filter: RunsFilter
): RunsHistoryRecord[] {
  return records.filter((record) => matchesHistoryFilter(record, filter))
}

/** 筛选控件的选项。`id` 是匹配键，`label` 是显示名，两者都来自真实数据。 */
export interface RunsFilterOption {
  id: string
  label: string
}

/**
 * 项目选项：当前运行与历史里出现过的 `projectId`，显示名优先取正式 settings 的
 * 项目名，取不到就显示 id。没有任何带项目的运行时返回空数组（页面对应控件不画）。
 */
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

/**
 * 模型选项：当前运行与历史里出现过的模型 id，显示名优先取 `label`。
 * 没有任何带模型的运行时返回空数组（页面对应控件不画）。
 */
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

/**
 * 类型选项：数据里真实出现过的运行类型，按 {@link RUN_KINDS} 的正式顺序。
 * 只有一种类型时页面不画该控件（没有可筛的差异）。
 */
export function collectKindOptions(
  runs: readonly RunSnapshot[],
  records: readonly RunsHistoryRecord[]
): RunKind[] {
  const present = new Set<RunKind>()
  for (const run of runs) present.add(run.kind)
  for (const record of records) present.add(record.kind)
  return RUN_KINDS.filter((kind) => present.has(kind))
}

/** 是否有任一筛选 / 搜索生效；页面用它区分「本来就没有」和「被筛掉了」。 */
export function hasActiveFilters(filter: RunsFilter): boolean {
  return (
    filter.status !== 'all' ||
    filter.kind !== RUNS_FILTER_ALL ||
    filter.projectId !== RUNS_FILTER_ALL ||
    filter.modelId !== RUNS_FILTER_ALL ||
    filter.query.trim().length > 0
  )
}

/** 重置为默认（全部 / 全部 / 全部 / 全部 / 空搜索）。 */
export function clearRunsFilter(): RunsFilter {
  return { ...DEFAULT_RUNS_FILTER }
}
