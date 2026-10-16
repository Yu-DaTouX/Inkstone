import { isTerminalPhase, type RunModel, type RunPhase, type RunSignal, type RunSnapshot } from '../../shared/runs'
import type { RunContext } from '../runs/registry'
import type { ReviewRunRegistryPort } from '../runs-host'
import { signalsFromPiEvent } from '../runs/pi-events'

export function reviewRunScopeId(runId: string): string {
  return `review:${runId}`
}

export function reviewRunModel(label?: string, thinking?: string): RunModel | undefined {
  const text = typeof label === 'string' ? label.trim() : ''
  if (!text) return undefined
  const slash = text.indexOf('/')
  const provider = slash > 0 ? text.slice(0, slash) : ''
  const id = slash > 0 ? text.slice(slash + 1) : text
  return { provider, id, label: text, ...(thinking ? { thinking } : {}) }
}

export interface ReviewRunInput {
  runId: string
  code: string
  sessionPath?: string
  projectId?: string
  title?: string
  model?: RunModel
}

export type ReviewRunOutcome = 'done' | 'failed' | 'stopped'

export interface ReviewRunProducerOptions {
  registry: ReviewRunRegistryPort
  now?: () => number
  onError?: (message: string) => void
}

export interface ReviewRunProducer {
  begin(input: ReviewRunInput): boolean
  observe(runId: string, evt: Record<string, unknown>): void
  settle(runId: string, outcome: ReviewRunOutcome, message?: string): boolean
  isActive(runId: string): boolean
  size(): number
}

export function createReviewRunProducer(options: ReviewRunProducerOptions): ReviewRunProducer {
  const now = (): number => options.now?.() ?? Date.now()
  const entries = new Map<string, RunContext>()

  const dropIfTerminal = (runId: string, snapshot: RunSnapshot | null): void => {
    if (snapshot && isTerminalPhase(snapshot.phase)) entries.delete(runId)
  }

  return {
    begin(input) {
      const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
      const code = typeof input.code === 'string' ? input.code.trim() : ''
      if (!runId || !code) return false
      if (entries.has(runId)) return false
      const ctx: RunContext = {
        runId,
        code,
        kind: 'review',
        sessionId: reviewRunScopeId(runId),
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.model ? { model: input.model } : {})
      }
      const phase: RunPhase = { kind: 'running', since: now(), activity: 'waiting-model' }
      const snapshot = options.registry.open(ctx, phase)
      if (!snapshot) {
        options.onError?.(`评审运行无法登记（${code}）：运行注册表未就绪或已关闭`)
        return false
      }
      entries.set(runId, ctx)
      dropIfTerminal(runId, snapshot)
      return true
    },

    observe(runId, evt) {
      const ctx = entries.get(runId)
      if (!ctx) return
      const signals = signalsFromPiEvent(evt, now())
      for (const signal of signals) {
        const snapshot = options.registry.observe(ctx, signal)
        if (snapshot) dropIfTerminal(runId, snapshot)
        if (!entries.has(runId)) return
      }
    },

    settle(runId, outcome, message) {
      const ctx = entries.get(runId)
      if (!ctx) return false
      const signal: RunSignal =
        outcome === 'done'
          ? { type: 'agent-settled', aborted: false }
          : outcome === 'stopped'
            ? { type: 'stopped', by: 'user' }
            : { type: 'host-fail', message: message ?? '评审运行失败' }
      const snapshot = options.registry.observe(ctx, signal)
      entries.delete(runId)
      return snapshot !== null
    },

    isActive(runId) {
      return entries.has(runId)
    },

    size() {
      return entries.size
    }
  }
}
