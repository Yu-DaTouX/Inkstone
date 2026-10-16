import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type Attributes, type CSSProperties, type ReactElement, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { prefersReducedMotion, usePresence } from '../../lib/usePresence'
import { tipScheduler, isTipActive } from '../../lib/tip-scheduler'
import { useStore } from '../../state/store'

const EXIT_MS = 110

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
  label: string
  shortcut?: readonly string[]
  side?: 'top' | 'bottom'
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

  useEffect(() => () => tipScheduler.release(owner), [owner])

  useEffect(() => {
    if (!mounted) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || !tipScheduler.isVisible(owner)) return
      if (tipScheduler.dismiss()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mounted, owner])

  useEffect(() => {
    if (!mounted) return undefined
    return useStore.getState().acquireOverlayBlocker('tip')
  }, [mounted])

  const bind = useCallback((el: HTMLElement | null): void => {
    if (el) anchor.current = el
  }, [])

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
