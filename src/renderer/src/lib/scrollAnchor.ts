/**
 * 展开 / 收起时的**滚动锚点**（方案 4.2）。
 *
 * 问题：点开一条工具详情会把下方内容整体推下去。在长会话里，
 * 用户正在读上面某一段时点开详情，整个视口会「跳一下」；
 * 而贴底时又希望保持贴底。
 *
 * 做法：
 *   1. 记下锚点元素相对视口的位置；
 *   2. 执行改变 DOM 高度的操作；
 *   3. 下一帧量一次新位置，把差值补回滚动容器 ——
 *      锚点元素在屏幕上**原地不动**。
 *
 * ⚠️ 只在**没有贴底**时才补差值；贴底时滚到底，保持「跟着最新」。
 * ⚠️ 不用 scrollIntoView：它会强制把锚点吸到视口某处，
 *    而我们要的是「不动」，两者语义不同。
 */

/** 找最近的、真的能滚的祖先（跳过那些 overflow: hidden 的包装层） */
export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const style = getComputedStyle(node)
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY)
    if (scrollable && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return null
}

/** 在保持锚点位置的前提下执行一次布局变更 */
export function withScrollAnchor(anchor: HTMLElement | null, mutate: () => void): void {
  if (!anchor) {
    mutate()
    return
  }
  const scroller = findScrollParent(anchor)
  if (!scroller) {
    mutate()
    return
  }
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
  const before = anchor.getBoundingClientRect().top
  mutate()
  requestAnimationFrame(() => {
    if (atBottom) {
      /* 贴底：继续贴底（用户要的是「跟着最新」） */
      scroller.scrollTop = scroller.scrollHeight
      return
    }
    const after = anchor.getBoundingClientRect().top
    const delta = Math.round(after - before)
    if (Math.abs(delta) > 1) scroller.scrollTop += delta
  })
}
