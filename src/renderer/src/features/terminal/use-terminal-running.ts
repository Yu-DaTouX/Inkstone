import { useEffect, useState } from 'react'
import { resourceOwner } from '../../state/resource-owners'
import { ownerTerminalRunning, type TerminalRunningEntry } from './terminal-running'

export function useTerminalRunning(ownerKey: string | null, enabled: boolean): boolean {
  const [running, setRunning] = useState(false)
  useEffect(() => {
    const yan = typeof window === 'undefined' ? undefined : window.yan
    if (!ownerKey || !enabled || !yan?.terminal) {
      setRunning(false)
      return undefined
    }
    let alive = true
    const entries = new Map<string, TerminalRunningEntry>()
    const recompute = (): void => {
      if (alive) setRunning(ownerTerminalRunning(entries.values(), ownerKey, resourceOwner))
    }
    const reload = (): void => {
      yan.terminal
        .list()
        .then((list) => {
          entries.clear()
          for (const item of list) entries.set(item.id, { id: item.id, owner: item.owner, alive: item.alive, status: item.status })
          recompute()
        })
        .catch(() => recompute())
    }
    reload()
    const off = yan.onPush((message) => {
      if (message.ch !== 'terminal' || message.payload.kind === 'data') return
      const entry = entries.get(message.payload.id)
      if (!entry) {
        reload()
        return
      }
      if (message.payload.kind === 'exit') entries.set(entry.id, { ...entry, alive: false })
      else entries.set(entry.id, { ...entry, status: message.payload.status })
      recompute()
    })
    return () => {
      alive = false
      off()
    }
  }, [ownerKey, enabled])
  return running
}
