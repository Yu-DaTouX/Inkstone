import { useEffect, useState } from 'react'

const stack: symbol[] = []
const subs = new Set<() => void>()

let reported = false

function report(): void {
  const paused = stack.length > 0
  if (paused === reported) return
  reported = paused
  try {
    const bridge = window.yan as unknown as { setHotkeyGuard?: (p: boolean) => void } | undefined
    bridge?.setHotkeyGuard?.(paused)
  } catch {
  }
}

function sync(): void {
  report()
  for (const f of subs) f()
}

export function pushModal(token: symbol): void {
  if (stack.includes(token)) return
  stack.push(token)
  sync()
}

export function popModal(token: symbol): void {
  const i = stack.indexOf(token)
  if (i < 0) return
  stack.splice(i, 1)
  sync()
}

export function isModalOpen(): boolean {
  return stack.length > 0
}

export function modalsAbove(token: symbol): number {
  const at = stack.indexOf(token)
  return at < 0 ? 0 : stack.length - at - 1
}

export function useModalsAbove(token: symbol): number {
  const [count, setCount] = useState(() => modalsAbove(token))
  useEffect(() => {
    const f = (): void => setCount(modalsAbove(token))
    subs.add(f)
    f()
    return () => {
      subs.delete(f)
    }
  }, [token])
  return count
}
