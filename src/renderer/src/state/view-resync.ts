import type { RuntimeEnvelope } from '../../../shared/ipc'
import type { ViewResyncMissing, ViewResyncRequest } from '../../../shared/view-resync'

export interface ViewResyncPolicy {
  firstDelayMs: number
  baseGapMs: number
  maxGapMs: number
  maxAttempts: number
  windowMs: number
  stoppedRetryMs: number
}

export const VIEW_RESYNC_POLICY: ViewResyncPolicy = {
  firstDelayMs: 300,
  baseGapMs: 3000,
  maxGapMs: 30000,
  maxAttempts: 4,
  windowMs: 120000,
  stoppedRetryMs: 120000
}

export type ViewResyncDecision =
  | { kind: 'send'; delayMs: number; attempt: number; retry?: boolean }
  | { kind: 'give-up'; attempt: number }

interface GuardEntry {
  sent: number[]
  stoppedAt?: number
  lastRetry?: number
}

export class ViewResyncGuard {
  private readonly keys = new Map<string, GuardEntry>()

  constructor(private readonly policy: ViewResyncPolicy = VIEW_RESYNC_POLICY) {}

  decide(key: string, now: number): ViewResyncDecision {
    const entry = this.entry(key, now)
    if (entry.stoppedAt !== undefined) {
      const next = (entry.lastRetry ?? entry.stoppedAt) + this.policy.stoppedRetryMs
      return { kind: 'send', delayMs: Math.max(this.policy.firstDelayMs, next - now), attempt: entry.sent.length + 1, retry: true }
    }
    if (entry.sent.length >= this.policy.maxAttempts) {
      entry.stoppedAt = now
      return { kind: 'give-up', attempt: entry.sent.length + 1 }
    }
    const last = entry.sent.at(-1)
    if (last === undefined) return { kind: 'send', delayMs: this.policy.firstDelayMs, attempt: 1 }
    const gap = Math.min(this.policy.maxGapMs, this.policy.baseGapMs * 2 ** (entry.sent.length - 1))
    return { kind: 'send', delayMs: Math.max(this.policy.firstDelayMs, last + gap - now), attempt: entry.sent.length + 1 }
  }

  sent(key: string, now: number): void {
    const entry = this.entry(key, now)
    entry.sent.push(now)
    if (entry.stoppedAt !== undefined) entry.lastRetry = now
  }

  stopped(key: string): boolean {
    return this.keys.get(key)?.stoppedAt !== undefined
  }

  settle(key?: string): void {
    if (key === undefined) this.keys.clear()
    else this.keys.delete(key)
  }

  private entry(key: string, now: number): GuardEntry {
    let entry = this.keys.get(key)
    if (!entry) {
      entry = { sent: [] }
      this.keys.set(key, entry)
    }
    if (entry.stoppedAt === undefined) entry.sent = entry.sent.filter((at) => now - at < this.policy.windowMs)
    return entry
  }
}

export interface ViewResyncNeed {
  reason: string
  runtime?: RuntimeEnvelope
  missing?: ViewResyncMissing[]
}

export interface ViewResyncSchedulerDeps {
  send(request: ViewResyncRequest): void
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  guard?: ViewResyncGuard
}

export interface ViewResyncScheduler {
  request(need: ViewResyncNeed): void
  settle(key?: string): void
  cancel(key: string): void
  reset(): void
}

const MAX_MISSING = 8

export function viewResyncKey(runtime: RuntimeEnvelope | undefined): string {
  if (!runtime) return 'view'
  return runtime.sessionId || `run:${runtime.runId}`
}

function sameMissing(a: ViewResyncMissing, b: ViewResyncMissing): boolean {
  return a.kind === b.kind && a.messageId === b.messageId && a.callId === b.callId
}

function addMissing(into: ViewResyncMissing[], extra: readonly ViewResyncMissing[] | undefined): void {
  for (const item of extra ?? []) {
    if (into.length >= MAX_MISSING) return
    if (!into.some((known) => sameMissing(known, item))) into.push(item)
  }
}

export function createViewResyncScheduler(deps: ViewResyncSchedulerDeps): ViewResyncScheduler {
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const guard = deps.guard ?? new ViewResyncGuard()
  const pending = new Map<string, { request: ViewResyncRequest & { missing: ViewResyncMissing[] }; timer: unknown }>()

  const cancel = (key: string): void => {
    const entry = pending.get(key)
    if (!entry) return
    clearTimer(entry.timer)
    pending.delete(key)
  }

  return {
    request(need) {
      const key = viewResyncKey(need.runtime)
      const queued = pending.get(key)
      if (queued) {
        addMissing(queued.request.missing, need.missing)
        return
      }
      const decision = guard.decide(key, now())
      const missing: ViewResyncMissing[] = []
      addMissing(missing, need.missing)
      const runtime = need.runtime
      const request = {
        reason: need.reason,
        ...(runtime ? { runId: runtime.runId, generation: runtime.generation } : {}),
        ...(runtime?.sessionId ? { sessionId: runtime.sessionId } : {}),
        missing,
        attempt: decision.attempt
      }
      if (decision.kind === 'give-up') {
        deps.send({ ...request, giveUp: true })
        return
      }
      const timer = setTimer(() => {
        if (pending.get(key)?.timer !== timer) return
        pending.delete(key)
        guard.sent(key, now())
        deps.send(request)
      }, decision.delayMs)
      pending.set(key, { request, timer })
    },
    settle(key) {
      guard.settle(key)
    },
    cancel,
    reset() {
      for (const key of [...pending.keys()]) cancel(key)
      guard.settle()
    }
  }
}
