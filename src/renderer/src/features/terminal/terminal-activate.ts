type ActivateListener = (ownerKey: string, terminalId: string) => void

const listeners = new Set<ActivateListener>()

export function onActivateTerminal(listener: ActivateListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function activateTerminal(ownerKey: string, terminalId: string): void {
  for (const listener of listeners) listener(ownerKey, terminalId)
}
