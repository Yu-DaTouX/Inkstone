export type RunKind = 'session' | 'subagent' | 'scheduled'
export type StallCause = 'retry' | 'rate-limit' | 'loop'
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

export interface RunTool {
  name: string
  label: string
  callId: string
}

export type RunPhase =
  | { kind: 'queued'; since: number; reason: 'followup' | 'concurrency' | 'scheduled'; at?: number }
  | { kind: 'running'; since: number; activity: RunActivity; tool?: RunTool }
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
  runId: string
  code: string
  kind: RunKind
  sessionId: string
  sessionPath?: string
  projectId?: string
  parentRunId?: string
  title: string
  model?: RunModel
  startedAt: number
  phase: RunPhase
  context?: { used: number | null; window: number; percent: number | null }
  costUsd?: number
  counts: RunCounts
}

export interface StallResume {
  cause: StallCause
  detail?: string
  retry?: RunRetry
}

export interface RunState extends RunSnapshot {
  lastEventAt: number
  revision: number
  started: boolean
  requests: RunRequest[]
  activityBeforeWait: RunActivity
  activeTools: RunTool[]
  stallBeforeWait?: StallResume
  pendingError?: { message: string; errorKind?: string }
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

const TERMINAL_KINDS: ReadonlySet<RunPhase['kind']> = new Set(['failed', 'stopped', 'done'])

export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL_KINDS.has(phase.kind)
}

export function isImmediatePhase(phase: RunPhase): boolean {
  return phase.kind === 'needs-you' || phase.kind === 'failed' || phase.kind === 'done' || phase.kind === 'stopped'
}

export function isAttentionPhase(phase: RunPhase): boolean {
  return phase.kind === 'needs-you' || phase.kind === 'stalled' || phase.kind === 'failed'
}

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
    activeTools: [],
    loopAbortMarked: false
  }
}

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

export function reduceRun(state: RunState, signal: RunSignal, now: number): RunState {
  if (signal.type === 'seen') {
    const phase = state.phase
    if ((phase.kind === 'done' || phase.kind === 'failed') && !phase.seen) {
      return { ...state, phase: { ...phase, seen: true } }
    }
    return state
  }
  if (isTerminalPhase(state.phase)) return state

  switch (signal.type) {
    case 'queued': {
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
      return withPhase(state, now, phase, { started: true, loopAbortMarked: false, activityBeforeWait: 'waiting-model', activeTools: [] })
    }

    case 'activity': {
      if (state.phase.kind === 'needs-you') return touch(state, now, { activityBeforeWait: signal.activity, activeTools: [] })
      const stalled = state.phase.kind === 'stalled'
      if (stalled || state.phase.kind === 'queued') {
        const since = state.phase.kind === 'running' ? state.phase.since : now
        return withPhase(state, now, { kind: 'running', since, activity: signal.activity }, { activityBeforeWait: signal.activity, activeTools: [] })
      }
      if (state.phase.kind === 'running') {
        if (state.phase.activity === signal.activity && state.phase.tool === undefined && state.activeTools.length === 0) return touch(state, now)
        return withPhase(state, now, { kind: 'running', since: state.phase.since, activity: signal.activity }, { activityBeforeWait: signal.activity, activeTools: [] })
      }
      return touch(state, now, { activityBeforeWait: signal.activity, activeTools: [] })
    }

    case 'tool-start': {
      const tool = { name: signal.tool.name, label: signal.tool.label ?? signal.tool.name, callId: signal.tool.callId }
      const counts = { ...state.counts, tools: state.counts.tools + 1 }
      const activeTools = [...state.activeTools.filter((t) => t.callId !== tool.callId), tool]
      if (state.phase.kind === 'needs-you') return touch(state, now, { counts, activityBeforeWait: 'tool', activeTools })
      const since = state.phase.kind === 'running' ? state.phase.since : now
      return withPhase(state, now, { kind: 'running', since, activity: 'tool', tool }, { counts, activityBeforeWait: 'tool', activeTools })
    }

    case 'tool-update':
      return touch(state, now)

    case 'tool-end': {
      const counts = {
        tools: state.counts.tools,
        edits: state.counts.edits + (signal.isWrite ? 1 : 0),
        errors: state.counts.errors + (signal.isError ? 1 : 0)
      }
      const activeTools = signal.callId ? state.activeTools.filter((t) => t.callId !== signal.callId) : state.activeTools.slice(1)
      const remaining = activeTools[activeTools.length - 1]
      if (state.phase.kind === 'running' && state.phase.activity === 'tool') {
        const since = state.phase.since
        const phase: RunPhase = remaining
          ? { kind: 'running', since, activity: 'tool', tool: remaining }
          : { kind: 'running', since, activity: 'waiting-model' }
        return withPhase(state, now, phase, { counts, activeTools, ...(remaining ? {} : { activityBeforeWait: 'waiting-model' as const }) })
      }
      const settledWait = !remaining && state.activityBeforeWait === 'tool' ? { activityBeforeWait: 'waiting-model' as const } : {}
      return touch(state, now, { counts, activeTools, ...settledWait })
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
      const waitingTool = state.activityBeforeWait === 'tool' ? state.activeTools[state.activeTools.length - 1] : undefined
      return withPhase(
        state,
        now,
        { kind: 'running', since: now, activity: state.activityBeforeWait, ...(waitingTool ? { tool: waitingTool } : {}) },
        { requests, stallBeforeWait: undefined }
      )
    }

    case 'model-error':
      if (signal.retrying) return withPhase(state, now, { kind: 'stalled', since: now, cause: 'retry' })
      return fail(state, now, 'model-error', signal.message, signal.errorKind)

    case 'error-observed':
      return touch(state, now, { pendingError: { message: signal.message, ...(signal.errorKind ? { errorKind: signal.errorKind } : {}) } })

    case 'tool-fatal':
      return fail(state, now, 'tool-fatal', signal.message)

    case 'host-fail':
      return fail(state, now, 'host', signal.message)

    case 'agent-end':
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

    default:
      return state
  }
}

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
      return phaseSince(a.phase) - phaseSince(b.phase)
    case 'failed':
    case 'done':
    case 'stopped':
      return phaseSince(b.phase) - phaseSince(a.phase)
    case 'running':
      return a.startedAt - b.startedAt
    default:
      return a.startedAt - b.startedAt
  }
}
