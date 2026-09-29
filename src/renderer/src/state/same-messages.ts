/**
 * 消息列表的「内容相同就沿用旧引用」。
 *
 * 打开一个会话时，同一份历史会被整体替换好几次：先是文件预览（peek），
 * 再是运行实例快照，最后是 pi 那边重读后推来的权威版本。三份内容通常一模一样，
 * 但每次都是新数组 —— 回合分组、虚拟列表测量与「滚到底」全部重跑一遍，
 * 千条消息的会话里这要多花几百毫秒。内容没变就保持引用不变，后面的记忆化才起作用。
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  if (ak.length !== Object.keys(bo).length) return false
  for (const k of ak) {
    if (!(k in bo) || !deepEqual(ao[k], bo[k])) return false
  }
  return true
}

/** 逐条比对：相同的条目沿用旧对象；整份都相同且条数一致时直接返回旧数组 */
export function reuseIfSame<T>(prev: readonly T[], next: readonly T[]): readonly T[] {
  if (prev === next) return prev
  let allSame = prev.length === next.length
  const merged = next.map((item, i) => {
    if (i < prev.length && deepEqual(prev[i], item)) return prev[i]
    allSame = false
    return item
  })
  return allSame ? prev : merged
}
