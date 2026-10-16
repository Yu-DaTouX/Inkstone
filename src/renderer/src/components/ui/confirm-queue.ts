export type ConfirmTone = 'normal' | 'danger'

export interface ConfirmOptions {
  title: string
  body?: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmTone
}

export interface ConfirmRequest {
  id: number
  options: ConfirmOptions
  scope: symbol
  resolve: (value: boolean) => void
}

export interface ConfirmQueue {
  enqueue(options: ConfirmOptions, scope: symbol): Promise<boolean>
  settle(id: number, value: boolean): void
  cancelScope(scope: symbol): void
  cancelAll(): void
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
