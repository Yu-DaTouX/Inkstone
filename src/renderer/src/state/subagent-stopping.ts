import { create } from 'zustand'

interface SubagentStoppingState {
  ids: ReadonlySet<string>
  mark(runId: string): void
  clear(runId: string): void
  prune(liveRunIds: readonly string[]): void
}

export const useSubagentStopping = create<SubagentStoppingState>((set, get) => ({
  ids: new Set<string>(),
  mark: (runId) => {
    if (get().ids.has(runId)) return
    set({ ids: new Set([...get().ids, runId]) })
  },
  clear: (runId) => {
    if (!get().ids.has(runId)) return
    const next = new Set(get().ids)
    next.delete(runId)
    set({ ids: next })
  },
  prune: (liveRunIds) => {
    const live = new Set(liveRunIds)
    const kept = [...get().ids].filter((id) => live.has(id))
    if (kept.length !== get().ids.size) set({ ids: new Set(kept) })
  }
}))
