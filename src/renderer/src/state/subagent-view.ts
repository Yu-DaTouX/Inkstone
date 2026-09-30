/**
 * 子代理运行的选择与归属（实施-11 H-10a）。
 *
 * 一个 run 只有一个 `runId` 身份；「挂回某条助手消息」与「独立任务」只是同一份
 * 数据的两种入口，不能各维护一份列表（否则同一个 run 会出现两份详情）。
 * 归属只认明确字段：`parentSessionId`（或显式的会话链）。旧记录没有归属字段时
 * **不猜**，单独放进 `unattributed`，避免把别的会话的任务显示到当前会话。
 *
 * 纯函数，不碰 Electron，便于单测。
 */
import type { SubagentRun } from '../../../shared/ipc'

export interface SubagentScope {
  /** 当前会话的稳定身份（pi 的 sessionId / conversationId） */
  sessionIds: string[]
}

export interface SubagentGroups {
  /** 有明确 parentSessionId 且属于当前会话、挂回某条助手消息的 */
  attached: SubagentRun[]
  /** 有明确 parentSessionId 且属于当前会话、但独立展示的 */
  detached: SubagentRun[]
  /** 明确不属于当前会话（另一个会话/链）的 */
  foreign: SubagentRun[]
  /** 没有归属字段、无法判断的旧记录 */
  unattributed: SubagentRun[]
  /** attached + detached，按 runId 去重后的全部当前会话任务 */
  all: SubagentRun[]
  running: number
}

/** 按 runId 去重：同一 run 的多次推送只保留最后一份（最后一次状态最新） */
export function dedupeRuns(runs: SubagentRun[]): SubagentRun[] {
  const byId = new Map<string, SubagentRun>()
  for (const run of runs) byId.set(run.id, run)
  return [...byId.values()]
}

function belongsToScope(run: SubagentRun, ids: Set<string>): boolean | null {
  if (!run.parentSessionId) return null
  return ids.has(run.parentSessionId)
}

export function selectSubagentRuns(runs: SubagentRun[], scope: SubagentScope): SubagentGroups {
  const ids = new Set(scope.sessionIds.filter(Boolean))
  const attached: SubagentRun[] = []
  const detached: SubagentRun[] = []
  const foreign: SubagentRun[] = []
  const unattributed: SubagentRun[] = []
  for (const run of dedupeRuns(runs)) {
    const owned = belongsToScope(run, ids)
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

/** 右侧工作台的子代理资源标签身份 */
export function subagentTabId(runId: string): string {
  return `subagent:${runId}`
}

/** 刚结束的子代理在任务分区里保留多久（过后自动退场） */
export const RECENT_DONE_MS = 5 * 60_000

/**
 * 需要在界面上继续露面的当前会话子代理：运行中 / 失败 / 待审阅或有冲突 / 刚完成。
 * 已合并、已放弃、已归档、被用户停止的安静退场。
 */
export function visibleSubagentRuns(runs: SubagentRun[], scope: SubagentScope, now = Date.now()): SubagentRun[] {
  return selectSubagentRuns(runs, scope).all.filter((run) => {
    if (run.status === 'starting' || run.status === 'running' || run.status === 'error') return true
    if (run.review === 'pending' || run.review === 'conflict') return true
    /* 已合并 / 已放弃 / 已归档的即使刚结束也安静退场（与上面的说明一致） */
    if (run.review === 'merged' || run.review === 'discarded' || run.review === 'archived') return false
    return run.status === 'done' && !!run.endedAt && now - run.endedAt < RECENT_DONE_MS
  })
}

/** 分区「是否为空」的探针用：布尔，避免选择器每帧返回新数组 */
export function hasVisibleSubagents(s: { subagents: SubagentRun[]; session?: { sessionId?: string; conversationId?: string } | null }): boolean {
  const sessionIds = [s.session?.sessionId, s.session?.conversationId].filter((v): v is string => !!v)
  return visibleSubagentRuns(s.subagents, { sessionIds }).length > 0
}
