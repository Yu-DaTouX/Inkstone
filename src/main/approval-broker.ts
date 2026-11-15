import { randomUUID } from 'node:crypto'
import {
  APPROVAL_HOLD_MAX_MS,
  isApprovalChoice,
  normalizeApprovalFeedback,
  type ApprovalAnswer,
  type ApprovalOwner,
  type ApprovalRequest,
  type ApprovalSnapshot
} from '../shared/approval'
import { ApprovalLedger, sameOwner, type ApprovalAnswerIdentity } from './approval-ledger'
import { ApprovalSessionGrants } from './approval-session-grants'

export const APPROVAL_TIMEOUT_MS = 4 * 60 * 1000
export const APPROVAL_REVIEW_WAIT_MS = 2 * 60 * 1000

export type ApprovalOutcome = ApprovalAnswer | 'timeout' | null

interface Waiter {
  resolve: (answer: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

export interface ApprovalBrokerDeps {
  canAsk(): boolean
  open(request: ApprovalRequest): void
  close(id: string): void
  update?(request: ApprovalRequest): void
  review?(request: ApprovalRequest): void
  reviewDone?(id: string): void
  publish?(snapshot: ApprovalSnapshot): void
  record?(request: ApprovalRequest, answer: ApprovalAnswer): void
}

export type ApprovalAskInput = Omit<ApprovalRequest, 'id' | 'createdAt' | 'revision' | 'phase'>

function scopeOf(request: Pick<ApprovalRequest, 'runId' | 'subagentId'>): string | undefined {
  if (request.subagentId) return `subagent:${request.subagentId}`
  return request.runId ? `run:${request.runId}` : undefined
}

export class ApprovalBroker {
  private readonly ledger = new ApprovalLedger()
  private readonly waiters = new Map<string, Waiter>()
  private readonly grants = new ApprovalSessionGrants()
  private readonly reviews = new Map<string, { request: ApprovalRequest; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly deps: ApprovalBrokerDeps) {}

  async ask(input: ApprovalAskInput, signal?: AbortSignal): Promise<ApprovalAnswer | null> {
    const outcome = await this.open(input, signal)
    return outcome === 'timeout' ? null : outcome
  }

  askTimed(input: ApprovalAskInput, timeoutMs: number, signal?: AbortSignal): Promise<ApprovalOutcome> {
    return this.open(input, signal, timeoutMs)
  }

  hold(id: string, identity?: ApprovalAnswerIdentity): boolean {
    const waiter = this.waiters.get(id)
    const pending = this.ledger.get(id)
    if (!waiter || !pending) return false
    if (identity?.owner && !sameOwner(identity.owner, pending.owner)) return false
    const held = this.ledger.hold(id, Date.now() + APPROVAL_HOLD_MAX_MS)
    if (!held) return false
    clearTimeout(waiter.timer)
    waiter.timer = setTimeout(() => this.expire(id), APPROVAL_HOLD_MAX_MS)
    this.deps.update?.(held)
    this.publish()
    return true
  }

  private open(input: ApprovalAskInput, signal?: AbortSignal, timeoutMs?: number): Promise<ApprovalOutcome> {
    if (signal?.aborted || !this.deps.canAsk()) return Promise.resolve(null)
    const scope = scopeOf(input)
    if (this.ledger.isCurrent(scope, input.owner) && this.grants.allows(scope, input)) return Promise.resolve({ choice: 'once' })
    const createdAt = Date.now()
    const request = this.ledger.add({ ...input, id: randomUUID(), createdAt, ...(timeoutMs ? { expiresAt: createdAt + timeoutMs } : {}) }, scope)
    if (!request) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = timeoutMs
        ? setTimeout(() => this.expire(request.id), timeoutMs)
        : setTimeout(() => this.settle(request.id, null), APPROVAL_TIMEOUT_MS)
      const onAbort = signal ? () => { this.settle(request.id, null) } : undefined
      this.waiters.set(request.id, { resolve, timer, signal, onAbort })
      if (onAbort) signal?.addEventListener('abort', onAbort, { once: true })
      this.deps.open(request)
      this.publish()
    })
  }

  answer(id: string, choice: unknown, identity?: ApprovalAnswerIdentity, feedback?: unknown): boolean {
    if (!isApprovalChoice(choice)) return false
    const begun = this.ledger.begin(id, identity)
    if (!begun.ok) {
      if (begun.reason === 'stale') this.settle(id, null)
      return false
    }
    this.publish()
    if (choice === 'session') this.grants.grant(scopeOf(begun.request), begun.request)
    const reason = choice === 'deny' ? normalizeApprovalFeedback(feedback) : undefined
    const settled = this.settle(id, choice === 'session' ? { choice: 'once' } : reason ? { choice, feedback: reason } : { choice })
    if (settled) this.record(begun.request, reason ? { choice, feedback: reason } : { choice })
    return settled
  }

  cancel(match: (request: ApprovalRequest) => boolean): number {
    this.endReviews(match)
    return this.settleAll(this.ledger.expire(match))
  }

  cancelRun(runId: string, owner: ApprovalOwner): number {
    const current = this.ledger.isCurrent(`run:${runId}`, owner)
    return this.cancel((pending) => pending.runId === runId && !pending.subagentId && (pending.owner ? sameOwner(pending.owner, owner) : current))
  }

  activate(runId: string, owner: ApprovalOwner): number {
    this.grants.clearOtherOwners(`run:${runId}`, owner)
    this.endReviews((request) => request.runId === runId && !request.subagentId && !!request.owner && !sameOwner(request.owner, owner))
    return this.settleAll(this.ledger.activate(`run:${runId}`, owner))
  }

  retire(runId: string, owner?: ApprovalOwner): number {
    this.grants.clear(`run:${runId}`, owner)
    this.endReviews((request) => request.runId === runId && !request.subagentId && (!owner || sameOwner(request.owner, owner)))
    return this.settleAll(this.ledger.retire(`run:${runId}`, owner))
  }

  reviewed(toolCallId: string, subagentId?: string): boolean {
    const found = [...this.reviews.values()].find(({ request }) => request.toolCallId === toolCallId && (request.subagentId ?? '') === (subagentId ?? ''))
    if (!found) return false
    this.endReview(found.request.id)
    return true
  }

  reviewing(): ApprovalRequest[] {
    return [...this.reviews.values()].map(({ request }) => request)
  }

  forgetSubagent(subagentId: string): void {
    this.grants.clear(`subagent:${subagentId}`)
  }

  list(): ApprovalRequest[] {
    return this.ledger.pending()
  }

  snapshot(): ApprovalSnapshot {
    return this.ledger.snapshot()
  }

  private expire(id: string): void {
    const request = this.ledger.get(id)
    if (request?.phase === 'pending' && request.onTimeout === 'review' && request.toolCallId && this.waiters.has(id)) {
      const shown: ApprovalRequest = { ...request, held: false }
      this.reviews.set(id, { request: shown, timer: setTimeout(() => this.endReview(id), APPROVAL_REVIEW_WAIT_MS) })
      this.deps.review?.(shown)
    }
    this.settle(id, 'timeout')
  }

  private endReview(id: string): void {
    const entry = this.reviews.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.reviews.delete(id)
    this.deps.reviewDone?.(id)
  }

  private endReviews(match: (request: ApprovalRequest) => boolean): void {
    for (const { request } of [...this.reviews.values()]) if (match(request)) this.endReview(request.id)
  }

  private settleAll(ids: string[]): number {
    let settled = 0
    for (const id of ids) if (this.settle(id, null)) settled += 1
    return settled
  }

  private settle(id: string, answer: ApprovalOutcome): boolean {
    const waiter = this.waiters.get(id)
    if (!this.ledger.finish(id) || !waiter) return false
    this.waiters.delete(id)
    clearTimeout(waiter.timer)
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
    this.deps.close(id)
    this.publish()
    waiter.resolve(answer)
    return true
  }

  private record(request: ApprovalRequest, answer: ApprovalAnswer): void {
    try {
      this.deps.record?.(request, answer)
    } catch (error) {
      console.warn('[approval] 记录审批决定失败：', error instanceof Error ? error.message : error)
    }
  }

  private publish(): void {
    this.deps.publish?.(this.ledger.snapshot())
  }
}
