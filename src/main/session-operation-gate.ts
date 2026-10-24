export type SessionOperation = 'send' | 'compact' | 'fork' | 'rewind' | 'reload'

export interface SessionOperationLease {
  readonly op: SessionOperation
  readonly token: number
  readonly generation: number | undefined
}

export type SessionOperationAdmission =
  | { ok: true; lease: SessionOperationLease }
  | { ok: false; error: string; holder: SessionOperation }

interface Hold extends SessionOperationLease {
  unknown: boolean
}

const CONFLICTS: Record<SessionOperation, readonly SessionOperation[]> = {
  send: ['fork', 'rewind', 'reload'],
  compact: ['compact', 'fork', 'rewind', 'reload'],
  fork: ['send', 'compact', 'fork', 'rewind', 'reload'],
  rewind: ['send', 'compact', 'fork', 'rewind', 'reload'],
  reload: ['send', 'compact', 'fork', 'rewind', 'reload']
}

const LABELS: Record<SessionOperation, string> = {
  send: '发送',
  compact: '压缩',
  fork: '分叉',
  rewind: '回退',
  reload: '重新加载工具'
}

export function sessionOperationBusyError(op: SessionOperation, holder: SessionOperation): string {
  return `会话正在${LABELS[holder]}，暂不能${LABELS[op]}，请稍后再试`
}

export const GENERATION_MISMATCH_ERROR = '会话运行实例已更换，这次操作针对的是旧实例，已拒绝'

export function generationMatches(expected: number | undefined, current: number | undefined): boolean {
  return expected === undefined || expected === current
}

export class SessionOperationGate {
  private seq = 0
  private readonly holds = new Map<number, Hold>()

  acquire(op: SessionOperation, generation?: number): SessionOperationAdmission {
    const blocking = [...this.holds.values()].find((hold) => CONFLICTS[op].includes(hold.op))
    if (blocking) return { ok: false, error: sessionOperationBusyError(op, blocking.op), holder: blocking.op }
    const lease: Hold = { op, token: ++this.seq, generation, unknown: false }
    this.holds.set(lease.token, lease)
    return { ok: true, lease: { op, token: lease.token, generation } }
  }

  release(lease: SessionOperationLease): boolean {
    const hold = this.holds.get(lease.token)
    if (!hold || hold.unknown) return false
    this.holds.delete(lease.token)
    return true
  }

  markUnknown(lease: SessionOperationLease): boolean {
    const hold = this.holds.get(lease.token)
    if (!hold) return false
    hold.unknown = true
    return true
  }

  settle(op: SessionOperation): number {
    let released = 0
    for (const [token, hold] of this.holds) {
      if (hold.op !== op || !hold.unknown) continue
      this.holds.delete(token)
      released += 1
    }
    return released
  }

  reset(): void {
    this.holds.clear()
  }

  busy(): SessionOperation[] {
    return [...new Set([...this.holds.values()].map((hold) => hold.op))]
  }

  async run<T>(
    op: SessionOperation,
    generation: number | undefined,
    task: (lease: SessionOperationLease) => Promise<T>,
    busy: (error: string) => T
  ): Promise<T> {
    const admission = this.acquire(op, generation)
    if (!admission.ok) return busy(admission.error)
    try {
      return await task(admission.lease)
    } finally {
      this.release(admission.lease)
    }
  }
}
