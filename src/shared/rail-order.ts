/**
 * 侧栏拖拽排序的纯计算（N01）。
 *
 * 为什么单独一层：拖拽的**几何**（指针落在哪一行、上半还是下半）必须在真实窗口里
 * 用指针事件验，而**顺序计算**是纯逻辑 —— 把它抽出来，越界、未知 id、移动到自己
 * 位置这些边界就能用单测钉死，不必去合成鼠标轨迹。真实窗口只负责证明「拖动之后
 * 提交的正是这里算出来的顺序」。
 */

/**
 * 拖拽结果：把 `movedId` 放到 `beforeId` **之前**；`beforeId` 为 `null` 表示放到末尾。
 *
 * 返回值语义（调用方据此决定要不要落盘）：
 *   · `movedId` 不在 `ids` 里       → 原样返回（不是这个列表里能拖的东西）
 *   · `beforeId` 指向自己           → 原样返回（没动）
 *   · `beforeId` 不在 `ids` 里      → 原样返回（落点失效，宁可不动也不要瞎插）
 *   · 其余                          → 新顺序
 *
 * 为什么用「插入到谁之前」而不是「拖到第几位」：行的高度会随界面语言/字号变化，
 * 而「前一行的下半部分 = 插到下一行之前」这个判断只依赖被命中的那一行，
 * 早退条件也更好写。
 */
export function orderAfterDrag(ids: readonly string[], movedId: string, beforeId: string | null): string[] {
  if (!ids.includes(movedId)) return [...ids]
  if (beforeId === movedId) return [...ids]
  const without = ids.filter((id) => id !== movedId)
  const to = beforeId === null ? without.length : without.indexOf(beforeId)
  if (to < 0) return [...ids]
  const out = [...without]
  out.splice(to, 0, movedId)
  return out
}

/**
 * 由落点行推出「插入到谁之前」。
 *
 * `after = true` 表示指针在目标行的下半部分 —— 插到它的**下一行**之前；
 * 已经是最后一行时返回 `null`（= 插到末尾）。
 */
export function beforeFromDrop(ids: readonly string[], targetId: string, after: boolean): string | null {
  const i = ids.indexOf(targetId)
  if (i < 0) return null
  if (!after) return targetId
  return ids[i + 1] ?? null
}

/**
 * 排名表：把有序的 id 列表转成 `id → 名次`，供排序比较函数反复查
 * （每次都 `indexOf` 是 O(n²)，项目多时会在拖动中卡顿）。
 *
 * 重复 id 只取第一次出现的位置；空数组返回空表，调用方按「没有自定义顺序」处理。
 */
export function rankOf(order: readonly string[]): Map<string, number> {
  const rank = new Map<string, number>()
  for (const id of order) if (!rank.has(id)) rank.set(id, rank.size)
  return rank
}
