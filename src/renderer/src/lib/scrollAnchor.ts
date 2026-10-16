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
      scroller.scrollTop = scroller.scrollHeight
      return
    }
    const after = anchor.getBoundingClientRect().top
    const delta = Math.round(after - before)
    if (Math.abs(delta) > 1) scroller.scrollTop += delta
  })
}
