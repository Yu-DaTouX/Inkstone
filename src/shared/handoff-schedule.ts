export type SessionWorkAction =
  | 'wait-busy'
  | 'wait-error-retry'
  | 'wait-handoff'
  | 'prefer-handoff'
  | 'continue'

export interface SessionWorkInput {
  busy: boolean
  handoffPending: boolean
  errorRetryPending: boolean
  handoffAllowed: boolean
}

export function decideSessionWork(input: SessionWorkInput): SessionWorkAction {
  if (input.busy) return 'wait-busy'
  if (input.errorRetryPending) return 'wait-error-retry'
  if (input.handoffPending) return 'wait-handoff'
  if (input.handoffAllowed) return 'prefer-handoff'
  return 'continue'
}

export function ownsHandoffOperation(
  currentOperationId: string | null | undefined,
  callbackOperationId: string | null | undefined
): boolean {
  const current = typeof currentOperationId === 'string' && currentOperationId.trim() ? currentOperationId.trim() : null
  const callback = typeof callbackOperationId === 'string' && callbackOperationId.trim() ? callbackOperationId.trim() : null
  if (!callback) return true
  return current !== null && current === callback
}

export function sessionWorkSummary(action: SessionWorkAction): string {
  switch (action) {
    case 'wait-busy':
      return '等待安全边界（实例仍在工作）'
    case 'wait-error-retry':
      return '等待已排的模型错误重试'
    case 'wait-handoff':
      return '交接进行中：冻结源续跑'
    case 'prefer-handoff':
      return '优先尝试交接，不够格才续跑'
    case 'continue':
      return '普通续跑'
  }
}

export class EligibilityRejectLog {
  private readonly seen = new Map<string, string>()

  constructor(private readonly limit = 200) {}

  shouldRecord(runnerId: string, reason: string, count: number): boolean {
    const stamp = `${reason}|${count}`
    if (this.seen.get(runnerId) === stamp) return false
    if (this.seen.size > this.limit) this.seen.clear()
    this.seen.set(runnerId, stamp)
    return true
  }
}
