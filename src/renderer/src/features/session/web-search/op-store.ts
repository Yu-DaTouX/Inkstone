import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { WebSearchOpView } from '../../../../../shared/ipc'

export type SearchOpState = { status: 'loading' } | { status: 'ready'; view: WebSearchOpView }

const LOADING: SearchOpState = { status: 'loading' }
const FAILED: WebSearchOpView = { ok: false, error: 'unavailable' }
const CACHE_LIMIT = 48

const states = new Map<string, SearchOpState>()
const requested = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

function store(operationId: string, view: WebSearchOpView): void {
  states.delete(operationId)
  states.set(operationId, { status: 'ready', view })
  while (states.size > CACHE_LIMIT) {
    const oldest = states.keys().next().value
    if (oldest === undefined) break
    states.delete(oldest)
  }
  emit()
}

export function searchOpState(operationId: string): SearchOpState {
  return states.get(operationId) ?? LOADING
}

export function requestSearchOp(operationId: string): void {
  if (!operationId || requested.has(operationId)) return
  requested.add(operationId)
  const read = typeof window === 'undefined' ? undefined : window.yan?.searchOps?.read
  if (!read) {
    store(operationId, FAILED)
    return
  }
  void read(operationId).then(
    (view) => store(operationId, view ?? FAILED),
    () => store(operationId, FAILED)
  )
}

export function subscribeSearchOps(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function searchOpsVersion(): number {
  return version
}

export function useSearchOp(operationId: string | null): SearchOpState {
  const current = useSyncExternalStore(subscribeSearchOps, searchOpsVersion, searchOpsVersion)
  useEffect(() => {
    if (operationId) requestSearchOp(operationId)
  }, [operationId])
  return useMemo(() => (operationId ? searchOpState(operationId) : LOADING), [operationId, current])
}

export function useSearchOps(operationIds: readonly string[]): SearchOpState[] {
  const current = useSyncExternalStore(subscribeSearchOps, searchOpsVersion, searchOpsVersion)
  const key = operationIds.join(',')
  useEffect(() => {
    for (const id of operationIds) requestSearchOp(id)
  }, [key])
  return useMemo(() => operationIds.map((id) => searchOpState(id)), [key, current])
}
