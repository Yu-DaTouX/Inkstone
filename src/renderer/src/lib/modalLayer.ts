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

export function useModalCount(): number {
  const [count, setCount] = useState(() => stack.length)
  useEffect(() => {
    const f = (): void => setCount(stack.length)
    subs.add(f)
    f()
    return () => {
      subs.delete(f)
    }
  }, [])
  return count
}
