import { randomUUID } from 'node:crypto'
import {
  isApprovalChoice,
  normalizeApprovalFeedback,
  type ApprovalAnswer,
  type ApprovalOwner,
  type ApprovalRequest,
  type ApprovalSnapshot
} from '../shared/approval'
import { ApprovalLedger, type ApprovalAnswerIdentity } from './approval-ledger'
import { ApprovalSessionGrants } from './approval-session-grants'

export const APPROVAL_TIMEOUT_MS = 4 * 60 * 1000

interface Waiter {
  resolve: (answer: ApprovalAnswer | null) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

export interface ApprovalBrokerDeps {
  canAsk(): boolean
  open(request: ApprovalRequest): void
  close(id: string): void
  publish?(snapshot: ApprovalSnapshot): void
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

  constructor(private readonly deps: ApprovalBrokerDeps) {}

  ask(input: ApprovalAskInput, signal?: AbortSignal): Promise<ApprovalAnswer | null> {
    if (signal?.aborted || !this.deps.canAsk()) return Promise.resolve(null)
    const scope = scopeOf(input)
    if (this.ledger.isCurrent(scope, input.owner) && this.grants.allows(scope, input)) return Promise.resolve({ choice: 'once' })
    const request = this.ledger.add({ ...input, id: randomUUID(), createdAt: Date.now() }, scope)
    if (!request) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(request.id, null), APPROVAL_TIMEOUT_MS)
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
    if (choice === 'session') {
      this.grants.grant(scopeOf(begun.request), begun.request)
      return this.settle(id, { choice: 'once' })
    }
    const reason = choice === 'deny' ? normalizeApprovalFeedback(feedback) : undefined
    return this.settle(id, reason ? { choice, feedback: reason } : { choice })
  }

  cancel(match: (request: ApprovalRequest) => boolean): number {
    return this.settleAll(this.ledger.expire(match))
  }

  activate(runId: string, owner: ApprovalOwner): number {
    this.grants.clearOtherOwners(`run:${runId}`, owner)
    return this.settleAll(this.ledger.activate(`run:${runId}`, owner))
  }

  retire(runId: string, owner?: ApprovalOwner): number {
    this.grants.clear(`run:${runId}`, owner)
    return this.settleAll(this.ledger.retire(`run:${runId}`, owner))
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

  private settleAll(ids: string[]): number {
    let settled = 0
    for (const id of ids) if (this.settle(id, null)) settled += 1
    return settled
  }

  private settle(id: string, answer: ApprovalAnswer | null): boolean {
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

  private publish(): void {
    this.deps.publish?.(this.ledger.snapshot())
  }
}
