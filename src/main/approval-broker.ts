import { randomUUID } from 'node:crypto'
import { isApprovalChoice, type ApprovalChoice, type ApprovalRequest } from '../shared/approval'

export const APPROVAL_TIMEOUT_MS = 4 * 60 * 1000

interface Pending {
  request: ApprovalRequest
  resolve: (choice: ApprovalChoice | null) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ApprovalBrokerDeps {
  canAsk(): boolean
  open(request: ApprovalRequest): void
  close(id: string): void
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: ApprovalBrokerDeps) {}

  ask(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): Promise<ApprovalChoice | null> {
    if (!this.deps.canAsk()) return Promise.resolve(null)
    const request: ApprovalRequest = { ...input, id: randomUUID(), createdAt: Date.now() }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(request.id, null), APPROVAL_TIMEOUT_MS)
      this.pending.set(request.id, { request, resolve, timer })
      this.deps.open(request)
    })
  }

  answer(id: string, choice: unknown): boolean {
    if (!isApprovalChoice(choice)) return false
    return this.settle(id, choice)
  }

  cancel(match: (request: ApprovalRequest) => boolean): number {
    const ids = [...this.pending.values()].filter((entry) => match(entry.request)).map((entry) => entry.request.id)
    for (const id of ids) this.settle(id, null)
    return ids.length
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  private settle(id: string, choice: ApprovalChoice | null): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    clearTimeout(entry.timer)
    this.deps.close(id)
    entry.resolve(choice)
    return true
  }
}
