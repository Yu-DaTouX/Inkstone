/**
 * 量取原生占位区与它的滚动裁剪区（DOM 相关，单独放，便于纯逻辑测试不碰它）。
 *
 * 裁剪容器只在挂载 / 归属变化时找一次（找它要读 `getComputedStyle`，逐帧读会
 * 让滚动跟随变贵）；之后每帧只读 `getBoundingClientRect`。
 */
import type { RectLike } from './bounds'

/** 元素相对视口的矩形。 */
export function rectOf(el: Element): RectLike {
  return el.getBoundingClientRect()
}

/**
 * 找占位区的裁剪容器。
 *
 * 优先认 `[data-native-clip]`（R0 的工作区滚动容器可以显式标记）；没有标记时
 * 向上找第一个会裁剪/滚动子元素的祖先，避免磁贴滚出视口后原生视图仍浮在上面。
 * 一直找到根还没有就返回 null（不裁剪）。
 */
export function findClipElement(el: Element): Element | null {
  const marked = el.closest('[data-native-clip]')
  if (marked) return marked
  let node: Element | null = el.parentElement
  while (node) {
    const style = getComputedStyle(node)
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY) || /(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      return node
    }
    node = node.parentElement
  }
  return null
}
