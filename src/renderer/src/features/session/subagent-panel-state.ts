import { create } from 'zustand'

export const SUBAGENT_PANEL_WIDTH = 360
export const SUBAGENT_PANEL_MIN_WIDTH = 240
export const SUBAGENT_PANEL_EDGE = 48
export const MESSAGE_MIN_WIDTH = 520
export const LANE_GAP = 16
export const SUBAGENT_LANE_EDGE = MESSAGE_MIN_WIDTH + LANE_GAP

export function subagentPanelShownWidth(width: number, available: number, edge = SUBAGENT_PANEL_EDGE): number {
  return Math.min(width, Math.max(SUBAGENT_PANEL_MIN_WIDTH, available - edge))
}

interface SubagentPanelState {
  runId: string | null
  owner: string | null
  returnFocus: HTMLElement | null
  width: number
  open(runId: string, owner: string, from?: HTMLElement | null): void
  toggle(runId: string, owner: string, from?: HTMLElement | null): void
  close(): void
  setWidth(width: number): void
}

export const useSubagentPanel = create<SubagentPanelState>((set, get) => ({
  runId: null,
  owner: null,
  returnFocus: null,
  width: SUBAGENT_PANEL_WIDTH,
  setWidth: (width) => set({ width }),
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
