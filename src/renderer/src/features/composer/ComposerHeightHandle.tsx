import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react'
import { sanitizeComposerHeight } from '../../../../shared/appearance'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

const KEY_STEP = 16
const KEY_STEP_LARGE = 64
const MAX_VIEWPORT_SHARE = 0.5
const HEIGHT_VAR = '--composer-editor-min-h'

type Bounds = { min: number; max: number }

function editorOf(node: Element): HTMLElement | null {
  return node.closest<HTMLElement>('[data-slot="composer-shell"]')?.querySelector<HTMLElement>('.composer-text') ?? null
}

function boundsOf(editor: HTMLElement): Bounds {
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight)
  const min = Math.ceil(Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20)
  return { min, max: Math.max(min, Math.floor(window.innerHeight * MAX_VIEWPORT_SHARE)) }
}

function clamp(value: number, bounds: Bounds): number {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)))
}

function applyHeight(height: number | undefined): void {
  const root = document.documentElement
  if (height === undefined) root.style.removeProperty(HEIGHT_VAR)
  else root.style.setProperty(HEIGHT_VAR, `${height}px`)
}

export function ComposerHeightHandle(): JSX.Element {
  const t = useT()
  const saved = useStore((s) => sanitizeComposerHeight(s.settings?.composerHeight))
  const dragRef = useRef<{ startY: number; startHeight: number; height: number; bounds: Bounds; frame: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) applyHeight(saved)
  }, [saved, dragging])

  const persist = (height: number | undefined): void => {
    applyHeight(height)
    void useStore.getState().patchSettings({ composerHeight: height }).catch(() => undefined)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const editor = editorOf(event.currentTarget)
    if (!editor) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startHeight = Math.round(editor.getBoundingClientRect().height)
    dragRef.current = { startY: event.clientY, startHeight, height: startHeight, bounds: boundsOf(editor), frame: 0 }
    document.documentElement.dataset.splitterDragging = '1'
    document.body.style.cursor = 'ns-resize'
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    drag.height = clamp(drag.startHeight + drag.startY - event.clientY, drag.bounds)
    if (drag.frame) return
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0
      applyHeight(drag.height)
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
    if (drag.height !== drag.startHeight) persist(drag.height)
    else applyHeight(saved)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const editor = editorOf(event.currentTarget)
    if (!editor) return
    const bounds = boundsOf(editor)
    const current = Math.round(editor.getBoundingClientRect().height)
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    let next: number
    if (event.key === 'ArrowUp') next = current + step
    else if (event.key === 'ArrowDown') next = current - step
    else if (event.key === 'Home') next = bounds.min
    else if (event.key === 'End') next = bounds.max
    else return
    event.preventDefault()
    persist(clamp(next, bounds))
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('composer.heightHandle')}
      aria-valuenow={saved}
      tabIndex={0}
      data-composer-height-handle="true"
      data-dragging={dragging || undefined}
      className="composer-height-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => persist(undefined)}
      onKeyDown={onKeyDown}
    />
  )
}
