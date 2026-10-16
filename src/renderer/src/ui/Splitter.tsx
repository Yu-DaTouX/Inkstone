/**
 * 分隔条原语（WP-05）。
 *
 * 只负责「一条可聚焦、可拖动的分隔条」本身：值语义、min/max 夹取、指针拖动、
 * 方向键 / Home / End、ARIA 关系与 disabled。相邻两栏（或两行）怎么分宽高、
 * 分完怎么持久化，都由调用方的版面逻辑决定 —— 这里不读写任何全局状态，也不改
 * workbench / SideBySide 的既有实现。
 *
 * 交互约定沿用 v3 设计：`orientation="vertical"` 是左右分栏的竖线（沿 x 轴取值，
 * 左右方向键调整），`orientation="horizontal"` 是上下分行的横线（沿 y 轴取值，
 * 上下方向键调整）；Home / End 跳到 min / max。拖动用指针捕获，指针离开分隔条
 * 仍然跟手，并在 pointerup / pointercancel / lostpointercapture / 卸载时释放。
 *
 * 值是一个普通数字（像素或任意标量由调用方约定）；默认 0–100，默认值取区间中点。
 */
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

/* ── 纯逻辑：可被 Node 直接单测，不依赖 DOM / React ─────────────────────── */

/**
 * 把值夹到 `[min, max]`（两端顺序无所谓）。非有限值（`NaN` / `±Infinity`）退回下界，
 * 避免拖出 `NaN` 后整个版面塌掉。
 */
export function clampSplitValue(value: number, min: number, max: number): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  if (!Number.isFinite(value)) return lo
  if (value < lo) return lo
  if (value > hi) return hi
  return value
}

/** 受控值优先；未受控时用内部值，并统一夹取。 */
export function resolveSplitValue(
  controlled: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  return clampSplitValue(controlled === undefined ? fallback : controlled, min, max)
}

/** 指针位移在方向轴上的分量：竖线取横向位移，横线取纵向位移。 */
export function splitPointerDelta(
  orientation: SplitterOrientation,
  deltaX: number,
  deltaY: number
): number {
  return orientation === 'horizontal' ? deltaY : deltaX
}

export interface SplitPointerInput {
  orientation: SplitterOrientation
  /** 按下那一刻的值。 */
  startValue: number
  /** 按下时指针坐标。 */
  startX: number
  startY: number
  /** 当前指针坐标。 */
  clientX: number
  clientY: number
  min: number
  max: number
}

/** 由「按下时的值 + 指针位移」算出夹取后的新值。 */
export function splitValueFromPointer(input: SplitPointerInput): number {
  const delta = splitPointerDelta(
    input.orientation,
    input.clientX - input.startX,
    input.clientY - input.startY
  )
  return clampSplitValue(input.startValue + delta, input.min, input.max)
}

export interface SplitPointerLike {
  pointerId: number
  clientX: number
  clientY: number
  /** 0 表示主键（鼠标左键）；缺省视为主键。 */
  button?: number
  /** `false` 表示不是主指针（多指触摸等）；缺省视为可拖动。 */
  isPrimary?: boolean
}

export interface SplitDragSession {
  pointerId: number
  startValue: number
  startX: number
  startY: number
}

/**
 * 开始一次拖动。只接受主键 / 主指针；否则返回 `null`（调用方不应捕获指针）。
 */
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

/** 这次指针事件是否属于当前拖动会话（pointerId 一致）。 */
export function ownsSplitDrag(
  session: SplitDragSession | null,
  event: Pick<SplitPointerLike, 'pointerId'>
): boolean {
  return !!session && session.pointerId === event.pointerId
}

/** 拖动过程中的新值；事件不属于当前会话（或没有会话）时返回 `null`。 */
export function moveSplitDrag(
  session: SplitDragSession | null,
  event: SplitPointerLike,
  options: { orientation: SplitterOrientation; min: number; max: number }
): number | null {
  if (!session || !ownsSplitDrag(session, event)) return null
  return splitValueFromPointer({
    orientation: options.orientation,
    startValue: session.startValue,
    startX: session.startX,
    startY: session.startY,
    clientX: event.clientX,
    clientY: event.clientY,
    min: options.min,
    max: options.max
  })
}

export interface SplitKeyInput {
  key: string
  value: number
  min: number
  max: number
  /** 一次方向键的步长，默认 1。 */
  step?: number
  orientation: SplitterOrientation
  /** 按住 Shift 时步长 ×10。 */
  shiftKey?: boolean
}

/**
 * 键盘新值：
 *   · 竖线响应 ArrowLeft / ArrowRight，横线响应 ArrowUp / ArrowDown；
 *   · Home → 下界，End → 上界；
 *   · 其余按键（含不属于本轴的箭头）返回 `null`，调用方不应 preventDefault。
 */
export function splitValueForKey(input: SplitKeyInput): number | null {
  const { key, value, min, max, orientation } = input
  const base = Number.isFinite(input.step) && (input.step as number) > 0 ? (input.step as number) : 1
  const step = input.shiftKey ? base * 10 : base
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

/* ── 组件 ──────────────────────────────────────────────────────────────── */

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
  /** 竖线（左右分栏）或横线（上下分行），默认 `vertical`。 */
  orientation?: SplitterOrientation
  /** 受控值；给出后组件不再自持状态，只通过 `onChange` 请求更新。 */
  value?: number
  /** 非受控初始值；缺省取 `[min, max]` 中点。 */
  defaultValue?: number
  /** 下界，默认 0。 */
  min?: number
  /** 上界，默认 100。 */
  max?: number
  /** 方向键步长，默认 1。 */
  step?: number
  /** 禁用：不可聚焦、不响应指针与键盘，`aria-disabled="true"`。 */
  isDisabled?: boolean
  /** 值变化（拖动或键盘）时触发，已夹取。 */
  onChange?: (value: number) => void
  /** 双击重置：给了回调交由调用方处理；未受控时默认回到 `defaultValue` / 中点。 */
  onReset?: () => void
}

interface ActiveDrag extends SplitDragSession {
  /** 拿到指针捕获的元素，用于在结束 / 卸载时释放。 */
  element: HTMLElement
}

/**
 * 可访问的分隔条。`aria-controls` 指向被调整的面板，`aria-valuenow` 报告当前位置；
 * 键盘与指针都会经过同一套夹取，调用方只需处理最终的 `onChange`。
 */
export function Splitter({
  orientation = 'vertical',
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  isDisabled = false,
  onChange,
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

  /** 释放指针捕获并清掉会话；返回是否真的结束了一次拖动。幂等。 */
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

  /* 卸载时释放仍持有的指针捕获，避免拖动中切走留下悬挂的捕获。 */
  useEffect(
    () => () => {
      releaseDrag()
    },
    []
  )

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (isDisabled || event.button !== 0) return
    const session = beginSplitDrag(event, current)
    if (!session) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { ...session, element: event.currentTarget }
    setDragging(true)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const next = moveSplitDrag(dragRef.current, event, { orientation, min, max })
    if (next === null) return
    commit(next)
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    endDrag(event.pointerId)
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
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
    />
  )
}
