import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type Attributes, type CSSProperties, type ReactElement, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { prefersReducedMotion, usePresence } from '../../lib/usePresence'
import { tipScheduler, isTipActive } from '../../lib/tip-scheduler'
import { useStore } from '../../state/store'

/**
 * 统一提示气泡：替代原生 `title`，键盘聚焦也能读到。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不是原生 title
 * ══════════════════════════════════════════════════════════════════
 *   · 约 1 秒才出现，样式由系统决定，不跟深浅主题与字体；
 *   · 键盘聚焦时不显示 —— 只用键盘的人看不到图标按钮是什么；
 *   · 不能排版，标不出快捷键。
 *
 * ── 行为 ──
 *   · 首次鼠标悬停约 400ms 出现；出现过后移到相邻按钮用短延迟切换
 *     （调度规则在 `lib/tip-scheduler.ts`）；
 *   · `:focus-visible`（键盘聚焦）立即出现；
 *   · 任何时刻只显示一个；Esc 只关当前这个；
 *   · 目标元素只在气泡可见时带 `aria-describedby`，弹出层 `role="tooltip"`；
 *   · 气泡不可交互（`pointer-events: none`），不抢 Tab、不建焦点陷阱；
 *   · 显示期间租用 `acquireOverlayBlocker`，内置浏览器（原生视图）不会穿到气泡上面。
 *
 * ── 用法 ──
 *   <Tip label="删除" shortcut={['Delete']}><button … /></Tip>
 *
 * 开关与定时器由 `tipScheduler` 统一管理，离开 / 卸载都会清干净。
 */

const EXIT_MS = 110

/** 聚焦是否来自键盘。`:focus-visible` 不支持时保守地按「是」处理。 */
function focusIsVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return true
  }
}

interface TipPosition {
  style: CSSProperties
  side: 'top' | 'bottom'
}

/**
 * 以触发器真实 rect 定位，夹回视口；空间不够时上下翻转。
 * 打开期间逐帧跟随（缩放、原生窗口过渡、磁贴移动），与 `useAnchoredPopover` 同一节奏。
 */
function useTipPosition(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  tip: RefObject<HTMLDivElement | null>,
  preferred: 'top' | 'bottom'
): TipPosition {
  const [state, setState] = useState<TipPosition>({ style: { top: 0, left: 0, visibility: 'hidden' }, side: preferred })
  useLayoutEffect(() => {
    if (!open) return undefined
    let frame = 0
    let previous = ''
    const margin = 8
    const gap = 6
    const measure = (): void => {
      const a = anchor.current
      const el = tip.current
      if (a && el) {
        const ar = a.getBoundingClientRect()
        const tr = el.getBoundingClientRect()
        const aboveTop = ar.top - tr.height - gap
        const belowTop = ar.bottom + gap
        const roomAbove = ar.top - margin
        const roomBelow = window.innerHeight - ar.bottom - margin
        let side = preferred
        if (preferred === 'top' && roomAbove < tr.height && roomBelow > roomAbove) side = 'bottom'
        else if (preferred === 'bottom' && roomBelow < tr.height && roomAbove > roomBelow) side = 'top'
        const top = Math.max(margin, Math.min(window.innerHeight - tr.height - margin, side === 'top' ? aboveTop : belowTop))
        const left = Math.max(margin, Math.min(window.innerWidth - tr.width - margin, ar.left + ar.width / 2 - tr.width / 2))
        const key = `${Math.round(top)}:${Math.round(left)}:${side}`
        if (key !== previous) {
          previous = key
          setState({
            style: { top, left, visibility: 'visible', transformOrigin: side === 'top' ? 'bottom center' : 'top center' },
            side
          })
        }
      }
      frame = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(frame)
  }, [open, anchor, tip, preferred])
  return state
}

export interface TipProps {
  /** 提示文字（同时作为 `aria-describedby` 的内容） */
  label: string
  /** 可选键位；与 09 的 `KEY_BINDINGS` 同源，不另维护键位表 */
  shortcut?: readonly string[]
  side?: 'top' | 'bottom'
  /** 单个触发元素 */
  children: ReactElement
  className?: string
}

export function Tip({ label, shortcut, side = 'top', children, className }: TipProps) {
  const id = useId()
  const tipId = `tip-${id.replace(/:/g, '')}`
  const [owner] = useState(() => Symbol('tip'))
  const anchor = useRef<HTMLElement | null>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const [shown, setShown] = useState(false)

  const active = isTipActive({ hover, focused })
  const show = useCallback(() => setShown(true), [])
  const hide = useCallback(() => setShown(false), [])
  const { mounted, closing } = usePresence(shown, prefersReducedMotion() ? 1 : EXIT_MS)
  const position = useTipPosition(mounted, anchor, tip, side)

  /* 调度：首次延迟 / 热切换 / 聚焦即时，都交给 tipScheduler */
  useEffect(() => {
    if (!active) {
      tipScheduler.cancel(owner)
      if (tipScheduler.isVisible(owner)) {
        tipScheduler.release(owner)
        setShown(false)
      }
      return undefined
    }
    tipScheduler.request(owner, show, hide, focused)
    return () => tipScheduler.cancel(owner)
  }, [active, focused, owner, show, hide])

  /* 卸载：清掉待开定时器与「可见」登记，避免幽灵气泡 */
  useEffect(() => () => tipScheduler.release(owner), [owner])

  /* Esc 只关当前这个提示；监听只在挂载期间存在 */
  useEffect(() => {
    if (!mounted) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || !tipScheduler.isVisible(owner)) return
      if (tipScheduler.dismiss()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    // 先于 document 上的模态层处理，避免一次 Esc 同时关闭提示与父对话框。
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mounted, owner])

  /* 显示期间占住 overlay：内置浏览器的原生视图不穿透到气泡上面 */
  useEffect(() => {
    if (!mounted) return undefined
    return useStore.getState().acquireOverlayBlocker('tip')
  }, [mounted])

  /* 捕获触发元素，供定位使用；不额外加 ref，避免改动子元素类型 */
  const bind = useCallback((el: HTMLElement | null): void => {
    if (el) anchor.current = el
  }, [])

  /* 点击触发器后不再挂着气泡（如按钮弹出菜单），等指针离开再重新悬停 */
  const onPointerDown = useCallback((): void => {
    tipScheduler.release(owner)
    setShown(false)
  }, [owner])

  const handlers: Record<string, (event: { currentTarget: EventTarget & HTMLElement }) => void> = {
    onPointerEnter: (event) => { bind(event.currentTarget); setHover(true) },
    onPointerLeave: () => setHover(false),
    onPointerDown,
    onFocus: (event) => {
      bind(event.currentTarget)
      if (focusIsVisible(event.currentTarget)) setFocused(true)
    },
    onBlur: () => setFocused(false)
  }

  const childProps = (children.props ?? {}) as Record<string, unknown>
  const existingDescribedBy = childProps['aria-describedby']
  const describedBy = shown
    ? [typeof existingDescribedBy === 'string' ? existingDescribedBy : '', tipId].filter(Boolean).join(' ')
    : (typeof existingDescribedBy === 'string' ? existingDescribedBy : undefined)

  const nextProps: Record<string, unknown> & Attributes = { 'aria-describedby': describedBy }
  for (const [name, handler] of Object.entries(handlers)) {
    const existing = childProps[name]
    nextProps[name] = typeof existing === 'function'
      ? (...args: unknown[]) => {
          ;(existing as (...a: unknown[]) => void)(...args)
          ;(handler as (...a: unknown[]) => void)(...args)
        }
      : handler
  }

  const block = (children.props as Record<string, unknown> | null)?.disabled === true
  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, nextProps)

  return (
    <>
      {block ? (
        <span
          className="ui-tip-anchor"
          onPointerEnter={handlers.onPointerEnter}
          onPointerLeave={handlers.onPointerLeave}
          onPointerDown={handlers.onPointerDown}
          data-tip-anchor="disabled"
        >
          {trigger}
        </span>
      ) : (
        trigger
      )}
      {mounted
        ? createPortal(
            <div
              ref={tip}
              id={tipId}
              role="tooltip"
              data-side={position.side}
              className={['ui-tip', closing && 'closing', className].filter(Boolean).join(' ')}
              style={position.style}
            >
              <span className="ui-tip-label">{label}</span>
              {shortcut && shortcut.length ? (
                <span className="ui-tip-keys">
                  {shortcut.map((key, i) => (
                    <kbd className="ui-kbd" key={`${key}-${i}`}>
                      {key}
                    </kbd>
                  ))}
                </span>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
