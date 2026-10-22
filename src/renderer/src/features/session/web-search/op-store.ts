import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { WebSearchOpView } from '../../../../../shared/ipc'

export type SearchOpState = { status: 'loading' } | { status: 'ready'; view: WebSearchOpView }

const LOADING: SearchOpState = { status: 'loading' }
const FAILED: WebSearchOpView = { ok: false, error: 'unavailable' }
const CACHE_LIMIT = 48

const states = new Map<string, SearchOpState>()
const requested = new Set<string>()
const inUse = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

function store(operationId: string, view: WebSearchOpView): void {
  states.delete(operationId)
  states.set(operationId, { status: 'ready', view })
  for (const id of [...states.keys()]) {
    if (states.size <= CACHE_LIMIT) break
    if (id === operationId || inUse.has(id)) continue
    states.delete(id)
    requested.delete(id)
  }
  emit()
}

function retainSearchOps(operationIds: readonly string[]): () => void {
  for (const id of operationIds) inUse.set(id, (inUse.get(id) ?? 0) + 1)
  return () => {
    for (const id of operationIds) {
      const left = (inUse.get(id) ?? 1) - 1
      if (left > 0) inUse.set(id, left)
      else inUse.delete(id)
    }
  }
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
    if (!operationId) return
    requestSearchOp(operationId)
    return retainSearchOps([operationId])
  }, [operationId])
  return useMemo(() => (operationId ? searchOpState(operationId) : LOADING), [operationId, current])
}

export function useSearchOps(operationIds: readonly string[]): SearchOpState[] {
  const current = useSyncExternalStore(subscribeSearchOps, searchOpsVersion, searchOpsVersion)
  const key = operationIds.join(',')
  useEffect(() => {
    const ids = key ? key.split(',') : []
    for (const id of ids) requestSearchOp(id)
    return retainSearchOps(ids)
  }, [key])
  return useMemo(() => operationIds.map((id) => searchOpState(id)), [key, current])
}
