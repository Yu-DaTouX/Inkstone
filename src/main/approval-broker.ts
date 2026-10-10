/**
 * 批准请求的中转：宿主要问用户时在这里挂起，等界面答复。
 *
 * 取代原生 `dialog.showMessageBox`：卡片在输入框上方，不打断窗口，也不遮对话。
 * 没有窗口、渲染端没响应或超时都按「没有答复」处理（调用方据此拦下操作），
 * 与原先「关掉对话框 = 拒绝」的失败方向一致。
 */
import { randomUUID } from 'node:crypto'
import { isApprovalChoice, type ApprovalChoice, type ApprovalRequest } from '../shared/approval'

/** 与薄层的确认超时（4 分钟）对齐：超过它薄层已经放弃，卡片也该收起 */
export const APPROVAL_TIMEOUT_MS = 4 * 60 * 1000

interface Pending {
  request: ApprovalRequest
  resolve: (choice: ApprovalChoice | null) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ApprovalBrokerDeps {
  /** 有可用窗口才能问；没有就直接没有答复 */
  canAsk(): boolean
  open(request: ApprovalRequest): void
  close(id: string): void
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: ApprovalBrokerDeps) {}

  /** 发起一条请求并等答复；返回 null = 没有答复（无窗口 / 超时） */
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
