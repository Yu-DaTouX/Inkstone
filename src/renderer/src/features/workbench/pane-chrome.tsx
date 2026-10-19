import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface PaneMenuItem {
  id: string
  label: string
  icon?: ReactNode
  checked?: boolean
  disabled?: boolean
  onAction: () => void
}

export interface PaneChrome {
  title: HTMLElement | null
  tools: HTMLElement | null
  setMenu: (source: string, items: readonly PaneMenuItem[]) => void
}

export const PaneChromeContext = createContext<PaneChrome | null>(null)

export function usePaneChrome(): PaneChrome | null {
  return useContext(PaneChromeContext)
}

export function PaneTitle({ children }: { children: ReactNode }): ReactNode {
  const chrome = usePaneChrome()
  return chrome?.title ? createPortal(children, chrome.title) : null
}

export function PaneTools({ children }: { children: ReactNode }): ReactNode {
  const chrome = usePaneChrome()
  return chrome?.tools ? createPortal(children, chrome.tools) : null
}

export function paneMenuSignature(items: readonly PaneMenuItem[]): string {
  return items.map((item) => `${item.id}:${item.label}:${item.checked === undefined ? '' : item.checked ? 1 : 0}:${item.disabled ? 1 : 0}`).join('|')
}

export function usePaneMenu(source: string, items: readonly PaneMenuItem[]): void {
  const chrome = usePaneChrome()
  const setMenu = chrome?.setMenu
  const latest = useRef(items)
  latest.current = items
  const signature = paneMenuSignature(items)
  useEffect(() => {
    if (!setMenu) return undefined
    setMenu(source, latest.current.map((item) => ({ ...item, onAction: () => latest.current.find((next) => next.id === item.id)?.onAction() })))
    return undefined
  }, [setMenu, source, signature])
  useEffect(() => {
    if (!setMenu) return undefined
    return () => setMenu(source, [])
  }, [setMenu, source])
}
