import { useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react'
import { STREAM_WIDTH_MAX, STREAM_WIDTH_MIN, sanitizeStreamWidth } from '../../../../shared/appearance'
import tokens from '../../design/tokens.json'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

const KEY_STEP = 16
const KEY_STEP_LARGE = 64

type Side = 'left' | 'right'

function measureWidthCeiling(shell: HTMLElement): number {
  const root = document.documentElement
  const previous = root.style.getPropertyValue('--size-chat')
  const fits = (width: number): boolean => {
    root.style.setProperty('--size-chat', `${width}px`)
    return shell.getBoundingClientRect().width >= width - 1
  }
  let low = STREAM_WIDTH_MIN
  let high = STREAM_WIDTH_MAX
  if (fits(high)) low = high
  else {
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      if (fits(middle)) low = middle
      else high = middle
    }
  }
  if (previous) root.style.setProperty('--size-chat', previous)
  else root.style.removeProperty('--size-chat')
  return low
}

export function ComposerWidthHandles(): JSX.Element {
  const t = useT()
  const saved = useStore((s) => sanitizeStreamWidth(s.settings?.streamWidth)) ?? tokens.size.chat
  const dragRef = useRef<{ side: Side; startX: number; startWidth: number; ceiling: number; width: number; frame: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const persist = (width: number | undefined): void => {
    void useStore.getState().patchSettings({ streamWidth: width }).catch(() => undefined)
  }

  const onPointerDown = (side: Side) => (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const shell = event.currentTarget.closest<HTMLElement>('[data-slot="composer-shell"]')
    if (!shell) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    document.documentElement.dataset.splitterDragging = '1'
    const ceiling = measureWidthCeiling(shell)
    const startWidth = Math.min(ceiling, Math.round(shell.getBoundingClientRect().width))
    document.documentElement.style.setProperty('--size-chat', `${startWidth}px`)
    dragRef.current = { side, startX: event.clientX, startWidth, ceiling, width: startWidth, frame: 0 }
    document.body.style.cursor = 'ew-resize'
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const delta = (event.clientX - drag.startX) * (drag.side === 'right' ? 1 : -1)
    drag.width = Math.min(drag.ceiling, sanitizeStreamWidth(drag.startWidth + delta * 2) ?? drag.startWidth)
    if (drag.frame) return
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0
      document.documentElement.style.setProperty('--size-chat', `${drag.width}px`)
    })
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (drag.frame) cancelAnimationFrame(drag.frame)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    delete document.documentElement.dataset.splitterDragging
    document.body.style.cursor = ''
    setDragging(false)
    document.documentElement.style.setProperty('--size-chat', `${drag.width}px`)
    if (drag.width !== saved) persist(drag.width)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const shell = event.currentTarget.closest<HTMLElement>('[data-slot="composer-shell"]')
    const ceiling = shell ? measureWidthCeiling(shell) : STREAM_WIDTH_MAX
    const current = Math.min(ceiling, saved)
    let next: number | undefined
    if (event.key === 'ArrowRight') next = Math.min(ceiling, current + step)
    else if (event.key === 'ArrowLeft') next = current - step
    else if (event.key === 'Home') next = STREAM_WIDTH_MIN
    else if (event.key === 'End') next = ceiling
    else return
    event.preventDefault()
    persist(sanitizeStreamWidth(next))
  }

  const handle = (side: Side): JSX.Element => (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('set.streamWidth')}
      aria-valuemin={STREAM_WIDTH_MIN}
      aria-valuemax={STREAM_WIDTH_MAX}
      aria-valuenow={saved}
      tabIndex={0}
      data-composer-width-handle={side}
      data-dragging={dragging || undefined}
      className="composer-width-handle"
      onPointerDown={onPointerDown(side)}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => persist(undefined)}
      onKeyDown={onKeyDown}
    />
  )

  return (
    <>
      {handle('left')}
      {handle('right')}
    </>
  )
}
