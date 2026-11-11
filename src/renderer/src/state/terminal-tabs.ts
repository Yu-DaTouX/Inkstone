import { create } from 'zustand'

export interface TerminalTabsSnapshot {
  labels: readonly string[]
  activeIndex: number
}

interface TerminalTabsState {
  byKey: Record<string, TerminalTabsSnapshot>
  publish: (key: string, snapshot: TerminalTabsSnapshot | null) => void
}

function sameSnapshot(a: TerminalTabsSnapshot, b: TerminalTabsSnapshot): boolean {
  return a.activeIndex === b.activeIndex && a.labels.length === b.labels.length && a.labels.every((label, index) => label === b.labels[index])
}

export const useTerminalTabs = create<TerminalTabsState>((set) => ({
  byKey: {},
  publish: (key, snapshot) =>
    set((state) => {
      const current = state.byKey[key]
      if (!snapshot) {
        if (!current) return state
        const { [key]: _gone, ...rest } = state.byKey
        return { byKey: rest }
      }
      if (current && sameSnapshot(current, snapshot)) return state
      return { byKey: { ...state.byKey, [key]: snapshot } }
    })
}))

export function useTerminalTabTitle(key: string | null | undefined): string | null {
  const snapshot = useTerminalTabs((state) => (key ? state.byKey[key] : undefined))
  if (!snapshot) return null
  return snapshot.labels[snapshot.activeIndex] ?? snapshot.labels[0] ?? null
}
