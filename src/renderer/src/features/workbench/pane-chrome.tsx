import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface PaneMenuItem {
  id: string
  label: string
  icon?: ReactNode
  checked?: boolean
  disabled?: boolean
  items?: readonly PaneMenuItem[]
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
  return items
    .map((item) => `${item.id}:${item.label}:${item.checked === undefined ? '' : item.checked ? 1 : 0}:${item.disabled ? 1 : 0}${item.items ? `[${paneMenuSignature(item.items)}]` : ''}`)
    .join('|')
}

function findPaneMenuItem(items: readonly PaneMenuItem[], id: string): PaneMenuItem | undefined {
  for (const item of items) {
    if (item.id === id) return item
    const nested = item.items ? findPaneMenuItem(item.items, id) : undefined
    if (nested) return nested
  }
  return undefined
}

function bindPaneMenu(items: readonly PaneMenuItem[], latest: { current: readonly PaneMenuItem[] }): PaneMenuItem[] {
  return items.map((item) => ({
    ...item,
    items: item.items ? bindPaneMenu(item.items, latest) : undefined,
    onAction: () => findPaneMenuItem(latest.current, item.id)?.onAction()
  }))
}

export function usePaneMenu(source: string, items: readonly PaneMenuItem[]): void {
  const chrome = usePaneChrome()
  const setMenu = chrome?.setMenu
  const latest = useRef(items)
  latest.current = items
  const signature = paneMenuSignature(items)
  useEffect(() => {
    if (!setMenu) return undefined
    setMenu(source, bindPaneMenu(latest.current, latest))
    return undefined
  }, [setMenu, source, signature])
  useEffect(() => {
    if (!setMenu) return undefined
    return () => setMenu(source, [])
  }, [setMenu, source])
}
