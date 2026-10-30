import { create } from 'zustand'
import { sanitizeSurface, useRightPanel, type RightPanelSurface } from './right-panel'

export const CLOSED_PANEL_STORAGE_KEY = 'inkstone.v3.rightPanel.closed'
export const CLOSED_PANEL_LIMIT = 20

const NOT_REMEMBERED: ReadonlySet<string> = new Set(['terminal'])

export interface ClosedPanelEntry {
  id: string
  key: string
  surface: RightPanelSurface
}

interface ClosedPanelState {
  byKey: Record<string, ClosedPanelEntry[]>
  remember: (key: string, surface: RightPanelSurface) => void
  forget: (key: string, surfaceId: string) => void
  take: (key: string) => RightPanelSurface | null
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function normalize(list: readonly ClosedPanelEntry[]): ClosedPanelEntry[] {
  const seen = new Set<string>()
  const kept: ClosedPanelEntry[] = []
  for (const entry of list) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.key !== 'string' || !entry.key) continue
    if (seen.has(entry.id)) continue
    const surface = sanitizeSurface(entry.surface)
    if (!surface || surface.id !== entry.id) continue
    seen.add(entry.id)
    kept.push({ id: entry.id, key: entry.key, surface })
  }
  return kept.slice(0, CLOSED_PANEL_LIMIT)
}

function readClosedPanels(): Record<string, ClosedPanelEntry[]> {
  const store = storage()
  if (!store) return {}
  try {
    const raw = JSON.parse(store.getItem(CLOSED_PANEL_STORAGE_KEY) ?? 'null') as { byKey?: unknown } | null
    const byKey = raw && typeof raw === 'object' && raw.byKey && typeof raw.byKey === 'object' ? (raw.byKey as Record<string, unknown>) : null
    if (!byKey) return {}
    const out: Record<string, ClosedPanelEntry[]> = {}
    for (const key of Object.keys(byKey)) {
      const list = byKey[key]
      if (!Array.isArray(list)) continue
      const entries = normalize(list as ClosedPanelEntry[])
      if (entries.length) out[key] = entries
    }
    return out
  } catch {
    return {}
  }
}

function writeClosedPanels(byKey: Record<string, ClosedPanelEntry[]>): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(CLOSED_PANEL_STORAGE_KEY, JSON.stringify({ version: 1, byKey }))
  } catch {
  }
}

export const useClosedPanels = create<ClosedPanelState>((set, get) => {
  const commit = (byKey: Record<string, ClosedPanelEntry[]>): void => {
    writeClosedPanels(byKey)
    set({ byKey })
  }
  return {
    byKey: readClosedPanels(),
    remember: (key, surface) => {
      if (!key || NOT_REMEMBERED.has(surface.kind)) return
      const current = get().byKey[key] ?? []
      const next = normalize([{ id: surface.id, key, surface }, ...current.filter((entry) => entry.id !== surface.id)])
      commit({ ...get().byKey, [key]: next })
    },
    forget: (key, surfaceId) => {
      const current = get().byKey[key]
      if (!current) return
      const next = current.filter((entry) => entry.id !== surfaceId)
      const byKey = { ...get().byKey }
      if (next.length) byKey[key] = next
      else delete byKey[key]
      commit(byKey)
    },
    take: (key) => {
      const current = get().byKey[key]
      if (!current?.length) return null
      const [first, ...rest] = current
      const byKey = { ...get().byKey }
      if (rest.length) byKey[key] = rest
      else delete byKey[key]
      commit(byKey)
      return first.surface
    }
  }
})

export function rememberClosed(key: string, surface: RightPanelSurface): void {
  useClosedPanels.getState().remember(key, surface)
}

export function forgetClosed(key: string, surfaceId: string): void {
  useClosedPanels.getState().forget(key, surfaceId)
}

export function reopenLast(key: string): RightPanelSurface | null {
  return useClosedPanels.getState().take(key)
}

export function reopenLastClosed(): RightPanelSurface | null {
  const surface = reopenLast(useRightPanel.getState().key)
  if (surface) useRightPanel.getState().open(surface)
  return surface
}

const EMPTY_ENTRIES: readonly ClosedPanelEntry[] = []

export function useClosedPanelsFor(key: string): readonly ClosedPanelEntry[] {
  return useClosedPanels((state) => state.byKey[key]) ?? EMPTY_ENTRIES
}

let tracked = false

export function trackClosedPanels(): void {
  if (tracked) return
  tracked = true
  useRightPanel.subscribe((state, previous) => {
    if (state.byKey === previous.byKey) return
    for (const key of new Set([...Object.keys(state.byKey), ...Object.keys(previous.byKey)])) {
      const before = previous.byKey[key]?.surfaces
      const after = state.byKey[key]?.surfaces
      if (before === after) continue
      const alive = new Set((after ?? []).map((surface) => surface.id))
      const removed = (before ?? []).filter((surface) => !alive.has(surface.id))
      if (!removed.length) continue
      const active = previous.byKey[key]?.active
      const ordered = [...removed.filter((surface) => surface.id !== active), ...removed.filter((surface) => surface.id === active)]
      for (const surface of ordered) rememberClosed(key, surface)
    }
  })
}

trackClosedPanels()
