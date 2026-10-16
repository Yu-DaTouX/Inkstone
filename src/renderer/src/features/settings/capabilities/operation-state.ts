export interface OperationTicket {
  token: number
  generation: number
}

export interface OperationTracker {
  begin(): OperationTicket
  invalidateScope(): void
  isCurrent(ticket: OperationTicket): boolean
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
  isMounted: () => boolean
  setBusy: (busy: boolean) => void
  action: () => Promise<T>
  onResult: (result: T) => void | Promise<void>
  onStale: (result: T) => void
}

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
  captureScope: () => string
  confirm: () => Promise<boolean>
  isMounted: () => boolean
  run: () => Promise<void>
}

export type ConfirmedOperationOutcome =
  | { phase: 'cancelled' }
  | { phase: 'scope-changed' }
  | { phase: 'done' }

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
