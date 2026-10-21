import { createRunPipeline, type RunContext, type RunError, type RunPipeline } from './runs'
import { runSignalFromDangerConfirmation, runSignalFromUiResolved, signalsFromPiEvent } from './runs/pi-events'
import { subagentRunContext, type SubagentRunIdentity } from './runs/subagent'
import {
  normalizeScheduledOrigin,
  scheduledRunContext,
  ScheduledOriginTable,
  type ScheduledContextSeed,
  type ScheduledOrigin
} from './runs/scheduled-origin'
import { isTerminalPhase, type RunSignal, type RunModel, type RunSnapshot } from '../shared/runs'
import type { MainPush } from '../shared/ipc'
import type { ApprovalRequest } from '../shared/approval'
import type { RunObserver, RunObserverContext } from './agent'
import { YAN_DIR } from './paths'

export interface RunsSnapshot {
  revision: number
  runs: RunSnapshot[]
}

export interface ScheduledRunInput {
  scopeId: string
  sessionId: string
  sessionPath?: string
  title?: string
  model?: RunModel
  generation?: number
}

export interface ScheduledRunHandle {
  scopeId: string
  runId: string
  code: string
  context: RunContext
}

export interface RunsHost {
  observerFor(options?: { generation?: number }): RunObserver
  bindScheduledOrigin(input: { scopeId?: string; sessionId?: string; generation?: number }): void
  clearScheduledOrigin(input: { sessionId?: string; generation?: number }): void
  openScheduled(input: ScheduledRunInput): Promise<ScheduledRunHandle>
  failScheduled(handle: ScheduledRunHandle, message: string): void
  cancelScheduled(handle: ScheduledRunHandle): void
  observeSubagentEvent(run: SubagentRunIdentity, evt: Record<string, unknown>): void
  settleSubagent(run: SubagentRunIdentity, outcome: 'done' | 'failed' | 'stopped', message?: string): void
  snapshot(): RunsSnapshot
  markSeen(runId: string): { ok: boolean }
  observeApproval(request: ApprovalRequest): void
  resolveApproval(id: string): void
  dispose(): Promise<void>
}

export interface RunsHostOptions {
  root?: string
  push: (msg: MainPush) => void
  now?: () => number
  newRunId?: () => string
}

const MAX_PENDING_SIGNALS = 2_000
const CODE_RETRY_DELAYS_MS = [1_000, 5_000, 30_000]
const TERMINAL_SIGNALS: ReadonlySet<RunSignal['type']> = new Set<RunSignal['type']>(['agent-settled', 'stopped', 'host-fail', 'pi-exit'])

type CodeState = { state: 'pending' | 'ready' | 'failed'; attempts: number; timer?: NodeJS.Timeout }

function isUsableSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && !sessionId.startsWith('pending:')
}

interface ScheduledEntry {
  origin: ScheduledOrigin
  scopeId: string
  sessionId: string
  runId: string
  code: string
  context: RunContext
}

export async function createRunsHost(options: RunsHostOptions): Promise<RunsHost> {
  let revision = 0
  let disposed = false

  const log = (text: string): void => {
    options.push({ ch: 'log', payload: { text: `[runs] ${text}`, level: 'error' } })
  }

  const pipeline: RunPipeline = await createRunPipeline({
    root: options.root ?? YAN_DIR,
    ...(options.now ? { now: options.now } : {}),
    ...(options.newRunId ? { newRunId: options.newRunId } : {}),
    publish: (payload) => {
      revision += 1
      options.push({
        ch: 'runs',
        payload: { revision, upsert: payload.upsert, remove: payload.remove }
      })
    },
    onError: (error: RunError) => log(`${error.code}：${error.message}`)
  })

  const codeState = new Map<string, CodeState>()
  const buffered = new Map<string, { ctx: RunContext; signal: RunSignal }[]>()
  const pendingApprovals = new Map<string, RunContext>()
  const openedSubagents = new Map<string, number>()

  const codeKeyOf = (ctx: RunContext): string =>
    ctx.kind === 'subagent' ? (ctx.parentSessionId ?? '') : ctx.sessionId

  const toContext = (ctx: RunObserverContext, generation?: number): RunContext => ({
    sessionId: ctx.sessionId,
    ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
    ...(ctx.title ? { title: ctx.title } : {}),
    ...(ctx.model ? { model: ctx.model as RunModel } : {}),
    ...(generation !== undefined ? { generation } : {})
  })

  const observe = (ctx: RunContext, signal: RunSignal): void => {
    try {
      pipeline.registry.observe(ctx, signal)
    } catch (error) {
      log(`运行信号处理失败（${signal.type}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const drain = (sessionId: string): void => {
    const queue = buffered.get(sessionId)
    buffered.delete(sessionId)
    if (!queue) return
    for (const item of queue) {
      if (disposed) return
      observe(item.ctx, item.signal)
    }
  }

  const ensureCode = (sessionId: string, attempt = 0): void => {
    if (codeState.get(sessionId)?.state === 'pending') return
    codeState.set(sessionId, { state: 'pending', attempts: attempt })
    void pipeline.codes.assign(sessionId, 'session').then(
      () => {
        if (disposed) return
        codeState.set(sessionId, { state: 'ready', attempts: attempt })
        drain(sessionId)
      },
      (error: unknown) => {
        if (disposed) return
        const attempts = attempt + 1
        const delay = CODE_RETRY_DELAYS_MS[attempt]
        const reason = error instanceof Error ? error.message : String(error)
        if (delay !== undefined) {
          const timer = setTimeout(() => {
            if (codeState.get(sessionId)?.timer !== timer) return
            codeState.delete(sessionId)
            ensureCode(sessionId, attempts)
          }, delay)
          timer.unref?.()
          codeState.set(sessionId, { state: 'pending', attempts, timer })
          log(`会话编号分配失败，${Math.round(delay / 1000)} 秒后重试：${sessionId}（${reason}）`)
          return
        }
        codeState.set(sessionId, { state: 'failed', attempts })
        buffered.delete(sessionId)
        log(`会话编号分配连续失败，运行不会登记：${sessionId}（${reason}）`)
        options.push({
          ch: 'notify',
          payload: {
            id: `runs-code-${sessionId}-${clock()}`,
            method: 'notify',
            notifyType: 'warning',
            message: '会话编号连续分配失败，运行状态不会显示；重新打开该会话后会再试'
          }
        })
      }
    )
  }

  const scheduledOrigins = new ScheduledOriginTable()
  const scheduledEntries = new Map<string, ScheduledEntry>()
  const scheduledOpening = new Map<string, Promise<ScheduledEntry | null>>()
  const scheduledQueues = new Map<string, { ctx: RunContext; signal: RunSignal }[]>()
  const scheduledClosed = new Set<string>()

  const clock = (): number => options.now?.() ?? Date.now()
  const scheduledKeyOf = (origin: ScheduledOrigin, sessionId: string): string => `${origin.scopeId}\u0000${sessionId}`

  const finalizeScheduled = (entry: ScheduledEntry): void => {
    scheduledEntries.delete(scheduledKeyOf(entry.origin, entry.sessionId))
    scheduledClosed.add(entry.sessionId)
  }

  const observeScheduledEntry = (entry: ScheduledEntry, ctx: RunContext, signal: RunSignal): void => {
    const merged: RunContext = {
      ...entry.context,
      ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
      ...(ctx.title ? { title: ctx.title } : {}),
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.projectId ? { projectId: ctx.projectId } : {})
    }
    try {
      pipeline.registry.observe(merged, signal)
    } catch (error) {
      log(`定时运行信号处理失败（${signal.type}）：${error instanceof Error ? error.message : String(error)}`)
    }
    const snapshot = pipeline.registry.get(entry.runId)
    if (snapshot && isTerminalPhase(snapshot.phase)) finalizeScheduled(entry)
  }

  const ensureScheduledEntry = (origin: ScheduledOrigin, seed: ScheduledContextSeed): Promise<ScheduledEntry | null> => {
    const key = scheduledKeyOf(origin, seed.sessionId)
    const existing = scheduledEntries.get(key)
    if (existing) return Promise.resolve(existing)
    const opening = scheduledOpening.get(key)
    if (opening) return opening
    const promise = (async (): Promise<ScheduledEntry | null> => {
      let code: string
      try {
        code = await pipeline.codes.assign(origin.scopeId, 'scheduled')
      } catch (error) {
        log(`定时编号分配失败，运行不会登记：${origin.scopeId}（${error instanceof Error ? error.message : String(error)}）`)
        return null
      }
      if (disposed) return null
      const context = scheduledRunContext(seed, origin, { code })
      const snapshot = pipeline.registry.open(context, { kind: 'queued', since: clock(), reason: 'scheduled' })
      if (!snapshot) return null
      const entry: ScheduledEntry = {
        origin,
        scopeId: origin.scopeId,
        sessionId: seed.sessionId,
        runId: snapshot.runId,
        code,
        context: { ...context, runId: snapshot.runId }
      }
      scheduledEntries.set(key, entry)
      return entry
    })()
    scheduledOpening.set(key, promise)
    void promise
      .finally(() => {
        if (scheduledOpening.get(key) === promise) scheduledOpening.delete(key)
      })
      .catch(() => undefined)
    return promise
  }

  const feedScheduled = (ctx: RunContext, origin: ScheduledOrigin, signal: RunSignal): void => {
    if (scheduledClosed.has(ctx.sessionId)) return
    const key = scheduledKeyOf(origin, ctx.sessionId)
    const entry = scheduledEntries.get(key)
    if (entry) {
      const queue = scheduledQueues.get(key)
      if (queue) {
        if (queue.length < MAX_PENDING_SIGNALS) queue.push({ ctx, signal })
        return
      }
      observeScheduledEntry(entry, ctx, signal)
      return
    }
    let queue = scheduledQueues.get(key)
    if (!queue) {
      queue = []
      scheduledQueues.set(key, queue)
      void ensureScheduledEntry(origin, {
        sessionId: ctx.sessionId,
        ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
        ...(ctx.title ? { title: ctx.title } : {}),
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(ctx.generation !== undefined ? { generation: ctx.generation } : {})
      })
        .then((created) => {
          const pending = scheduledQueues.get(key)
          scheduledQueues.delete(key)
          if (!created || !pending) return
          for (const item of pending) {
            if (disposed) return
            observeScheduledEntry(created, item.ctx, item.signal)
          }
        })
        .catch(() => {
          scheduledQueues.delete(key)
        })
    }
    if (queue.length < MAX_PENDING_SIGNALS) queue.push({ ctx, signal })
  }

  const feed = (ctx: RunContext, signal: RunSignal): void => {
    if (disposed || !isUsableSessionId(ctx.sessionId)) return
    if (ctx.kind === 'subagent' && ctx.parentSessionId) {
      const parentOrigin = scheduledOrigins.resolve({ sessionId: ctx.parentSessionId })
      if (parentOrigin) {
        if (!scheduledClosed.has(ctx.parentSessionId)) observe(ctx, signal)
        return
      }
    }
    const origin = scheduledOrigins.resolve({
      sessionId: ctx.sessionId,
      ...(ctx.generation !== undefined ? { generation: ctx.generation } : {})
    })
    if (origin) {
      feedScheduled(ctx, origin, signal)
      return
    }
    const key = codeKeyOf(ctx)
    if (!key) return
    const entry = codeState.get(key)
    if (entry?.state === 'ready') {
      observe(ctx, signal)
      return
    }
    if (entry?.state === 'failed') return
    if (!entry) ensureCode(key)
    const queue = buffered.get(key)
    if (!queue) {
      buffered.set(key, [{ ctx, signal }])
      return
    }
    if (queue.length >= MAX_PENDING_SIGNALS && !TERMINAL_SIGNALS.has(signal.type)) return
    queue.push({ ctx, signal })
  }

  const bindScheduledOrigin = (input: { scopeId?: string; sessionId?: string; generation?: number }): void => {
    const origin = normalizeScheduledOrigin(input.scopeId)
    if (!origin) return
    scheduledOrigins.bind(origin, {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {})
    })
    if (input.sessionId) scheduledClosed.delete(input.sessionId)
  }

  const clearScheduledOrigin = (key: { sessionId?: string; generation?: number }): void => {
    scheduledOrigins.clear({
      ...(key.sessionId ? { sessionId: key.sessionId } : {}),
      ...(key.generation !== undefined ? { generation: key.generation } : {})
    })
    if (key.sessionId) scheduledClosed.delete(key.sessionId)
  }

  const closeScheduled = (handle: ScheduledRunHandle, signal: RunSignal): void => {
    const entry = [...scheduledEntries.values()].find((item) => item.runId === handle.runId)
    if (!entry) return
    try {
      pipeline.registry.observe(entry.context, signal)
    } catch (error) {
      log(`定时运行收口失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const snapshot = pipeline.registry.get(entry.runId)
    if (snapshot && isTerminalPhase(snapshot.phase)) finalizeScheduled(entry)
  }

  const activeParentRunId = (parentSessionId: string): string | undefined =>
    pipeline.registry.activeRunIdFor(parentSessionId)

  return {
    observerFor(observerOptions = {}) {
      return (ctx, signal) => feed(toContext(ctx, observerOptions.generation), signal)
    },
    observeSubagentEvent(run, evt) {
      if (disposed) return
      const parentRunId = run.parentSessionId ? activeParentRunId(run.parentSessionId) : undefined
      const ctx = subagentRunContext(run, parentRunId ? { parentRunId } : {})
      if (!ctx) return
      const activation = run.activeSince ?? 0
      if (openedSubagents.get(run.id) !== activation) {
        openedSubagents.set(run.id, activation)
        feed(ctx, { type: 'agent-start' })
      }
      const signals = signalsFromPiEvent(evt, options.now?.() ?? Date.now())
      for (const signal of signals) feed(ctx, signal)
    },
    settleSubagent(run, outcome, message) {
      if (disposed || !openedSubagents.has(run.id)) return
      const ctx = subagentRunContext(run)
      if (!ctx) return
      const signal: RunSignal =
        outcome === 'done'
          ? { type: 'agent-settled', aborted: false }
          : outcome === 'stopped'
            ? { type: 'stopped', by: 'user' }
            : { type: 'host-fail', message: message ?? '\u5b50 Agent \u8fd0\u884c\u5931\u8d25' }
      feed(ctx, signal)
    },
    snapshot() {
      pipeline.publisher?.flush()
      return { revision, runs: pipeline.registry.list() }
    },
    markSeen(runId) {
      const ok = pipeline.registry.get(runId) !== undefined
      pipeline.registry.markSeen(runId)
      return { ok }
    },
    bindScheduledOrigin(input) {
      bindScheduledOrigin(input)
    },
    clearScheduledOrigin(input) {
      clearScheduledOrigin(input)
    },
    async openScheduled(input) {
      if (disposed) throw new Error('运行注册表已关闭')
      const origin = normalizeScheduledOrigin(input.scopeId)
      if (!origin) throw new Error('定时运行缺少任务 id')
      if (!input.sessionId) throw new Error('定时运行缺少会话 id')
      bindScheduledOrigin({
        scopeId: origin.scopeId,
        sessionId: input.sessionId,
        ...(input.generation !== undefined ? { generation: input.generation } : {})
      })
      const entry = await ensureScheduledEntry(origin, {
        sessionId: input.sessionId,
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.generation !== undefined ? { generation: input.generation } : {})
      })
      if (!entry) throw new Error('定时运行无法登记（编号分配失败）')
      return { scopeId: entry.scopeId, runId: entry.runId, code: entry.code, context: entry.context }
    },
    failScheduled(handle, message) {
      closeScheduled(handle, { type: 'host-fail', message })
    },
    cancelScheduled(handle) {
      closeScheduled(handle, { type: 'stopped', by: 'host' })
    },
    observeApproval(request) {
      if (disposed || !request.sessionId) return
      const ctx: RunContext = { sessionId: request.sessionId }
      pendingApprovals.set(request.id, ctx)
      const risky = request.kind === 'danger' || request.kind === 'outside' || request.kind === 'delete'
      feed(ctx, risky
        ? runSignalFromDangerConfirmation({ id: request.id, summary: request.title })
        : { type: 'needs-you', request: { id: request.id, type: 'confirm', summary: request.title } })
    },
    resolveApproval(id) {
      const ctx = pendingApprovals.get(id)
      if (!ctx) return
      pendingApprovals.delete(id)
      feed(ctx, runSignalFromUiResolved(id))
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const entry of codeState.values()) if (entry.timer) clearTimeout(entry.timer)
      codeState.clear()
      buffered.clear()
      pendingApprovals.clear()
      openedSubagents.clear()
      scheduledOrigins.reset()
      scheduledEntries.clear()
      scheduledOpening.clear()
      scheduledQueues.clear()
      scheduledClosed.clear()
      await pipeline.dispose()
    }
  }
}
