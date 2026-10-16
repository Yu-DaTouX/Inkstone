import { WORKBENCH_ACTIVE_TABS, WORKBENCH_TABS, type WorkbenchTabId } from './types'

export type PanelCell = 'primary' | 'secondary'

export interface PanelLayout {
  primary: WorkbenchTabId
  secondary: WorkbenchTabId | null
}

export function resolvePanelLayout(input: {
  split: boolean
  focus: boolean
  activeTab: WorkbenchTabId
  splitTab: WorkbenchTabId
}): PanelLayout {
  if (input.focus || !input.split) return { primary: input.activeTab, secondary: null }
  const secondary = input.splitTab === input.activeTab ? fallbackSecondary(input.activeTab) : input.splitTab
  return { primary: input.activeTab, secondary }
}

export function fallbackSecondary(activeTab: WorkbenchTabId): WorkbenchTabId {
  const safe = WORKBENCH_TABS.filter((tab) => !WORKBENCH_ACTIVE_TABS.has(tab) && tab !== activeTab)
  return safe[0] ?? WORKBENCH_TABS.find((tab) => tab !== activeTab) ?? activeTab
}

export function cellForTab(layout: PanelLayout, tab: WorkbenchTabId): PanelCell | null {
  if (tab === layout.primary) return 'primary'
  if (layout.secondary && tab === layout.secondary) return 'secondary'
  return null
}

export function extraVisibleTabs(layout: PanelLayout): readonly WorkbenchTabId[] {
  return layout.secondary ? [layout.secondary] : []
}

export function nextSplitTab(
  current: WorkbenchTabId,
  activeTab: WorkbenchTabId,
  picked: WorkbenchTabId
): WorkbenchTabId | null {
  if (picked === activeTab || picked === current) return null
  return picked
}

export function splitTabOnPrimaryChange(input: {
  split: boolean
  splitTab: WorkbenchTabId
  prevActive: WorkbenchTabId
  nextActive: WorkbenchTabId
}): WorkbenchTabId | null {
  if (!input.split) return null
  if (input.nextActive !== input.splitTab) return null
  return input.prevActive
}
