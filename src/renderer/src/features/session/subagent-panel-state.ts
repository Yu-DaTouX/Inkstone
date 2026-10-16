import { create } from 'zustand'

interface SubagentPanelState {
  runId: string | null
  owner: string | null
  returnFocus: HTMLElement | null
  open(runId: string, owner: string, from?: HTMLElement | null): void
  toggle(runId: string, owner: string, from?: HTMLElement | null): void
  close(): void
}

export const useSubagentPanel = create<SubagentPanelState>((set, get) => ({
  runId: null,
  owner: null,
  returnFocus: null,
  open: (runId, owner, from) => set({ runId, owner, returnFocus: from ?? null }),
  toggle: (runId, owner, from) => {
    const state = get()
    if (state.runId === runId && state.owner === owner) state.close()
    else set({ runId, owner, returnFocus: from ?? null })
  },
  close: () => {
    const target = get().returnFocus
    set({ runId: null, owner: null, returnFocus: null })
    if (target?.isConnected) requestAnimationFrame(() => target.focus())
  }
}))
