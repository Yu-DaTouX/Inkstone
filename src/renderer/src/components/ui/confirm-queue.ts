/**
 * 应用内确认框的**队列**（不含 React / DOM）。
 *
 * 为什么单独拆出来：确认框要排队串行处理，而「谁先入队、什么时候结算、
 * 组件卸载时怎么收尾」这些语义可以脱离界面独立验证（见
 * `scripts/test-confirm-queue.mjs`，用真实模块跑，不是源码 regex）。
 *
 * 结算规则（这是可靠交互的关键）：
 * - 每个请求只结算一次，重复调用是空操作；
 * - `cancelScope` 把某个调用方（一个 `useConfirm()` 实例）名下所有未决请求按
 *   **未确认（false）** 结算 —— 组件卸载即走这里，不给未来留下可批准旧操作；
 * - `cancelAll` 把整条队列按 false 结算 —— Provider 卸载或会话切换时用。
 */

export type ConfirmTone = 'normal' | 'danger'

export interface ConfirmOptions {
  /** 一句话说明动作与后果，同时作为对话框的 aria-label */
  title: string
  /** 正文：补充后果、适用范围等 */
  body?: string
  /** 对象（路径、名称、消息片段）：等宽、可换行、可选中复制 */
  detail?: string
  /** 确认按钮文案，默认通用「确认」 */
  confirmLabel?: string
  /** 取消按钮文案，默认通用「取消」 */
  cancelLabel?: string
  tone?: ConfirmTone
}

export interface ConfirmRequest {
  id: number
  options: ConfirmOptions
  /** 发起这个请求的 `useConfirm()` 实例 */
  scope: symbol
  resolve: (value: boolean) => void
}

export interface ConfirmQueue {
  enqueue(options: ConfirmOptions, scope: symbol): Promise<boolean>
  /** 只结算队首之外的请求也安全：按 id 查找 */
  settle(id: number, value: boolean): void
  cancelScope(scope: symbol): void
  cancelAll(): void
  /** 当前队列快照；引用只在变更时替换，可直接给 useSyncExternalStore */
  snapshot(): readonly ConfirmRequest[]
  subscribe(listener: () => void): () => void
}

export function createConfirmQueue(): ConfirmQueue {
  let queue: ConfirmRequest[] = []
  let nextId = 1
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  const replace = (next: ConfirmRequest[]): void => {
    queue = next
    emit()
  }

  return {
    enqueue(options, scope) {
      return new Promise<boolean>((resolve) => {
        replace([...queue, { id: nextId++, options, scope, resolve }])
      })
    },
    settle(id, value) {
      const request = queue.find((item) => item.id === id)
      if (!request) return
      /* 先移出队列再结算：resolve 里若有同步回调用户代码再次入队，不会串到这条 */
      replace(queue.filter((item) => item.id !== id))
      request.resolve(value)
    },
    cancelScope(scope) {
      const victims = queue.filter((item) => item.scope === scope)
      if (!victims.length) return
      replace(queue.filter((item) => item.scope !== scope))
      for (const request of victims) request.resolve(false)
    },
    cancelAll() {
      if (!queue.length) return
      const victims = queue
      replace([])
      for (const request of victims) request.resolve(false)
    },
    snapshot() {
      return queue
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
