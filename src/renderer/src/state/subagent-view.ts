/**
 * 子代理运行的选择与归属（实施-11 H-10a）。
 *
 * 一个 run 只有一个 `runId` 身份；「挂回某条助手消息」与「独立任务」只是同一份
 * 数据的两种入口，不能各维护一份列表（否则同一个 run 会出现两份详情）。
 * 归属只认明确字段：`parentSessionId`（或显式的会话链）。旧记录没有归属字段时
 * **不猜**，单独放进 `unattributed`，避免把别的会话的任务显示到当前会话。
 * `scope.runIds` 是唯一例外：只对**没有** `parentSessionId` 的旧记录，按当前显示
 * 视图的运行实例兜底（`parentRunId` 命中），不漏掉在跑的任务；有 `parentSessionId`
 * 时仍以它为准。
 *
 * `subagentScopeForView` 把「屏幕正在显示的会话」折算成这个 scope：peek 优先，
 * 用稳定 sessionId / 路径在 `runners` 里找该视图的实例，**不看 `activeRunnerId`**。
 * 常驻区与右侧面板都走它，避免后台查看 B 时把 active A 的旧任务串进来。
 *
 * 纯函数，不碰 Electron，便于单测。
 */
import { subagentOutcome } from '../../../shared/subagent-outcome'
import type { ExpectedRuntimeOwner, SubagentRun } from '../../../shared/ipc'

export interface SubagentScope {
  /** 当前会话的稳定身份（pi 的 sessionId / conversationId） */
  sessionIds: string[]
  /**
   * 当前显示视图对应的运行实例 id。只用于归属字段缺失的旧记录：没有
   * `parentSessionId` 但 `parentRunId` 命中的，仍算当前视图的任务，避免漏掉
   * 正在跑的子代理；别的缺失归属仍进 `unattributed`，不猜当前会话。
   */
  runIds?: string[]
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

/** 稳定路径比较：统一分隔符、去掉尾斜杠、大小写折叠（与 question-frequency-target 同一口径）。 */
export function normalizeSubagentPath(value?: string): string {
  return (value ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 视图归属推导只看这些稳定字段，调用方从 store 的 `runners` 取。 */
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

/**
 * 从「屏幕正在显示的会话」推导 `SubagentScope`。
 *
 * 与 `split-view.displayedSessionOf` 共用「peek 优先」口径：切换途中的 peek
 * 盖过运行实例当前指向的会话。**不看 `activeRunnerId`** —— 后台查看 B 时 active
 * 仍停在 A，用 active 会把 A 的旧任务串进 B 的列表，也会漏掉 B 挂在自身运行
 * 实例下的旧记录（`parentRunId` 兜底该用 B 的实例）。
 *
 * `conversationId` 只在「显示的就是当前会话」时并入（同一显示 view）；peek
 * 只知道目标会话的 sessionId，拿不到它的 conversationId，不能借用活动会话的。
 */
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

/**
 * 显示视图对应的运行实例：先按稳定 sessionId（`pending:<runId>` 退回 runId），
 * 再按会话路径。两处（列表归属 / 派活归属）共用同一套查找，不各自猜一遍。
 */
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

/**
 * 显示视图 → 派活时要钉住的父运行实例。
 *
 * 有既有实例时给出 `expectedRuntime`（runId + 可核对的 sessionId / generation），
 * 宿主据此严格定位，绝不退回 active；视图有明确身份却找不到实例时返回
 * `needsRunner`，调用方必须明确不派 —— 否则宿主会落到 active（看 B 派到 A）。
 * 身份尚未落定的启动早期（没有 sessionId / 路径 / conversationId）不带 owner，
 * 由宿主在入口同步钉住当前父，兼容正常派活。
 */
export interface SubagentViewOwnership {
  expectedRuntime?: ExpectedRuntimeOwner
  /** 视图有明确身份但没有对应运行实例：不可派活 */
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

/**
 * 输入框上方常驻区用的：当前会话里仍在跑或需要人处理的子代理。
 *
 * 与 `visibleSubagentRuns` 的差别只在「完成」：任务分区允许刚结束的留 5 分钟，
 * 常驻区不占位 —— 正常结束（`done` 无待审阅）与被停止的安静退场，
 * 少一张卡就少一件事；出错、超时、调用用完、待合并与冲突始终留下等人处理。
 * 归属规则复用 `selectSubagentRuns`：`parentSessionId` 优先，缺失时按当前视图的
 * 运行实例（`scope.runIds`）兜底，仍无法判断的不猜当前会话。
 */
export function activeSubagentRuns(runs: SubagentRun[], scope: SubagentScope): SubagentRun[] {
  return selectSubagentRuns(runs, scope).all.filter((run) => {
    const outcome = subagentOutcome(run)
    return outcome.live || outcome.attention
  })
}

/** 分区「是否为空」的探针用：布尔，避免选择器每帧返回新数组 */
export function hasVisibleSubagents(s: { subagents: SubagentRun[]; session?: { sessionId?: string; conversationId?: string } | null }): boolean {
  const sessionIds = [s.session?.sessionId, s.session?.conversationId].filter((v): v is string => !!v)
  return visibleSubagentRuns(s.subagents, { sessionIds }).length > 0
}
