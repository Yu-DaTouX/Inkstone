import { useLayoutEffect, useRef } from 'react'

const HEIGHT_MS = 160
const MIN_STEP_PX = 6

function motionReduced(): boolean {
  return (
    document.documentElement.dataset.reduceMotion === 'true' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function useSmoothHeight(el: HTMLElement | null): void {
  const checkRef = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    checkRef.current?.()
  })
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    let height = el.offsetHeight
    let width = el.offsetWidth
    let animation: Animation | null = null
    let target = height
    const settle = (): void => {
      animation = null
      el.style.overflow = ''
      const natural = el.offsetHeight
      height = natural
      if (Math.abs(natural - target) >= MIN_STEP_PX && !motionReduced()) animateFrom(target, natural)
    }
    const animateFrom = (from: number, to: number): void => {
      el.style.overflow = 'clip'
      target = to
      const running = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: HEIGHT_MS,
        easing: 'ease-out'
      })
      animation = running
      const done = (): void => {
        if (animation === running) settle()
      }
      running.addEventListener('finish', done, { once: true })
      running.addEventListener('cancel', done, { once: true })
    }
    checkRef.current = () => {
      if (animation) return
      const natural = el.offsetHeight
      const nextWidth = el.offsetWidth
      const from = height
      const widthChanged = nextWidth !== width
      height = natural
      width = nextWidth
      target = natural
      if (widthChanged || Math.abs(natural - from) < MIN_STEP_PX || motionReduced() || from === 0) return
      animateFrom(from, natural)
    }
    const observer = new ResizeObserver(() => {
      if (animation && el.offsetWidth === width) return
      const shown = animation ? el.getBoundingClientRect().height : height
      animation?.cancel()
      animation = null
      el.style.overflow = ''
      const nextHeight = el.offsetHeight
      const nextWidth = el.offsetWidth
      const widthChanged = nextWidth !== width
      height = nextHeight
      width = nextWidth
      target = nextHeight
      if (widthChanged || Math.abs(nextHeight - shown) < MIN_STEP_PX || motionReduced() || shown === 0) return
      animateFrom(shown, nextHeight)
    })
    observer.observe(el)
    return () => {
      checkRef.current = null
      observer.disconnect()
      const running = animation
      animation = null
      running?.cancel()
      el.style.overflow = ''
    }
  }, [el])
}
