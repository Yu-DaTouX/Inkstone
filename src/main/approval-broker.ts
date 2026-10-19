import { randomUUID } from 'node:crypto'
import { isApprovalChoice, type ApprovalChoice, type ApprovalOwner, type ApprovalRequest, type ApprovalSnapshot } from '../shared/approval'
import { ApprovalLedger, type ApprovalAnswerIdentity } from './approval-ledger'

export const APPROVAL_TIMEOUT_MS = 4 * 60 * 1000

interface Waiter {
  resolve: (choice: ApprovalChoice | null) => void
  timer: ReturnType<typeof setTimeout>
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

  constructor(private readonly deps: ApprovalBrokerDeps) {}

  ask(input: ApprovalAskInput): Promise<ApprovalChoice | null> {
    if (!this.deps.canAsk()) return Promise.resolve(null)
    const request = this.ledger.add({ ...input, id: randomUUID(), createdAt: Date.now() }, scopeOf(input))
    if (!request) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(request.id, null), APPROVAL_TIMEOUT_MS)
      this.waiters.set(request.id, { resolve, timer })
      this.deps.open(request)
      this.publish()
    })
  }

  answer(id: string, choice: unknown, identity?: ApprovalAnswerIdentity): boolean {
    if (!isApprovalChoice(choice)) return false
    const begun = this.ledger.begin(id, identity)
    if (!begun.ok) {
      if (begun.reason === 'stale') this.settle(id, null)
      return false
    }
    this.publish()
    return this.settle(id, choice)
  }

  cancel(match: (request: ApprovalRequest) => boolean): number {
    return this.settleAll(this.ledger.expire(match))
  }

  activate(runId: string, owner: ApprovalOwner): number {
    return this.settleAll(this.ledger.activate(`run:${runId}`, owner))
  }

  retire(runId: string, owner?: ApprovalOwner): number {
    return this.settleAll(this.ledger.retire(`run:${runId}`, owner))
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

  private settle(id: string, choice: ApprovalChoice | null): boolean {
    const waiter = this.waiters.get(id)
    if (!this.ledger.finish(id) || !waiter) return false
    this.waiters.delete(id)
    clearTimeout(waiter.timer)
    this.deps.close(id)
    this.publish()
    waiter.resolve(choice)
    return true
  }

  private publish(): void {
    this.deps.publish?.(this.ledger.snapshot())
  }
}
