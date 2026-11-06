import { useLayoutEffect } from 'react'

const HEIGHT_MS = 160
const MIN_STEP_PX = 6

function motionReduced(): boolean {
  return (
    document.documentElement.dataset.reduceMotion === 'true' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function useSmoothHeight(el: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    let height = el.offsetHeight
    let width = el.offsetWidth
    let animation: Animation | null = null
    const observer = new ResizeObserver(() => {
      const shown = animation ? el.getBoundingClientRect().height : height
      animation?.cancel()
      animation = null
      el.style.overflow = ''
      const nextHeight = el.offsetHeight
      const nextWidth = el.offsetWidth
      const widthChanged = nextWidth !== width
      const from = shown
      height = nextHeight
      width = nextWidth
      if (widthChanged || Math.abs(nextHeight - from) < MIN_STEP_PX || motionReduced() || from === 0) return
      el.style.overflow = 'clip'
      const running = el.animate([{ height: `${from}px` }, { height: `${nextHeight}px` }], {
        duration: HEIGHT_MS,
        easing: 'ease-out'
      })
      animation = running
      const done = (): void => {
        if (animation !== running) return
        animation = null
        el.style.overflow = ''
        height = el.offsetHeight
      }
      running.addEventListener('finish', done, { once: true })
      running.addEventListener('cancel', done, { once: true })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      animation?.cancel()
      animation = null
      el.style.overflow = ''
    }
  }, [el])
}
