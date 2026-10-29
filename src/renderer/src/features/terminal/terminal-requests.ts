export interface TerminalTabRequest {
  ownerKey: string
  terminalId: string
}

type TerminalTabRequestListener = (request: TerminalTabRequest) => void

const listeners = new Set<TerminalTabRequestListener>()
const pending: TerminalTabRequest[] = []

export function onTerminalTabRequest(listener: TerminalTabRequestListener): () => void {
  listeners.add(listener)
  if (pending.length > 0) {
    const queued = pending.splice(0)
    for (const request of queued) listener(request)
  }
  return () => {
    listeners.delete(listener)
  }
}

export function requestTerminalTab(request: TerminalTabRequest): void {
  if (listeners.size === 0) {
    pending.push(request)
    return
  }
  for (const listener of listeners) listener(request)
}
