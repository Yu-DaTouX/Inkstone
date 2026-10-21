import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { cx } from './cx'
import './Splitter.css'

export type SplitterOrientation = 'horizontal' | 'vertical'

export function clampSplitValue(value: number, min: number, max: number): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  if (!Number.isFinite(value)) return lo
  if (value < lo) return lo
  if (value > hi) return hi
  return value
}

export function resolveSplitValue(
  controlled: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  return clampSplitValue(controlled === undefined ? fallback : controlled, min, max)
}

export function splitPointerDelta(
  orientation: SplitterOrientation,
  deltaX: number,
  deltaY: number
): number {
  return orientation === 'horizontal' ? deltaY : deltaX
}

export interface SplitPointerInput {
  orientation: SplitterOrientation
  startValue: number
  startX: number
  startY: number
  clientX: number
  clientY: number
  min: number
  max: number
}

export function splitValueFromPointer(input: SplitPointerInput): number {
  return clampSplitValue(splitRawValueFromPointer(input), input.min, input.max)
}

export function splitRawValueFromPointer(input: SplitPointerInput): number {
  const delta = splitPointerDelta(
    input.orientation,
    input.clientX - input.startX,
    input.clientY - input.startY
  )
  return input.startValue + delta
}

export const SPLIT_TAP_SLOP = 3

export function splitDragCollapses(raw: number, collapseBelow: number | undefined): boolean {
  return typeof collapseBelow === 'number' && Number.isFinite(collapseBelow) && raw < collapseBelow
}

export function splitDragMoved(distance: number, slop: number = SPLIT_TAP_SLOP): boolean {
  return Math.abs(distance) > slop
}

export interface SplitDragFrame {
  hidden: boolean
  value: number | null
}

export function splitDragFrame(
  raw: number,
  options: { collapseBelow?: number; min: number; max: number }
): SplitDragFrame {
  if (splitDragCollapses(raw, options.collapseBelow)) return { hidden: true, value: null }
  return { hidden: false, value: clampSplitValue(raw, options.min, options.max) }
}

export interface SplitPointerLike {
  pointerId: number
  clientX: number
  clientY: number
  button?: number
  isPrimary?: boolean
}

export interface SplitDragSession {
  pointerId: number
  startValue: number
  startX: number
  startY: number
  moved?: boolean
  hidden?: boolean
}

export function beginSplitDrag(event: SplitPointerLike, value: number): SplitDragSession | null {
  if (!Number.isFinite(event.pointerId)) return null
  if (event.button !== undefined && event.button !== 0) return null
  if (event.isPrimary === false) return null
  return {
    pointerId: event.pointerId,
    startValue: value,
    startX: event.clientX,
    startY: event.clientY
  }
}

export function ownsSplitDrag(
  session: SplitDragSession | null,
  event: Pick<SplitPointerLike, 'pointerId'>
): boolean {
  return !!session && session.pointerId === event.pointerId
}

export interface SplitKeyInput {
  key: string
  value: number
  min: number
  max: number
  step?: number
  largeStep?: number
  orientation: SplitterOrientation
  shiftKey?: boolean
}

export function splitValueForKey(input: SplitKeyInput): number | null {
  const { key, value, min, max, orientation } = input
  const base = Number.isFinite(input.step) && (input.step as number) > 0 ? (input.step as number) : 1
  const large = Number.isFinite(input.largeStep) && (input.largeStep as number) > 0 ? (input.largeStep as number) : base * 10
  const step = input.shiftKey ? large : base
  switch (key) {
    case 'ArrowLeft':
      return orientation === 'vertical' ? clampSplitValue(value - step, min, max) : null
    case 'ArrowRight':
      return orientation === 'vertical' ? clampSplitValue(value + step, min, max) : null
    case 'ArrowUp':
      return orientation === 'horizontal' ? clampSplitValue(value - step, min, max) : null
    case 'ArrowDown':
      return orientation === 'horizontal' ? clampSplitValue(value + step, min, max) : null
    case 'Home':
      return Math.min(min, max)
    case 'End':
      return Math.max(min, max)
    default:
      return null
  }
}

export interface SplitterProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    | 'onChange'
    | 'defaultValue'
    | 'value'
    | 'role'
    | 'tabIndex'
    | 'aria-orientation'
    | 'aria-valuenow'
    | 'aria-valuemin'
    | 'aria-valuemax'
    | 'aria-disabled'
  > {
  orientation?: SplitterOrientation
  value?: number
  defaultValue?: number
  min?: number
  max?: number
  step?: number
  largeStep?: number
  isDisabled?: boolean
  collapseBelow?: number
  onChange?: (value: number) => void
  onCollapse?: () => void
  onDragHide?: (hidden: boolean) => void
  onReset?: () => void
}

interface ActiveDrag extends SplitDragSession {
  element: HTMLElement
}

export function Splitter({
  orientation = 'vertical',
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  largeStep,
  isDisabled = false,
  collapseBelow,
  onChange,
  onCollapse,
  onDragHide,
  onReset,
  className,
  onKeyDown,
  onDoubleClick,
  ...props
}: SplitterProps) {
  const resetTarget = (): number =>
    clampSplitValue(defaultValue ?? (min + max) / 2, min, max)
  const [uncontrolled, setUncontrolled] = useState(resetTarget)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<ActiveDrag | null>(null)
  const controlled = value !== undefined
  const current = resolveSplitValue(value, uncontrolled, min, max)

  const commit = (next: number): void => {
    const clamped = clampSplitValue(next, min, max)
    if (clamped === current) return
    if (!controlled) setUncontrolled(clamped)
    onChange?.(clamped)
  }

  const releaseDrag = (pointerId?: number): boolean => {
    const session = dragRef.current
    if (!session) return false
    if (pointerId !== undefined && session.pointerId !== pointerId) return false
    dragRef.current = null
    if (session.element.hasPointerCapture?.(session.pointerId)) {
      session.element.releasePointerCapture(session.pointerId)
    }
    return true
  }

  const endDrag = (pointerId?: number): void => {
    if (releaseDrag(pointerId)) setDragging(false)
  }

  useEffect(
    () => () => {
      if (dragRef.current?.hidden) onDragHide?.(false)
      releaseDrag()
    },
    []
  )

  const cancelDragRef = useRef<() => void>(() => undefined)
  cancelDragRef.current = () => {
    const session = dragRef.current
    if (!session) return
    const wasHidden = session.hidden === true
    session.hidden = false
    endDrag()
    if (wasHidden) onDragHide?.(false)
    const restored = clampSplitValue(session.startValue, min, max)
    if (!controlled) setUncontrolled(restored)
    onChange?.(restored)
  }

  useEffect(() => {
    if (!dragging) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancelDragRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dragging])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (isDisabled || event.button !== 0) return
    const session = beginSplitDrag(event, current)
    if (!session) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { ...session, element: event.currentTarget }
    setDragging(true)
  }

  const reportDragHide = (hidden: boolean): void => {
    const session = dragRef.current
    if (!session || session.hidden === hidden) return
    session.hidden = hidden
    onDragHide?.(hidden)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const session = dragRef.current
    if (!session || !ownsSplitDrag(session, event)) return
    const raw = splitRawValueFromPointer({
      orientation,
      startValue: session.startValue,
      startX: session.startX,
      startY: session.startY,
      clientX: event.clientX,
      clientY: event.clientY,
      min,
      max
    })
    if (splitDragMoved(splitPointerDelta(orientation, event.clientX - session.startX, event.clientY - session.startY))) {
      session.moved = true
    }
    const frame = splitDragFrame(raw, { collapseBelow: onCollapse ? collapseBelow : undefined, min, max })
    if (frame.hidden || frame.value === null) {
      reportDragHide(true)
      return
    }
    reportDragHide(false)
    commit(frame.value)
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const session = dragRef.current
    if (!session || session.pointerId !== event.pointerId) return
    const wasHidden = session.hidden === true
    const collapse = wasHidden || session.moved !== true
    endDrag(event.pointerId)
    if (wasHidden) onDragHide?.(false)
    if (collapse) onCollapse?.()
  }

  const abortDrag = (pointerId?: number): void => {
    const session = dragRef.current
    if (!session) return
    if (pointerId !== undefined && session.pointerId !== pointerId) return
    const wasHidden = session.hidden === true
    endDrag(pointerId)
    if (wasHidden) onDragHide?.(false)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event)
    if (isDisabled || event.defaultPrevented) return
    const next = splitValueForKey({
      key: event.key,
      value: current,
      min,
      max,
      step,
      largeStep,
      orientation,
      shiftKey: event.shiftKey
    })
    if (next === null) return
    event.preventDefault()
    commit(next)
  }

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    onDoubleClick?.(event)
    if (isDisabled) return
    if (onReset) {
      onReset()
      return
    }
    if (!controlled) commit(resetTarget())
  }

  return (
    <div
      {...props}
      role="separator"
      tabIndex={isDisabled ? -1 : 0}
      aria-orientation={orientation}
      aria-valuenow={current}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-disabled={isDisabled || undefined}
      data-dragging={dragging || undefined}
      className={cx('ui-splitter', `ui-splitter--${orientation}`, className)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={(event) => abortDrag(event.pointerId)}
      onLostPointerCapture={(event) => abortDrag(event.pointerId)}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
    />
  )
}
