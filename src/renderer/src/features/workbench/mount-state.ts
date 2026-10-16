import { WORKBENCH_TABS, type WorkbenchTabId } from './types'

export const MAX_MOUNTED_PANES = WORKBENCH_TABS.length

export function emptyMountState(): ReadonlySet<WorkbenchTabId> {
  return new Set<WorkbenchTabId>()
}

export function nextVisited(
  visited: ReadonlySet<WorkbenchTabId>,
  { open, activeTab, extra = [] }: { open: boolean; activeTab: WorkbenchTabId; extra?: readonly WorkbenchTabId[] }
): ReadonlySet<WorkbenchTabId> {
  if (!open) return visited
  const wanted = [activeTab, ...extra]
  if (wanted.every((tab) => visited.has(tab))) return visited
  return new Set([...visited, ...wanted])
}

export function mountedTabs(visited: ReadonlySet<WorkbenchTabId>): readonly WorkbenchTabId[] {
  return WORKBENCH_TABS.filter((tab) => visited.has(tab)).slice(0, MAX_MOUNTED_PANES)
}
