import { useCallback, useEffect, useState } from 'react'
import type { GitChangeEntry, GitChangesResult, GitPathScreen } from '../../../../shared/git'
import type { UIMessage, UIToolCall } from '../../../../shared/ipc'
import { callPath, collectTurnChanges, isInsideCwd, readFileDiff } from '../session/turn-changes'

export interface RailChangedFile {
  path: string
  added: number | null
  removed: number | null
  untracked: boolean
}

export interface RailLineTotals {
  added: number
  removed: number
  files: number
  entries: RailChangedFile[]
}

function changedFile(entry: GitChangeEntry): RailChangedFile {
  return {
    path: entry.path,
    added: typeof entry.added === 'number' ? entry.added : null,
    removed: typeof entry.removed === 'number' ? entry.removed : null,
    untracked: entry.untracked
  }
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
        setTotals({ added: result.added, removed: result.removed, files: result.files.length, entries: result.files.map(changedFile) })
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

export interface RailOutput {
  path: string
  at: number
}

const SKIP_DIRS = new Set(['.tmp', '.local-docs', 'node_modules', '.git', 'out', 'dist', 'build', 'release'])
const DRAFT_DIRS = new Set(['.claude', '.codex', '.gemini', '.cursor', '.pi', 'scratchpad', '.scratchpad', 'scratch'])
const LOCK_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'composer.lock',
  'gemfile.lock',
  'flake.lock'
])
const TEMP_ROOTS = [
  /^[a-z]:\/users\/[^/]+\/appdata\/local\/temp(\/|$)/,
  /^[a-z]:\/windows\/temp(\/|$)/,
  /^\/tmp(\/|$)/,
  /^\/var\/tmp(\/|$)/,
  /^\/var\/folders(\/|$)/,
  /^\/private\/tmp(\/|$)/,
  /^\/private\/var\/folders(\/|$)/
]

function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]|^[\\/]/.test(path)
}

function pathParts(path: string): string[] {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part.toLowerCase())
  }
  return parts
}

function normalizedAbsolute(path: string): string {
  const parts = pathParts(path)
  return /^[a-zA-Z]:/.test(path) ? parts.join('/') : `/${parts.join('/')}`
}

function relativeParts(path: string, cwd: string): string[] {
  if (!isAbsolutePath(path)) return pathParts(path)
  return pathParts(path).slice(pathParts(cwd).length)
}

function isTempPath(path: string): boolean {
  if (!isAbsolutePath(path)) return false
  const normalized = normalizedAbsolute(path)
  return TEMP_ROOTS.some((root) => root.test(normalized))
}

function isNoiseFile(name: string): boolean {
  return name.endsWith('.log') || name.endsWith('.lock') || LOCK_FILES.has(name)
}

export function isScratchOutput(path: string, cwd?: string): boolean {
  const parts = pathParts(path)
  const name = parts[parts.length - 1] ?? ''
  if (!name || isNoiseFile(name)) return true
  const root = cwd?.trim() ? cwd : ''
  if (root && isInsideCwd(path, root)) {
    const dirs = relativeParts(path, root).slice(0, -1)
    return dirs.some((dir) => SKIP_DIRS.has(dir) || DRAFT_DIRS.has(dir))
  }
  if (isTempPath(path)) return true
  const dirs = parts.slice(0, -1)
  if (!root) return dirs.some((dir) => SKIP_DIRS.has(dir) || DRAFT_DIRS.has(dir))
  return dirs.some((dir) => DRAFT_DIRS.has(dir))
}

function callTime(call: UIToolCall, message: UIMessage): number {
  return call.endedAt ?? call.startedAt ?? message.timestamp ?? 0
}

export function outputCandidates(messages: readonly UIMessage[], cwd?: string): RailOutput[] {
  const calls: UIToolCall[] = []
  const seen = new Map<string, { at: number; seq: number }>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue
    for (const call of message.toolCalls) {
      calls.push(call)
      const diff = readFileDiff(call.details)
      if (!diff) continue
      const path = diff.path || callPath(call) || call.id
      seen.set(path, { at: callTime(call, message), seq: calls.length })
    }
  }
  if (calls.length === 0) return []
  const requests = requestFilesOf(calls)
  const files = collectTurnChanges(calls)?.files ?? []
  return files
    .filter((file) => file.status === 'created')
    .filter((file) => !requests.some((request) => samePathTail(file.path, request)))
    .filter((file) => !isScratchOutput(file.path, cwd))
    .map((file) => ({ file, order: seen.get(file.path) ?? { at: 0, seq: 0 } }))
    .sort((a, b) => b.order.at - a.order.at || b.order.seq - a.order.seq)
    .map(({ file, order }) => ({ path: file.path, at: order.at }))
}

export interface OutputScreenState {
  checked: ReadonlySet<string>
  ignored: ReadonlySet<string>
  missing: ReadonlySet<string>
  pending: boolean
}

export function visibleOutputs(
  candidates: readonly RailOutput[],
  screen: OutputScreenState | null,
  dismissed: readonly string[]
): RailOutput[] {
  const removed = new Set(dismissed)
  return candidates.filter((output) => {
    if (removed.has(output.path)) return false
    if (!screen) return true
    if (screen.ignored.has(output.path) || screen.missing.has(output.path)) return false
    return !screen.pending || screen.checked.has(output.path)
  })
}

export function screenState(paths: readonly string[], result: GitPathScreen, pending: boolean): OutputScreenState {
  return { checked: new Set(paths), ignored: new Set(result.ignored), missing: new Set(result.missing), pending }
}

export function useOutputScreen(cwd: string | null, paths: readonly string[], refreshKey: string): OutputScreenState | null {
  const key = paths.join('\n')
  const [state, setState] = useState<{ cwd: string | null; key: string; paths: readonly string[]; result: GitPathScreen } | null>(null)
  const [loading, setLoading] = useState(false)
  const available = typeof window !== 'undefined' && typeof window.yan?.git?.screenPaths === 'function'
  useEffect(() => {
    const git = window.yan?.git
    if (!cwd || !available || !git || paths.length === 0) {
      setLoading(false)
      return undefined
    }
    let alive = true
    setLoading(true)
    const list = key.split('\n')
    git
      .screenPaths(cwd, list)
      .then((result) => {
        if (!alive) return
        setState({ cwd, key, paths: list, result: { ignored: result?.ignored ?? [], missing: result?.missing ?? [] } })
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setState({ cwd, key, paths: list, result: { ignored: [], missing: [] } })
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [cwd, key, refreshKey, available])
  if (!cwd || !available) return null
  const current = state && state.cwd === cwd ? state : null
  return screenState(current?.paths ?? [], current?.result ?? { ignored: [], missing: [] }, loading || current?.key !== key)
}

const DISMISSED_PREFIX = 'inkstone.v3.rail.outputs.dismissed:'
const MAX_DISMISSED = 200

export function dismissedStorageKey(sessionKey: string): string {
  return `${DISMISSED_PREFIX}${sessionKey}`
}

export function parseDismissed(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(-MAX_DISMISSED) : []
  } catch {
    return []
  }
}

export function addDismissed(list: readonly string[], path: string): string[] {
  return [...list.filter((item) => item !== path), path].slice(-MAX_DISMISSED)
}

function readDismissed(sessionKey: string): string[] {
  if (!sessionKey || typeof localStorage === 'undefined') return []
  try {
    return parseDismissed(localStorage.getItem(dismissedStorageKey(sessionKey)))
  } catch {
    return []
  }
}

export function useDismissedOutputs(sessionKey: string): [string[], (path: string) => void] {
  const [state, setState] = useState(() => ({ key: sessionKey, list: readDismissed(sessionKey) }))
  const current = state.key === sessionKey ? state.list : readDismissed(sessionKey)
  useEffect(() => {
    if (state.key !== sessionKey) setState({ key: sessionKey, list: readDismissed(sessionKey) })
  }, [sessionKey, state.key])
  const dismiss = useCallback(
    (path: string) => {
      const next = addDismissed(readDismissed(sessionKey), path)
      setState({ key: sessionKey, list: next })
      if (!sessionKey || typeof localStorage === 'undefined') return
      try {
        localStorage.setItem(dismissedStorageKey(sessionKey), JSON.stringify(next))
      } catch {
        return
      }
    },
    [sessionKey]
  )
  return [current, dismiss]
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
