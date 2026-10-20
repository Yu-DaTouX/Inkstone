export interface TabSpan {
  id: string
  start: number
  end: number
}

export interface TabStripInput {
  tabs: readonly TabSpan[]
  width: number
  scrollLeft: number
  maxScroll: number
  activeId: string | null
}

export interface TabStripLayout {
  scrollLeft: number
  hiddenIds: string[]
  overflowing: boolean
}

export function tabStripLayout({ tabs, width, scrollLeft, maxScroll, activeId }: TabStripInput): TabStripLayout {
  const last = tabs[tabs.length - 1]
  if (!last || width <= 0) return { scrollLeft: 0, hiddenIds: [], overflowing: false }
  const contentEnd = last.end
  if (contentEnd <= width + 1) return { scrollLeft: 0, hiddenIds: [], overflowing: false }

  const snapStart = (end: number, limit: number): number => {
    const minimum = Math.max(0, Math.ceil(end - width))
    const tab = tabs.find((candidate) => candidate.start >= minimum && candidate.start <= limit)
    return tab ? Math.round(tab.start) : minimum
  }

  let left = 0
  for (const tab of tabs) if (tab.start <= scrollLeft + 1) left = Math.round(tab.start)
  left = Math.min(left, snapStart(contentEnd, contentEnd))
  const active = activeId === null ? undefined : tabs.find((tab) => tab.id === activeId)
  if (active) {
    if (active.end > left + width + 1) left = snapStart(active.end, active.start)
    else if (active.start < left - 1) left = Math.max(Math.round(active.start), Math.ceil(active.end - width))
  }
  left = Math.max(0, Math.min(left, maxScroll))

  return { scrollLeft: left, hiddenIds: hiddenTabsAt(tabs, width, left, activeId), overflowing: true }
}

export function hiddenTabsAt(tabs: readonly TabSpan[], width: number, left: number, activeId: string | null): string[] {
  const last = tabs[tabs.length - 1]
  if (!last || last.end <= width + 1) return []
  const right = left + width
  return tabs
    .filter((tab) => tab.id !== activeId && (tab.start < left - 1 || tab.end > right + 1))
    .map((tab) => tab.id)
}
