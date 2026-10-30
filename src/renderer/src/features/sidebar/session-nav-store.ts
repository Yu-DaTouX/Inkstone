import { create } from 'zustand'

export interface SessionNavState {
  order: readonly string[]
  jump: ReadonlyMap<string, number> | null
  fileDropPath: string | null
}

export const useSessionNav = create<SessionNavState>(() => ({ order: [], jump: null, fileDropPath: null }))

export function setSessionOrder(order: readonly string[]): void {
  const previous = useSessionNav.getState().order
  if (previous.length === order.length && previous.every((path, index) => path === order[index])) return
  useSessionNav.setState({ order })
}
