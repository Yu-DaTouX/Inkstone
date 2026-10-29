import { useEffect } from 'react'
import { create } from 'zustand'

export type V3RouteName = 'chat' | 'schedule' | 'collab' | 'usage' | 'artifacts'

export interface V3Route {
  name: V3RouteName
}

interface UiV3State {
  route: V3Route
  back: V3Route[]
  sidebarOpen: boolean
  navigate: (route: V3Route) => void
  goBack: () => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
}

export const useUiV3 = create<UiV3State>((set, get) => ({
  route: { name: 'chat' },
  back: [],
  sidebarOpen: true,
  navigate: (route) => {
    if (route.name === get().route.name) return
    set({ route, back: [...get().back, get().route].slice(-20) })
  },
  goBack: () => {
    if (get().route.name === 'chat') return
    set({ route: { name: 'chat' }, back: [] })
  },
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen })
}))

export function routeFromHash(hash: string): V3Route {
  const name = hash.replace(/^#\/?/, '')
  if (name === 'schedule') return { name: 'schedule' }
  if (name === 'collab') return { name: 'collab' }
  if (name === 'usage') return { name: 'usage' }
  if (name === 'artifacts') return { name: 'artifacts' }
  return { name: 'chat' }
}

export function hashForRoute(route: V3Route): string {
  return route.name === 'chat' ? '#/' : `#/${route.name}`
}

export function useV3RouteSync(): void {
  useEffect(() => {
    const applyHash = (): void => {
      useUiV3.setState({ route: routeFromHash(window.location.hash) })
    }
    const early = useUiV3.getState().route
    if (early.name !== 'chat' && routeFromHash(window.location.hash).name === 'chat') {
      window.history.replaceState(null, '', hashForRoute(early))
    } else {
      applyHash()
    }
    window.addEventListener('hashchange', applyHash)
    const unsubscribe = useUiV3.subscribe((state, previous) => {
      if (state.route === previous.route) return
      const next = hashForRoute(state.route)
      if (window.location.hash !== next) window.history.replaceState(null, '', next)
    })
    return () => {
      window.removeEventListener('hashchange', applyHash)
      unsubscribe()
    }
  }, [])
}
