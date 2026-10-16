/**
 * 运行状态模型（v3 WP-10）。
 *
 * 全应用只有这一套运行状态词汇：侧栏状态点、提醒条、运行总览、托盘、任务栏、
 * 手机端都读同一份快照。这里**只做纯计算** —— 类型、`reduceRun`、`detectStall`、
 * 排序与阈值；持久化、IPC、推送合并都在 `src/main/runs/`。
 *
 * 关键约定（方案 03 §2）：
 *   · 运行实例 ID 每轮一个（`runId`）；`code` 是会话级稳定编号（S/T/R）。
 *   · `agent_end` **不**结束运行：自动重试、压缩恢复、队列继续都可能跟在后面，
 *     只有 `agent_settled` 才是终态依据。
 *   · `agent_settled.aborted=true` 默认是用户停止；流式循环防护必须先标记原因
 *     （`loop-abort`），否则那次中止会被误认成「用户停止」。
 *   · 停滞只是**可见信号**，绝不自动停止任何东西（阈值判定见 `detectStall`）。
 *
 * ── 内部状态与发布快照 ──
 * `reduceRun` 操作 `RunState`，它比发布的 `RunSnapshot` 多几个本地簿记字段
 * （最后事件时刻、修订号、待答请求列表、等待前的活动）。发布一律经
 * `snapshotOf()` 构造白名单对象，避免把簿记字段漏给渲染端。
 */

export type RunKind = 'session' | 'subagent' | 'scheduled' | 'review'
export type StallCause = 'no-output' | 'tool-silent' | 'retry' | 'rate-limit' | 'loop'
export type FailCause = 'model-error' | 'pi-exit' | 'tool-fatal' | 'host'
export type RunActivity = 'waiting-model' | 'thinking' | 'streaming' | 'tool' | 'compacting' | 'subagent'
export type RunRequestType = 'danger' | 'select' | 'confirm' | 'input' | 'editor'

export interface RunModel {
  provider: string
  id: string
  label: string
  thinking?: string
}

export interface RunRequest {
  id: string
  type: RunRequestType
  summary: string
  since: number
}

export interface RunRetry {
  attempt: number
  max: number
  resumeAt?: number
}

export type RunPhase =
  | { kind: 'queued'; since: number; reason: 'followup' | 'concurrency' | 'scheduled'; at?: number }
  | { kind: 'running'; since: number; activity: RunActivity; tool?: { name: string; label: string; callId: string } }
  | { kind: 'needs-you'; since: number; request: { id: string; type: RunRequestType; summary: string } }
  | { kind: 'stalled'; since: number; cause: StallCause; detail?: string; retry?: RunRetry }
  | { kind: 'failed'; at: number; cause: FailCause; errorKind?: string; message: string; seen: boolean }
  | { kind: 'stopped'; at: number; by: 'user' | 'host' }
  | { kind: 'done'; at: number; seen: boolean }

export interface RunCounts {
  tools: number
  edits: number
  errors: number
}

export interface RunSnapshot {
  /** 运行实例 ID（每轮一个） */
  runId: string
  /** 显示编号：S12 / S12·1 / T03 / R04（会话级稳定） */
  code: string
  kind: RunKind
  sessionId: string
  sessionPath?: string
  projectId?: string
  /** 子 Agent 的父运行 */
  parentRunId?: string
  /** 会话标题 */
  title: string
  model?: RunModel
  startedAt: number
  phase: RunPhase
  context?: { used: number | null; window: number; percent: number | null }
  costUsd?: number
  counts: RunCounts
}

/** 停滞判定阈值；设置里可在 30 秒–5 分钟之间调整。 */
export interface StallThresholds {
  /** 等待模型响应：发出请求后多久没有任何输出事件 */
  noOutputMs: number
  /** 工具无输出：工具执行中多久没有更新事件 */
  toolSilentMs: number
}

export const STALL_MIN_MS = 30_000
export const STALL_MAX_MS = 5 * 60_000
export const DEFAULT_STALL_THRESHOLDS: StallThresholds = { noOutputMs: 45_000, toolSilentMs: 60_000 }

/** 等待用户答复前的停顿原因，答复完要还原到它，而不是一律当成「运行中」。 */
export interface StallResume {
  cause: StallCause
  detail?: string
  retry?: RunRetry
}

/**
 * reducer 的内部状态。发布前经 `snapshotOf()`；其余字段只属主进程。
 *
 * 为什么不直接扩展 `RunSnapshot`：快照是要推给渲染端的白名单对象，
 * 把簿记字段混进去迟早会被别的消费者误用。
 */
export interface RunState extends RunSnapshot {
  /** 最后一次事件时刻（停滞判定的唯一依据） */
  lastEventAt: number
  /** 单调递增；registry 用它丢弃旧事件、判断是否需要推送 */
  revision: number
  /** 是否已经收到过 agent_start：运行中的 followUp 排队不再改变运行阶段 */
  started: boolean
  /** 仍在等待用户答复的请求（按到达顺序，可同时存在多个） */
  requests: RunRequest[]
  /** 进入等用户前的活动，答复后恢复 */
  activityBeforeWait: RunActivity
  /** 进入等用户前是否处于停滞（自动重试 / 重复输出） */
  stallBeforeWait?: StallResume
  /** 已观察到、但还没确定「不再重试」的模型错误；agent_settled 用它区分失败与完成 */
  pendingError?: { message: string; errorKind?: string }
  /** 流式循环防护已标记：随后的 aborted 不能当用户停止 */
  loopAbortMarked: boolean
}

export interface RunInit {
  runId: string
  code: string
  kind: RunKind
  sessionId: string
  sessionPath?: string
  projectId?: string
  parentRunId?: string
  title?: string
  model?: RunModel
  phase?: RunPhase
}

/**
 * 规范化输入事件（由主进程 `src/main/runs/pi-events.ts` 从 pi 原始事件映射）。
 *
 * reducer 不直接吃 pi 的原始对象：这里每一个信号都有确定语义，纯函数测试
 * 才能逐行覆盖 03 §2.3 的事件表，pi 升级换字段时也只需要改映射层。
 */
export type RunSignal =
  | { type: 'queued'; reason: 'followup' | 'concurrency' | 'scheduled'; at?: number }
  | { type: 'agent-start' }
  | { type: 'activity'; activity: Extract<RunActivity, 'waiting-model' | 'thinking' | 'streaming'> }
  | { type: 'tool-start'; tool: { name: string; label?: string; callId: string }; isWrite?: boolean }
  | { type: 'tool-update' }
  | { type: 'tool-end'; callId?: string; isError?: boolean; isWrite?: boolean }
  | { type: 'compaction-start' }
  | { type: 'compaction-end' }
  | { type: 'retry-start'; attempt: number; max: number; resumeAt?: number; detail?: string }
  | { type: 'retry-end'; success: boolean; errorKind?: string; message?: string }
  | { type: 'rate-limit'; detail?: string; retry?: RunRetry }
  | { type: 'loop-abort'; detail?: string }
  | { type: 'loop-resume' }
  | { type: 'needs-you'; request: { id: string; type: RunRequestType; summary: string } }
  | { type: 'request-answered'; requestId?: string }
  | { type: 'model-error'; message: string; errorKind?: string; retrying?: boolean }
  | { type: 'error-observed'; message: string; errorKind?: string }
  | { type: 'tool-fatal'; message: string }
  | { type: 'host-fail'; message: string }
  | { type: 'agent-end'; willRetry?: boolean }
  | { type: 'agent-settled'; aborted: boolean }
  | { type: 'stopped'; by: 'user' | 'host' }
  | { type: 'pi-exit'; code?: number | null; signal?: string | null }
  | { type: 'seen' }
  | { type: 'context'; used: number | null; window: number; percent?: number | null }
  | { type: 'title'; title: string }
  | { type: 'model'; model: RunModel }
  | { type: 'cost'; usd: number }
  | { type: 'stall-detected'; cause: StallCause; detail?: string }

const TERMINAL_KINDS: ReadonlySet<RunPhase['kind']> = new Set(['failed', 'stopped', 'done'])

export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL_KINDS.has(phase.kind)
}

/** 需要「立即推送」的状态类变化：进入等你确认 / 失败 / 完成 / 停止。 */
export function isImmediatePhase(phase: RunPhase): boolean {
  return phase.kind === 'needs-you' || phase.kind === 'failed' || phase.kind === 'done' || phase.kind === 'stopped'
}

/** 需要用户注意的状态（提醒条、总览排序用）。 */
export function isAttentionPhase(phase: RunPhase): boolean {
  return phase.kind === 'needs-you' || phase.kind === 'stalled' || phase.kind === 'failed'
}

/**
 * 子 Agent 的显示编号：父会话编号加 `·n`。
 *
 * `n` 从 1 起，由注册表按同一父会话下子运行的首次出现顺序分配；
 * 编号只用于显示，不写进 pi 会话文件。
 */
export function formatChildCode(parentCode: string, n: number): string {
  return `${parentCode}·${n}`
}

export function createRunState(init: RunInit, now: number): RunState {
  const phase: RunPhase = init.phase ?? { kind: 'running', since: now, activity: 'waiting-model' }
  return {
    runId: init.runId,
    code: init.code,
    kind: init.kind,
    sessionId: init.sessionId,
    ...(init.sessionPath ? { sessionPath: init.sessionPath } : {}),
    ...(init.projectId ? { projectId: init.projectId } : {}),
    ...(init.parentRunId ? { parentRunId: init.parentRunId } : {}),
    title: init.title ?? '',
    ...(init.model ? { model: init.model } : {}),
    startedAt: now,
    phase,
    counts: { tools: 0, edits: 0, errors: 0 },
    lastEventAt: now,
    revision: 0,
    started: false,
    requests: [],
    activityBeforeWait: 'waiting-model',
    loopAbortMarked: false
  }
}

/** 构造对外发布的快照（白名单，剥离主进程簿记字段）。 */
export function snapshotOf(state: RunState): RunSnapshot {
  return {
    runId: state.runId,
    code: state.code,
    kind: state.kind,
    sessionId: state.sessionId,
    ...(state.sessionPath ? { sessionPath: state.sessionPath } : {}),
    ...(state.projectId ? { projectId: state.projectId } : {}),
    ...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
    title: state.title,
    ...(state.model ? { model: state.model } : {}),
    startedAt: state.startedAt,
    phase: state.phase,
    ...(state.context ? { context: state.context } : {}),
    ...(state.costUsd !== undefined ? { costUsd: state.costUsd } : {}),
    counts: state.counts
  }
}

function requestOf(request: RunRequest): { id: string; type: RunRequestType; summary: string } {
  return { id: request.id, type: request.type, summary: request.summary }
}

/** 所有改动都走这里：更新最后事件时刻并推进修订号。 */
function touch(state: RunState, now: number, patch: Partial<RunState> = {}): RunState {
  return { ...state, lastEventAt: now, revision: state.revision + 1, ...patch }
}

function withPhase(state: RunState, now: number, phase: RunPhase, patch: Partial<RunState> = {}): RunState {
  return { ...state, phase, lastEventAt: now, revision: state.revision + 1, ...patch }
}

function fail(state: RunState, now: number, cause: FailCause, message: string, errorKind?: string): RunState {
  return {
    ...state,
    phase: { kind: 'failed', at: now, cause, ...(errorKind ? { errorKind } : {}), message, seen: false },
    lastEventAt: now,
    revision: state.revision + 1,
    requests: [],
    stallBeforeWait: undefined,
    pendingError: undefined
  }
}

/**
 * 纯函数：把一条信号应用到运行状态，返回新状态。
 *
 * 终态后的事件一律忽略（防旧事件覆盖新状态）。返回原对象表示「没有变化」，
 * 调用方据此跳过推送。
 */
export function reduceRun(state: RunState, signal: RunSignal, now: number): RunState {
  if (signal.type === 'seen') {
    const phase = state.phase
    if ((phase.kind === 'done' || phase.kind === 'failed') && !phase.seen) {
      return { ...state, phase: { ...phase, seen: true } }
    }
    return state
  }
  /* 终态是运行实例的终点：迟到的工具 / 消息事件不得把它翻回运行中。 */
  if (isTerminalPhase(state.phase)) return state

  switch (signal.type) {
    case 'queued': {
      /* 运行中的 followUp 只影响输入框队列，不改运行阶段；未开始的才进入排队。 */
      if (state.started) return touch(state, now)
      const phase: RunPhase = {
        kind: 'queued',
        since: state.phase.kind === 'queued' ? state.phase.since : now,
        reason: signal.reason,
        ...(signal.at !== undefined
          ? { at: signal.at }
          : state.phase.kind === 'queued' && state.phase.at !== undefined
            ? { at: state.phase.at }
            : {})
      }
      return withPhase(state, now, phase)
    }

    case 'agent-start': {
      const phase: RunPhase =
        state.requests.length > 0
          ? { kind: 'needs-you', since: state.requests[0].since, request: requestOf(state.requests[0]) }
          : { kind: 'running', since: now, activity: 'waiting-model' }
      return withPhase(state, now, phase, { started: true, loopAbortMarked: false, activityBeforeWait: 'waiting-model' })
    }

    case 'activity': {
      if (state.phase.kind === 'needs-you') return touch(state, now, { activityBeforeWait: signal.activity })
      const stalled = state.phase.kind === 'stalled'
      if (stalled || state.phase.kind === 'queued') {
        const since = state.phase.kind === 'running' ? state.phase.since : now
        return withPhase(state, now, { kind: 'running', since, activity: signal.activity }, { activityBeforeWait: signal.activity })
      }
      if (state.phase.kind === 'running') {
        if (state.phase.activity === signal.activity && state.phase.tool === undefined) return touch(state, now)
        return withPhase(state, now, { kind: 'running', since: state.phase.since, activity: signal.activity }, { activityBeforeWait: signal.activity })
      }
      return touch(state, now, { activityBeforeWait: signal.activity })
    }

    case 'tool-start': {
      const tool = { name: signal.tool.name, label: signal.tool.label ?? signal.tool.name, callId: signal.tool.callId }
      const counts = { ...state.counts, tools: state.counts.tools + 1 }
      if (state.phase.kind === 'needs-you') return touch(state, now, { counts, activityBeforeWait: 'tool' })
      const since = state.phase.kind === 'running' ? state.phase.since : now
      return withPhase(state, now, { kind: 'running', since, activity: 'tool', tool }, { counts, activityBeforeWait: 'tool' })
    }

    case 'tool-update':
      /* 高频事件：只刷新停滞计时，不改阶段（也不推新快照）。 */
      return touch(state, now)

    case 'tool-end': {
      const counts = {
        tools: state.counts.tools,
        edits: state.counts.edits + (signal.isWrite ? 1 : 0),
        errors: state.counts.errors + (signal.isError ? 1 : 0)
      }
      if (state.phase.kind === 'running' && state.phase.activity === 'tool') {
        return withPhase(state, now, { kind: 'running', since: state.phase.since, activity: 'waiting-model' }, { counts })
      }
      if (state.phase.kind === 'stalled' && state.phase.cause === 'tool-silent') {
        return withPhase(state, now, { kind: 'running', since: now, activity: 'waiting-model' }, { counts })
      }
      return touch(state, now, { counts })
    }

    case 'compaction-start': {
      if (state.phase.kind === 'needs-you') return touch(state, now, { activityBeforeWait: 'compacting' })
      const since = state.phase.kind === 'running' ? state.phase.since : now
      return withPhase(state, now, { kind: 'running', since, activity: 'compacting' }, { activityBeforeWait: 'compacting' })
    }

    case 'compaction-end': {
      if (state.phase.kind === 'needs-you') return touch(state, now, { activityBeforeWait: 'waiting-model' })
      const since = state.phase.kind === 'running' ? state.phase.since : now
      return withPhase(state, now, { kind: 'running', since, activity: 'waiting-model' }, { activityBeforeWait: 'waiting-model' })
    }

    case 'retry-start':
      return withPhase(
        state,
        now,
        {
          kind: 'stalled',
          since: now,
          cause: 'retry',
          retry: { attempt: signal.attempt, max: signal.max, ...(signal.resumeAt !== undefined ? { resumeAt: signal.resumeAt } : {}) },
          ...(signal.detail ? { detail: signal.detail } : {})
        },
        { pendingError: undefined }
      )

    case 'retry-end':
      if (signal.success) return withPhase(state, now, { kind: 'running', since: now, activity: 'waiting-model' }, { pendingError: undefined })
      return fail(state, now, 'model-error', state.pendingError?.message ?? signal.message ?? '自动重试失败，本轮结束', state.pendingError?.errorKind ?? signal.errorKind)

    case 'rate-limit':
      return withPhase(state, now, {
        kind: 'stalled',
        since: now,
        cause: 'rate-limit',
        ...(signal.detail ? { detail: signal.detail } : {}),
        ...(signal.retry ? { retry: signal.retry } : {})
      })

    case 'loop-abort':
      return withPhase(
        state,
        now,
        { kind: 'stalled', since: now, cause: 'loop', ...(signal.detail ? { detail: signal.detail } : {}) },
        { loopAbortMarked: true }
      )

    case 'loop-resume':
      return withPhase(state, now, { kind: 'running', since: now, activity: 'waiting-model' }, { loopAbortMarked: false })

    case 'needs-you': {
      if (state.requests.some((r) => r.id === signal.request.id)) return touch(state, now)
      const request: RunRequest = { id: signal.request.id, type: signal.request.type, summary: signal.request.summary, since: now }
      const requests = [...state.requests, request]
      const activityBeforeWait = state.phase.kind === 'running' ? state.phase.activity : state.activityBeforeWait
      const stallBeforeWait: StallResume | undefined =
        state.phase.kind === 'stalled'
          ? { cause: state.phase.cause, ...(state.phase.detail ? { detail: state.phase.detail } : {}), ...(state.phase.retry ? { retry: state.phase.retry } : {}) }
          : state.stallBeforeWait
      return withPhase(state, now, { kind: 'needs-you', since: requests[0].since, request: requestOf(requests[0]) }, { requests, activityBeforeWait, stallBeforeWait })
    }

    case 'request-answered': {
      if (state.requests.length === 0) return touch(state, now)
      const requests = signal.requestId ? state.requests.filter((r) => r.id !== signal.requestId) : state.requests.slice(1)
      if (requests.length === state.requests.length) return touch(state, now)
      if (requests.length > 0) {
        return withPhase(state, now, { kind: 'needs-you', since: requests[0].since, request: requestOf(requests[0]) }, { requests })
      }
      if (state.stallBeforeWait) {
        const resume = state.stallBeforeWait
        return withPhase(
          state,
          now,
          { kind: 'stalled', since: now, cause: resume.cause, ...(resume.detail ? { detail: resume.detail } : {}), ...(resume.retry ? { retry: resume.retry } : {}) },
          { requests, stallBeforeWait: undefined }
        )
      }
      return withPhase(state, now, { kind: 'running', since: now, activity: state.activityBeforeWait }, { requests, stallBeforeWait: undefined })
    }

    case 'model-error':
      if (signal.retrying) return withPhase(state, now, { kind: 'stalled', since: now, cause: 'retry' })
      return fail(state, now, 'model-error', signal.message, signal.errorKind)

    case 'error-observed':
      /* 只登记，不结束：pi 可能接着发 auto_retry_start；终局在 retry-end / agent_settled。 */
      return touch(state, now, { pendingError: { message: signal.message, ...(signal.errorKind ? { errorKind: signal.errorKind } : {}) } })

    case 'tool-fatal':
      return fail(state, now, 'tool-fatal', signal.message)

    case 'host-fail':
      return fail(state, now, 'host', signal.message)

    case 'agent-end':
      /* agent_end 之后仍可能有重试 / 压缩恢复 / 队列继续；不在这里结束。 */
      return touch(state, now)

    case 'agent-settled': {
      if (signal.aborted) {
        if (state.loopAbortMarked) {
          return withPhase(
            state,
            now,
            { kind: 'stalled', since: now, cause: 'loop', detail: '重复输出被中止，不再自动续接' },
            { loopAbortMarked: false }
          )
        }
        return withPhase(state, now, { kind: 'stopped', at: now, by: 'user' }, { requests: [], stallBeforeWait: undefined, pendingError: undefined })
      }
      if (state.requests.length > 0) return touch(state, now)
      /* 观察到过错误、又没进重试 → 这一轮是失败，不能显示成「已完成」。 */
      if (state.pendingError) return fail(state, now, 'model-error', state.pendingError.message, state.pendingError.errorKind)
      return withPhase(state, now, { kind: 'done', at: now, seen: false }, { stallBeforeWait: undefined })
    }

    case 'stopped':
      return withPhase(state, now, { kind: 'stopped', at: now, by: signal.by }, { requests: [], stallBeforeWait: undefined, pendingError: undefined })

    case 'pi-exit':
      return fail(state, now, 'pi-exit', `pi 进程在运行中退出（code=${signal.code ?? 'null'}）`)

    case 'context': {
      const percent =
        signal.percent !== undefined
          ? signal.percent
          : signal.window > 0 && signal.used !== null
            ? Math.round((signal.used / signal.window) * 100)
            : null
      return touch(state, now, { context: { used: signal.used, window: signal.window, percent } })
    }

    case 'title':
      return touch(state, now, { title: signal.title })

    case 'model':
      return touch(state, now, { model: signal.model })

    case 'cost':
      return touch(state, now, { costUsd: signal.usd })

    case 'stall-detected': {
      if (state.phase.kind !== 'running') return touch(state, now)
      if (state.requests.length > 0) return touch(state, now)
      return withPhase(
        state,
        now,
        { kind: 'stalled', since: now, cause: signal.cause, ...(signal.detail ? { detail: signal.detail } : {}) }
      )
    }

    default:
      return state
  }
}

/** 把阈值夹到允许区间（设置里的 30 秒–5 分钟）。 */
export function normalizeThresholds(input?: Partial<StallThresholds>): StallThresholds {
  const clamp = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return Math.min(STALL_MAX_MS, Math.max(STALL_MIN_MS, Math.round(n)))
  }
  return {
    noOutputMs: clamp(input?.noOutputMs, DEFAULT_STALL_THRESHOLDS.noOutputMs),
    toolSilentMs: clamp(input?.toolSilentMs, DEFAULT_STALL_THRESHOLDS.toolSilentMs)
  }
}

export interface StallDetectOptions {
  /** 被标记为「长时间任务」的命令（前缀匹配），命中则豁免工具无输出判定 */
  exemptTools?: string[]
}

/**
 * 纯函数：判断一条运行中的记录是否应该标记为停滞。
 *
 * 只覆盖「无输出」两类原因；自动重试 / 限流 / 重复输出由 reducer 在对应信号
 * 到达时直接进入 `stalled`。**只返回原因，不做任何停止动作。**
 */
export function detectStall(
  state: RunState,
  now: number,
  thresholds: StallThresholds = DEFAULT_STALL_THRESHOLDS,
  options: StallDetectOptions = {}
): StallCause | null {
  if (state.phase.kind !== 'running') return null
  const elapsed = now - state.lastEventAt
  if (elapsed <= 0) return null
  if (state.phase.activity === 'tool') {
    const tool = state.phase.tool
    const haystacks = [tool?.label, tool?.name].filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (options.exemptTools?.some((prefix) => haystacks.some((text) => text.startsWith(prefix)))) return null
    return elapsed > thresholds.toolSilentMs ? 'tool-silent' : null
  }
  return elapsed > thresholds.noOutputMs ? 'no-output' : null
}

/** 运行总览排序：等你确认 → 停滞 → 失败 → 运行中 → 排队 → 刚完成。 */
export const RUN_PHASE_ORDER: Record<RunPhase['kind'], number> = {
  'needs-you': 0,
  stalled: 1,
  failed: 2,
  running: 3,
  queued: 4,
  done: 5,
  stopped: 6
}

function phaseSince(phase: RunPhase): number {
  if (phase.kind === 'failed' || phase.kind === 'stopped' || phase.kind === 'done') return phase.at
  return phase.since
}

export function compareRuns(a: RunSnapshot, b: RunSnapshot): number {
  const order = RUN_PHASE_ORDER[a.phase.kind] - RUN_PHASE_ORDER[b.phase.kind]
  if (order !== 0) return order
  switch (a.phase.kind) {
    case 'needs-you':
    case 'stalled':
    case 'queued':
      /* 等得最久 / 排队最久的在前 */
      return phaseSince(a.phase) - phaseSince(b.phase)
    case 'failed':
    case 'done':
    case 'stopped':
      /* 最近发生的在前 */
      return phaseSince(b.phase) - phaseSince(a.phase)
    case 'running':
      /* 先开始的在前 */
      return a.startedAt - b.startedAt
    default:
      return a.startedAt - b.startedAt
  }
}
