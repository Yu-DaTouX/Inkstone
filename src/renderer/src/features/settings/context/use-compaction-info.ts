import { useEffect, useState } from 'react'
import type { CompactionInfo } from '../../../../../shared/ipc'

export function useCompactionInfo(cwd: string, contextWindow: number, refreshKey: unknown): CompactionInfo | null {
  const [info, setInfo] = useState<CompactionInfo | null>(null)
  useEffect(() => {
    if (!cwd || !(contextWindow > 0)) {
      setInfo(null)
      return
    }
    let alive = true
    void window.yan.compactionInfo(cwd, contextWindow).then((next) => {
      if (alive) setInfo(next)
    }).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [cwd, contextWindow, refreshKey])
  return info
}
