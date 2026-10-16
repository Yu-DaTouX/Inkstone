/**
 * 工作区页签的挂载状态（纯函数，可单测）。
 *
 * 缺陷背景：面板默认关闭，但旧实现把 `activeTab` 直接塞进初始 `visited`，
 * 于是「没打开过面板」也会挂上叶子 —— 至少会偷偷查一次 Git；若叶子自身没有
 * 创建门闩，还可能启动 PTY。这里把「挂载谁」收敛成一条明确规则：
 *
 *   · 初始 `visited` 为空集：默认关闭时零挂载。
 *   · 只有 `open=true` 时才把当前页签登记为已访问（首次打开才挂当前页签）；
 *     拆分打开时下半格的页签一并登记。
 *   · 关闭面板**不注销**任何已访问页签：已开的终端 / 浏览器保留实例，只隐藏。
 *     为了「关掉就省资源」去 kill 后台资源不是面板的职责。
 *   · 固定页签各一个实例，挂载数天然封顶。
 *
 * 叶子仍需独立的 `visible` / 激活守卫；这里是第一层，不替代叶子的第二层。
 */
import { WORKBENCH_TABS, type WorkbenchTabId } from './types'

/** 固定页签数即最大叶子实例数。 */
export const MAX_MOUNTED_PANES = WORKBENCH_TABS.length

/** 初始挂载状态：什么都没访问过。 */
export function emptyMountState(): ReadonlySet<WorkbenchTabId> {
  return new Set<WorkbenchTabId>()
}

/**
 * 面板 `open` / `activeTab` / 拆分变化后的 `visited`。
 *
 * 关闭时不改动传入集合（原样返回同一引用），避免无谓的重渲染和「关掉即卸载」；
 * 打开时若当前页签（或拆分的下半格）尚未访问则加入。无变化时返回原引用，
 * 调用方可安全放进 effect。
 */
export function nextVisited(
  visited: ReadonlySet<WorkbenchTabId>,
  { open, activeTab, extra = [] }: { open: boolean; activeTab: WorkbenchTabId; extra?: readonly WorkbenchTabId[] }
): ReadonlySet<WorkbenchTabId> {
  if (!open) return visited
  const wanted = [activeTab, ...extra]
  if (wanted.every((tab) => visited.has(tab))) return visited
  return new Set([...visited, ...wanted])
}

/** 实际要渲染的页签：按固定顺序过滤已访问项，并再次封顶。 */
export function mountedTabs(visited: ReadonlySet<WorkbenchTabId>): readonly WorkbenchTabId[] {
  return WORKBENCH_TABS.filter((tab) => visited.has(tab)).slice(0, MAX_MOUNTED_PANES)
}
