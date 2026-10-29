import { useEffect } from 'react'

const SCROLLING_ATTR = 'data-scrolling'
const HIDE_AFTER_MS = 900

export function useScrollbarReveal(): void {
  useEffect(() => {
    const timers = new Map<Element, number>()
    const onScroll = (event: Event): void => {
      const target = event.target instanceof Element ? event.target : document.scrollingElement
      if (!target) return
      if (!target.hasAttribute(SCROLLING_ATTR)) target.setAttribute(SCROLLING_ATTR, '')
      window.clearTimeout(timers.get(target))
      timers.set(
        target,
        window.setTimeout(() => {
          timers.delete(target)
          target.removeAttribute(SCROLLING_ATTR)
        }, HIDE_AFTER_MS)
      )
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      for (const [target, id] of timers) {
        window.clearTimeout(id)
        target.removeAttribute(SCROLLING_ATTR)
      }
      timers.clear()
    }
  }, [])
}
