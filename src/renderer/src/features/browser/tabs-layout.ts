export type BrowserTabsLayout = 'vertical' | 'horizontal'

export const TABS_LAYOUT_KEY = 'inkstone.browser.tabsLayout'
export const BROWSER_NARROW_PANE = 560

export interface TabsLayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): TabsLayoutStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function normalizeTabsLayout(value: unknown): BrowserTabsLayout {
  return value === 'horizontal' ? 'horizontal' : 'vertical'
}

export function readTabsLayout(storage: TabsLayoutStorage | null = defaultStorage()): BrowserTabsLayout {
  try {
    return normalizeTabsLayout(storage?.getItem(TABS_LAYOUT_KEY))
  } catch {
    return 'vertical'
  }
}

export function writeTabsLayout(layout: BrowserTabsLayout, storage: TabsLayoutStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(TABS_LAYOUT_KEY, layout)
  } catch {
    return
  }
}

export function pinnedTabsShown(pinned: boolean, layout: BrowserTabsLayout, paneWidth: number): boolean {
  return layout === 'vertical' && pinned && !(paneWidth > 0 && paneWidth < BROWSER_NARROW_PANE)
}
