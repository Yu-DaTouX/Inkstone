import { useEffect, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { WorkerPoolContext } from '@pierre/diffs/react'
import { WorkerPoolManager } from '@pierre/diffs/worker'
import DiffsWorker from '@pierre/diffs/worker/worker-portable.js?worker'
import { Spinner } from '../../ui'
import { DIFF_THEMES } from './diff-theme'

const IDLE_TTL_MS = 30_000

interface SharedPool {
  pool: WorkerPoolManager | undefined
  consumers: number
  idleTimer: ReturnType<typeof setTimeout> | undefined
  state: 'pending' | 'ready' | 'failed'
  listeners: Set<() => void>
}

let shared: SharedPool | undefined

function poolSize(): number {
  const cores = typeof navigator === 'undefined' ? 4 : Math.max(1, navigator.hardwareConcurrency || 4)
  return Math.max(2, Math.min(4, Math.floor(cores / 2)))
}

function notify(entry: SharedPool): void {
  for (const listener of entry.listeners) listener()
}

function createPool(): SharedPool {
  const entry: SharedPool = { pool: undefined, consumers: 0, idleTimer: undefined, state: 'pending', listeners: new Set() }
  try {
    const pool = new WorkerPoolManager(
      { workerFactory: () => new DiffsWorker(), poolSize: poolSize(), totalASTLRUCacheSize: 160 },
      { theme: DIFF_THEMES, tokenizeMaxLineLength: 1_000, useTokenTransformer: true }
    )
    entry.pool = pool
    const settle = (state: 'ready' | 'failed'): void => {
      if (shared !== entry) return
      entry.state = state
      notify(entry)
    }
    void pool.initialize().then(
      () => settle('ready'),
      () => settle('failed')
    )
  } catch {
    entry.state = 'failed'
  }
  return entry
}

function acquire(): SharedPool {
  const entry = (shared ??= createPool())
  clearTimeout(entry.idleTimer)
  entry.idleTimer = undefined
  entry.consumers += 1
  return entry
}

function release(entry: SharedPool): void {
  entry.consumers -= 1
  if (entry.consumers > 0) return
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined
    if (entry.consumers > 0) return
    entry.pool?.terminate()
    if (shared === entry) shared = undefined
  }, IDLE_TTL_MS)
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const entry = acquire()
  entry.listeners.add(onChange)
  onChange()
  return () => {
    entry.listeners.delete(onChange)
    release(entry)
  }
}

function snapshot(): SharedPool['state'] | 'none' {
  return shared?.state ?? 'none'
}

export function DiffWorkerPool({ children, loadingLabel }: { children: ReactNode; loadingLabel: string }): ReactElement {
  const state = useSyncExternalStore(subscribe, snapshot, () => 'none' as const)
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (state !== 'pending') return undefined
    const timer = window.setTimeout(() => setTimedOut(true), 4_000)
    return () => window.clearTimeout(timer)
  }, [state])
  if ((state === 'pending' || state === 'none') && !timedOut) {
    return (
      <div className="diff-view__loading" role="status">
        <Spinner size="xs" />
        <span>{loadingLabel}</span>
      </div>
    )
  }
  const pool = state === 'ready' ? shared?.pool : undefined
  return <WorkerPoolContext.Provider value={pool}>{children}</WorkerPoolContext.Provider>
}
