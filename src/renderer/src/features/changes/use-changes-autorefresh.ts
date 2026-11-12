import { useEffect, useRef } from 'react'
import { useStore, type Store } from '../../state/store'
import { createAutoRefreshGate, type AutoRefreshGate } from './autorefresh-gate'

const TAIL = 4

export function toolActivitySignature(s: Pick<Store, 'messages'>): string {
  const messages = s.messages
  const parts: string[] = [String(messages.length)]
  for (let i = Math.max(0, messages.length - TAIL); i < messages.length; i += 1) {
    const message = messages[i]
    if (!message) continue
    if (message.role === 'bash') {
      parts.push(`b:${message.id}:${message.bash?.exitCode ?? ''}`)
      continue
    }
    for (const call of message.toolCalls ?? []) {
      if (call.status === 'ok' || call.status === 'error') parts.push(call.id)
    }
  }
  return parts.join('|')
}

function runningOf(s: Store): boolean {
  return s.session?.isAgentRunning === true || s.session?.isStreaming === true
}

export function useChangesAutoRefresh(visible: boolean, refresh: () => void): void {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const gateRef = useRef<AutoRefreshGate | null>(null)
  gateRef.current ??= createAutoRefreshGate({
    fire: () => refreshRef.current(),
    canFire: () => visibleRef.current && (typeof document === 'undefined' || document.visibilityState !== 'hidden'),
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id)
  })

  useEffect(() => {
    const gate = gateRef.current
    if (!gate) return undefined
    let running = runningOf(useStore.getState())
    let signature = toolActivitySignature(useStore.getState())
    const unsubscribe = useStore.subscribe((s) => {
      const nextRunning = runningOf(s)
      if (running && !nextRunning) {
        running = nextRunning
        signature = toolActivitySignature(s)
        gate.turnEnded()
        return
      }
      running = nextRunning
      const nextSignature = toolActivitySignature(s)
      if (nextSignature === signature) return
      signature = nextSignature
      gate.activity(running)
    })
    const onFocus = (): void => gate.focused()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') gate.focused()
    }
    const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
    const hasDocument = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
    if (hasWindow) window.addEventListener('focus', onFocus)
    if (hasDocument) document.addEventListener('visibilitychange', onVisibility)
    return () => {
      unsubscribe()
      if (hasWindow) window.removeEventListener('focus', onFocus)
      if (hasDocument) document.removeEventListener('visibilitychange', onVisibility)
      gate.dispose()
    }
  }, [])

  useEffect(() => {
    if (visible) gateRef.current?.shown()
  }, [visible])
}
