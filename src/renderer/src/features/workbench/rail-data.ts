import { useEffect, useState } from 'react'
import type { GitChangesResult } from '../../../../shared/git'
import type { UIMessage, UIToolCall } from '../../../../shared/ipc'
import { collectTurnChanges, type TurnFileChange } from '../session/turn-changes'

export interface RailLineTotals {
  added: number
  removed: number
  files: number
}

export function useGitLineTotals(cwd: string | null, enabled: boolean, refreshKey: string): RailLineTotals | null {
  const [totals, setTotals] = useState<RailLineTotals | null>(null)
  useEffect(() => {
    const git = window.yan?.git
    if (!cwd || !enabled || !git) {
      setTotals(null)
      return undefined
    }
    let alive = true
    git
      .changes(cwd)
      .then((result: GitChangesResult) => {
        if (!alive) return
        if (!result.ok || typeof result.added !== 'number' || typeof result.removed !== 'number') {
          setTotals(null)
          return
        }
        setTotals({ added: result.added, removed: result.removed, files: result.files.length })
      })
      .catch(() => {
        if (alive) setTotals(null)
      })
    return () => {
      alive = false
    }
  }, [cwd, enabled, refreshKey])
  return totals
}

export function sessionOutputs(messages: readonly UIMessage[]): TurnFileChange[] {
  const calls: UIToolCall[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue
    calls.push(...message.toolCalls)
  }
  if (calls.length === 0) return []
  return collectTurnChanges(calls)?.files ?? []
}

export function outputName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function outputFolder(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : ''
}
