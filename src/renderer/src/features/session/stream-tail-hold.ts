const BLANK_LIMIT_OF_VIEWPORT = 0.5
const USER_TOGGLE_PAUSE_MS = 700

function naturalHeight(el: HTMLElement, top: number): number {
  const style = getComputedStyle(el)
  const last = el.lastElementChild
  const end = last
    ? last.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(last).marginBottom) || 0)
    : top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0)
  return end - top + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0)
}

export function heldTailHeight(current: number, natural: number, visibleBottom: number, viewport: number): number {
  const kept = Math.max(natural, Math.min(current, visibleBottom))
  return Math.min(kept, natural + viewport * BLANK_LIMIT_OF_VIEWPORT)
}

export function holdStreamTail(scroller: HTMLElement, findTail: () => HTMLElement | null): () => void {
  let target: HTMLElement | null = null
  let written = ''
  let paddingBottom: string | null = null
  let frame = 0
  let pausedUntil = 0
  let resume = 0
  const release = (): void => {
    if (target) target.style.minHeight = ''
    target = null
    written = ''
    paddingBottom = null
  }
  const sync = (): void => {
    const tail = findTail()
    if (tail !== target) {
      release()
      target = tail
    }
    if (!target) return
    if (performance.now() < pausedUntil) {
      release()
      return
    }
    observer.observe(target)
    if (target.lastElementChild) observer.observe(target.lastElementChild)
    const padding = getComputedStyle(target).paddingBottom
    if (paddingBottom !== null && paddingBottom !== padding) {
      target.style.minHeight = ''
      written = ''
    }
    paddingBottom = padding
    const rect = target.getBoundingClientRect()
    const natural = naturalHeight(target, rect.top)
    const held = heldTailHeight(rect.height, natural, scroller.getBoundingClientRect().bottom - rect.top, scroller.clientHeight)
    const value = `${Math.ceil(held)}px`
    if (value === written) return
    written = value
    target.style.minHeight = value
  }
  const observer = new ResizeObserver(() => onScroll())
  const onToggle = (event: Event): void => {
    const tail = target ?? findTail()
    const hit = event.target instanceof Element ? event.target.closest('button, [role="button"], [aria-expanded]') : null
    if (!tail || !hit || !tail.contains(hit)) return
    pausedUntil = performance.now() + USER_TOGGLE_PAUSE_MS
    release()
    clearTimeout(resume)
    resume = window.setTimeout(sync, USER_TOGGLE_PAUSE_MS + 50)
  }
  const onScroll = (): void => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      sync()
    })
  }
  sync()
  scroller.addEventListener('scroll', onScroll, { passive: true })
  scroller.addEventListener('click', onToggle, true)
  return () => {
    cancelAnimationFrame(frame)
    clearTimeout(resume)
    scroller.removeEventListener('scroll', onScroll)
    scroller.removeEventListener('click', onToggle, true)
    observer.disconnect()
    release()
  }
}
