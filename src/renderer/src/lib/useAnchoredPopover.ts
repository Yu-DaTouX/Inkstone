import { useLayoutEffect, useState, type RefObject } from 'react'

/** Follow the final layout during native window transitions, zoom and tile movement. */
export function useAnchoredPopover(open: boolean, anchor: RefObject<HTMLElement | null>, width: number, height = 560, allowFlip = false, align: 'left' | 'right' = 'right') {
  const [position, setPosition] = useState<{ left?: number; right?: number; bottom: number | undefined; top: number | undefined; width: number; maxHeight: number }>({ right: 12, bottom: 12, top: undefined, width, maxHeight: height })
  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    let previous = ''
    const measure = () => {
      if (anchor.current) {
        const rect = anchor.current.getBoundingClientRect()
        const titlebar = document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0
        const top = Math.max(12, titlebar + 8)
        const availableWidth = Math.min(width, window.innerWidth - 24)
        const bottom = Math.max(12, Math.min(window.innerHeight - top - 1, window.innerHeight - rect.top + 6))
        const belowTop = Math.max(top, rect.bottom + 6)
        const roomBelow = window.innerHeight - belowTop - 12
        const roomAbove = window.innerHeight - bottom - top
        const below = allowFlip && roomAbove < Math.min(height, 220) && roomBelow > roomAbove
        /* right：菜单右缘对齐触发器右缘；left：左缘对齐触发器左缘（触发器靠左时，向右展开，不压到侧栏） */
        const horizontal = align === 'left'
          ? { left: Math.max(12, Math.min(window.innerWidth - availableWidth - 12, rect.left)), right: undefined }
          : { left: undefined, right: Math.max(12, Math.min(window.innerWidth - availableWidth - 12, window.innerWidth - rect.right)) }
        const next = {
          ...horizontal,
          bottom: below ? undefined : bottom, top: below ? belowTop : undefined, width: availableWidth,
          maxHeight: Math.max(1, Math.min(height, window.innerHeight * 0.72, below ? roomBelow : roomAbove))
        }
        const key = JSON.stringify(next)
        if (key !== previous) { previous = key; setPosition(next) }
      }
      frame = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(frame)
  }, [open, anchor, width, height, allowFlip, align])
  return position
}
