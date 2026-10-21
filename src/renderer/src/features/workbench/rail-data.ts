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
  const requests = requestFilesOf(calls)
  const files = collectTurnChanges(calls)?.files ?? []
  return requests.length ? files.filter((file) => !requests.some((request) => samePathTail(file.path, request))) : files
}

const REQUEST_FILE = /--request-file[=\s]+("[^"]+"|'[^']+'|[^\s;&|]+)/g

function commandText(call: UIToolCall): string {
  const args = call.args as Record<string, unknown> | undefined
  if (!args || typeof args !== 'object') return ''
  return ['command', 'cmd', 'script', 'code'].map((key) => args[key]).filter((value): value is string => typeof value === 'string').join('\n')
}

export function requestFilesOf(calls: readonly UIToolCall[]): string[] {
  const found: string[] = []
  for (const call of calls) {
    for (const match of commandText(call).matchAll(REQUEST_FILE)) found.push(match[1].replace(/^["']|["']$/g, ''))
  }
  return found
}

function normalizedTail(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase()
}

function samePathTail(path: string, request: string): boolean {
  const a = normalizedTail(path)
  const b = normalizedTail(request)
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

export function outputName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function outputFolder(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : ''
}
