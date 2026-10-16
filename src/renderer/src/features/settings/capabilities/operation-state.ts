/**
 * 能力设置里的异步操作保护（纯逻辑，无 React / store / DOM）。
 *
 * 面板里的写操作在 await 期间，用户可能切换项目 / 会话，或组件卸载。这里把三件事
 * 收在一处，便于组件与测试共用同一份实现：
 *   · 单操作锁：只有「最近一次发起」的操作能释放 busy；
 *   · 作用域代次：切换项目 / 卸载后，未完成操作的结果不再属于当前上下文；
 *   · 先确认后执行：破坏性操作必须等确认，且确认期间目标身份变化就不执行。
 *
 * 边界：只做顺序与归属判定，不发 IPC、不读主进程令牌，也不改变主进程的授权与落盘
 * 逻辑；真正的写操作仍由主进程按原令牌与授权重新核对。
 */

export interface OperationTicket {
  token: number
  generation: number
}

/**
 * 单操作锁 + 作用域代次。`begin` 递增 token；`invalidateScope` 递增 generation，
 * 用于「项目 / 挂载已变化」，不改变 token（旧操作仍能清自己的锁）。
 */
export interface OperationTracker {
  begin(): OperationTicket
  /** 标记当前作用域（项目 / 挂载）已变化：未完成操作的结果不再适用。 */
  invalidateScope(): void
  /** 该操作仍是最近一次发起的操作（只有它有权释放 busy 锁）。 */
  isCurrent(ticket: OperationTicket): boolean
  /** 该操作发起后作用域没有变过（项目 / 挂载仍是同一个）。 */
  isSameScope(ticket: OperationTicket): boolean
}

export function createOperationTracker(): OperationTracker {
  let token = 0
  let generation = 0
  return {
    begin() {
      token += 1
      return { token, generation }
    },
    invalidateScope() {
      generation += 1
    },
    isCurrent(ticket) {
      return ticket.token === token
    },
    isSameScope(ticket) {
      return ticket.generation === generation
    }
  }
}

export interface GuardedOperationOptions<T> {
  tracker: OperationTracker
  /** 组件是否仍挂载；卸载后不再回写任何状态。 */
  isMounted: () => boolean
  /** 设置 / 清除 busy 锁；true 表示本操作开始，false 表示本操作释放自己的锁。 */
  setBusy: (busy: boolean) => void
  action: () => Promise<T>
  /** 作用域未变时应用结果（可异步，例如刷新列表）。 */
  onResult: (result: T) => void | Promise<void>
  /** 作用域已变：结果不属于当前上下文，只作提示，不冒充当前项目成功。 */
  onStale: (result: T) => void
}

/**
 * 执行一次受保护操作。关键保证：
 *   · busy 锁一定在 finally 释放，且只释放本操作自己的锁 —— 旧操作的 finally
 *     不会解锁之后才发起的新操作；
 *   · await 期间作用域变化时走 onStale，不调用 onResult，不冒充当前项目成功；
 *   · 卸载后不再回写状态（onResult / onStale / setBusy 都不再调用）。
 */
export async function runGuardedOperation<T>(options: GuardedOperationOptions<T>): Promise<void> {
  const ticket = options.tracker.begin()
  options.setBusy(true)
  let result: T
  try {
    result = await options.action()
    if (!options.isMounted()) return
    if (!options.tracker.isSameScope(ticket)) {
      options.onStale(result)
      return
    }
    await options.onResult(result)
  } finally {
    if (options.isMounted() && options.tracker.isCurrent(ticket)) options.setBusy(false)
  }
}

export interface ConfirmedOperationOptions {
  /** 捕获当前目标身份（例如会话 id / 项目键）；每次核对都重新取，不缓存。 */
  captureScope: () => string
  /** 弹确认框；返回 false 表示用户取消。取消不得触发 run。 */
  confirm: () => Promise<boolean>
  isMounted: () => boolean
  /** 确认且目标身份未变后才执行的真实动作（内部才调正式 IPC）。 */
  run: () => Promise<void>
}

export type ConfirmedOperationOutcome =
  | { phase: 'cancelled' }
  | { phase: 'scope-changed' }
  | { phase: 'done' }

/**
 * 「先确认、后执行」的破坏性操作。顺序固定：
 *   captureScope → confirm → 核对挂载与目标身份 → run。
 * 用户取消、或确认期间目标身份（会话 / 项目）变化，都不会执行 run（零 IPC）。
 */
export async function runConfirmedOperation(
  options: ConfirmedOperationOptions
): Promise<ConfirmedOperationOutcome> {
  const before = options.captureScope()
  const accepted = await options.confirm()
  if (!accepted) return { phase: 'cancelled' }
  if (!options.isMounted()) return { phase: 'scope-changed' }
  if (options.captureScope() !== before) return { phase: 'scope-changed' }
  await options.run()
  return { phase: 'done' }
}
