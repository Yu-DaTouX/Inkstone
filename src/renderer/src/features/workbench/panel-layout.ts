/**
 * 工作区面板拆分 / 专注的版面规则（纯函数，可单测）。
 *
 * 「拆分」= 面板上下两格，每格一块页签；「专注」= 只留一块，把当前页签最大化。
 * 专注压过拆分：专注期间下半格不挂载、也不登记，退出专注后恢复原来的拆分。
 *
 * 两格**不允许**显示同一个页签：把同一个叶子实例同时放进两个容器会重复挂载
 * PTY / 原生浏览器。主格选到下半格的页签时由面板交换两格；这里的
 * `fallbackSecondary` 只是兜底（例如持久化的旧偏好里两格撞了）。
 */
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

/**
 * 下半格兜底页签：优先取不需要激活的只读页签，避免「一开拆分就隐式挂上终端」。
 * 固定顺序里找不到（理论上不会）再退回任意不同页签，最后退回主格。
 */
export function fallbackSecondary(activeTab: WorkbenchTabId): WorkbenchTabId {
  const safe = WORKBENCH_TABS.filter((tab) => !WORKBENCH_ACTIVE_TABS.has(tab) && tab !== activeTab)
  return safe[0] ?? WORKBENCH_TABS.find((tab) => tab !== activeTab) ?? activeTab
}

export function cellForTab(layout: PanelLayout, tab: WorkbenchTabId): PanelCell | null {
  if (tab === layout.primary) return 'primary'
  if (layout.secondary && tab === layout.secondary) return 'secondary'
  return null
}

/** 打开拆分 / 专注时需要一并登记为「已访问」的页签（主格之外）。 */
export function extraVisibleTabs(layout: PanelLayout): readonly WorkbenchTabId[] {
  return layout.secondary ? [layout.secondary] : []
}

/**
 * 下半格选页签：与主格相同则忽略（返回 null），其余情况返回新值。
 * 界面据此避免两格撞同一页签。
 */
export function nextSplitTab(
  current: WorkbenchTabId,
  activeTab: WorkbenchTabId,
  picked: WorkbenchTabId
): WorkbenchTabId | null {
  if (picked === activeTab || picked === current) return null
  return picked
}

/**
 * 主格选页签时保持两格不同：新主格正是下半格时就与旧主格交换。
 * 返回 null 表示按原值设置即可。
 */
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
