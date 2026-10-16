import type { RectLike } from './bounds'

export function rectOf(el: Element): RectLike {
  return el.getBoundingClientRect()
}

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
