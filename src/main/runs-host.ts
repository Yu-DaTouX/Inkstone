import { createRunPipeline, type RunContext, type RunError, type RunPipeline } from './runs'
import { runSignalFromDangerConfirmation, runSignalFromUiResolved, signalsFromPiEvent } from './runs/pi-events'
import { subagentRunContext, type SubagentRunIdentity } from './runs/subagent'
import { type RunSignal, type RunModel, type RunSnapshot } from '../shared/runs'
import type { MainPush } from '../shared/ipc'
import type { ApprovalRequest } from '../shared/approval'
import type { RunObserver, RunObserverContext } from './agent'
import { YAN_DIR } from './paths'
import { pick } from '../shared/ui-lang'

export interface RunsSnapshot {
  revision: number
  runs: RunSnapshot[]
}

export interface RunsHost {
  observerFor(options?: { generation?: number }): RunObserver
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
            message: pick('会话编号连续分配失败，运行状态不会显示；重新打开该会话后会再试', 'Session numbering failed repeatedly; run status will not show. Reopen the session to retry')
          }
        })
      }
    )
  }

  const clock = (): number => options.now?.() ?? Date.now()

  const feed = (ctx: RunContext, signal: RunSignal): void => {
    if (disposed || !isUsableSessionId(ctx.sessionId)) return
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
      await pipeline.dispose()
    }
  }
}
