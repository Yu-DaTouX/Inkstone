import { useSyncExternalStore } from 'react'

const LINGER_MS = 1500

const active = new Map<string, string>()
const lingering = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
let snapshot: ReadonlyMap<string, string> = new Map()
const seen = new Set<string>()
let seenSnapshot: ReadonlySet<string> = new Set()

function publish(): void {
  snapshot = new Map(active)
  seenSnapshot = new Set(seen)
  for (const listener of listeners) listener()
}

export function noteTerminalAgent(id: string, phase: 'start' | 'end', action: string): void {
  const timer = lingering.get(id)
  if (timer) {
    clearTimeout(timer)
    lingering.delete(id)
  }
  if (phase === 'start') {
    seen.add(id)
    active.set(id, action)
    publish()
    return
  }
  if (!active.has(id)) return
  lingering.set(
    id,
    setTimeout(() => {
      lingering.delete(id)
      active.delete(id)
      publish()
    }, LINGER_MS)
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function current(): ReadonlyMap<string, string> {
  return snapshot
}

export function useTerminalAgentActivity(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, current, current)
}

function currentSeen(): ReadonlySet<string> {
  return seenSnapshot
}

export function useTerminalAgentSeen(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, currentSeen, currentSeen)
}
