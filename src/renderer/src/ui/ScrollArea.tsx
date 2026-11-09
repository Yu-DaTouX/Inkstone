import { forwardRef, useCallback, useEffect, useRef, type HTMLAttributes } from 'react'
import { cx } from './cx'
import './ScrollArea.css'

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  fade?: boolean
  hideScrollbars?: boolean
  viewportClassName?: string
}

const EDGE = 1

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { fade = false, hideScrollbars = false, className, viewportClassName, children, ...props },
  ref
) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const attachRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as { current: HTMLDivElement | null }).current = node
    },
    [ref]
  )

  useEffect(() => {
    const viewport = viewportRef.current
    const root = rootRef.current
    if (!viewport || !root) return undefined
    const update = (): void => {
      const maxY = viewport.scrollHeight - viewport.clientHeight
      const maxX = viewport.scrollWidth - viewport.clientWidth
      const hasY = maxY > EDGE
      const hasX = maxX > EDGE
      if (hasY) root.setAttribute('data-has-overflow-y', '')
      else root.removeAttribute('data-has-overflow-y')
      if (hasX) root.setAttribute('data-has-overflow-x', '')
      else root.removeAttribute('data-has-overflow-x')
      if (!fade) return
      const style = viewport.style
      style.setProperty('--scroll-area-overflow-y-start', hasY ? `${Math.max(0, viewport.scrollTop)}px` : '0px')
      style.setProperty('--scroll-area-overflow-y-end', hasY ? `${Math.max(0, maxY - viewport.scrollTop)}px` : '0px')
      style.setProperty('--scroll-area-overflow-x-start', hasX ? `${Math.max(0, viewport.scrollLeft)}px` : '0px')
      style.setProperty('--scroll-area-overflow-x-end', hasX ? `${Math.max(0, maxX - viewport.scrollLeft)}px` : '0px')
    }
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    for (const child of Array.from(viewport.children)) observer.observe(child)
    const mutations = new MutationObserver(() => {
      observer.disconnect()
      observer.observe(viewport)
      for (const child of Array.from(viewport.children)) observer.observe(child)
      update()
    })
    mutations.observe(viewport, { childList: true })
    viewport.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      observer.disconnect()
      mutations.disconnect()
      viewport.removeEventListener('scroll', update)
    }
  }, [fade])

  return (
    <div {...props} ref={attachRoot} className={cx('ui-scroll-area', className)}>
      <div
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        data-fade={fade ? '' : undefined}
        data-hide-scrollbars={hideScrollbars ? '' : undefined}
        className={cx('ui-scroll-area__viewport', viewportClassName)}
      >
        {children}
      </div>
    </div>
  )
})
