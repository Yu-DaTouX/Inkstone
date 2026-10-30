import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
  type UIEvent
} from 'react'
import { cx } from './cx'
import { createListMotion, type ListMotion } from './list-motion'
import { motionAllowed, motionMs, usePresence } from './motion-hooks'
import { compensatedScrollTop, condenseStep } from './motion-model'
import './Motion.css'

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return
  if (typeof ref === 'function') ref(value)
  else (ref as { current: T | null }).current = value
}

export interface AnimatedHeightProps extends HTMLAttributes<HTMLDivElement> {
  holdHeight?: boolean
  children: ReactNode
}

export function AnimatedHeight({ holdHeight = false, className, style, children, ...rest }: AnimatedHeightProps): ReactElement {
  const content = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ height: number | null; clipping: boolean }>({ height: null, clipping: false })

  useEffect(() => {
    if (!box.clipping) return
    const timer = window.setTimeout(() => setBox((current) => (current.clipping ? { ...current, clipping: false } : current)), motionMs('base') + 50)
    return () => window.clearTimeout(timer)
  }, [box.height, box.clipping])

  useLayoutEffect(() => {
    if (holdHeight) return
    const element = content.current
    if (!element) return
    let first = 0
    let second = 0
    const measure = (): void => {
      const next = Math.ceil(element.scrollHeight || element.getBoundingClientRect().height)
      setBox((current) => (current.height === next ? current : { height: next, clipping: current.height !== null && motionAllowed() }))
    }
    const measureAfterPaint = (): void => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
      measure()
      first = requestAnimationFrame(() => {
        measure()
        second = requestAnimationFrame(measure)
      })
    }
    measureAfterPaint()
    const observer = new ResizeObserver(measureAfterPaint)
    observer.observe(element)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [holdHeight])

  return (
    <div
      {...rest}
      className={cx('ui-height', className)}
      data-clipping={holdHeight || box.clipping ? '' : undefined}
      style={box.height === null ? style : { ...style, height: box.height }}
      onTransitionEnd={(event) => {
        rest.onTransitionEnd?.(event)
        if (event.target !== event.currentTarget || event.propertyName !== 'height') return
        setBox((current) => (current.clipping ? { ...current, clipping: false } : current))
      }}
    >
      <div ref={content} className="ui-height__content" style={holdHeight ? { height: '100%' } : undefined}>
        {children}
      </div>
    </div>
  )
}

export interface AnimatedWidthProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode
}

export function AnimatedWidth({ className, style, children, ...rest }: AnimatedWidthProps): ReactElement {
  const content = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const next = Math.ceil(entries[entries.length - 1]?.contentRect.width ?? 0)
      if (next > 0) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <span {...rest} className={cx('ui-width', className)} style={width === null ? style : { ...style, width }}>
      <span ref={content} className="ui-width__content">
        {children}
      </span>
    </span>
  )
}

export interface ExpandProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  open: boolean
  children?: ReactNode
  keepMounted?: boolean
}

export const Expand = forwardRef<HTMLDivElement, ExpandProps>(function Expand({ open, keepMounted = false, className, children, ...rest }, ref) {
  const presence = usePresence(open)
  const kept = useRef<ReactNode>(children)
  if (open) kept.current = children
  const content = open ? children : presence.present || keepMounted ? kept.current : null
  return (
    <div {...rest} ref={ref} className={cx('ui-expand', className)} data-open={open ? '' : undefined} inert={!open}>
      <div className="ui-expand__clip">{content}</div>
    </div>
  )
})

export interface CondensingHeaderState {
  condensed: boolean
  scopeKey: string
  foldRef: (node: HTMLDivElement | null) => void
  compactRef: (node: HTMLDivElement | null) => void
  onScrollCapture: (event: UIEvent<HTMLElement>) => void
  reset: (key?: string) => void
}

export interface CondensingHeaderOptions {
  enterSlack?: number
  exitAt?: number
  accept?: (scroller: HTMLElement) => boolean
}

export function useCondensingHeader(scopeKey: string, { enterSlack, exitAt, accept }: CondensingHeaderOptions = {}): CondensingHeaderState {
  const [memory, setMemory] = useState<Readonly<Record<string, boolean>>>({})
  const condensed = memory[scopeKey] ?? false
  const fold = useRef<HTMLDivElement | null>(null)
  const compact = useRef<HTMLDivElement | null>(null)
  const lastTop = useRef(new WeakMap<HTMLElement, number>())
  const compensation = useRef<{ key: string; scroller: HTMLElement; top: number; anchor: number } | null>(null)

  useLayoutEffect(() => {
    const pending = compensation.current
    if (!pending) return
    compensation.current = null
    if (!condensed || pending.key !== scopeKey || !pending.scroller.isConnected) return
    const target = compensatedScrollTop(pending.top, pending.anchor, pending.scroller.getBoundingClientRect().top)
    pending.scroller.scrollTop = target
    lastTop.current.set(pending.scroller, pending.scroller.scrollTop)
  }, [condensed, scopeKey])

  const foldRef = useCallback((node: HTMLDivElement | null) => {
    fold.current = node
  }, [])
  const compactRef = useCallback((node: HTMLDivElement | null) => {
    compact.current = node
  }, [])

  const onScrollCapture = (event: UIEvent<HTMLElement>): void => {
    const scroller = event.target
    if (!(scroller instanceof HTMLElement)) return
    if (fold.current?.contains(scroller) || compact.current?.contains(scroller)) return
    if (accept && !accept(scroller)) return
    const top = scroller.scrollTop
    const before = lastTop.current.get(scroller)
    lastTop.current.set(scroller, top)
    if (before === top) return
    const step = condenseStep({
      condensed,
      top,
      foldHeight: fold.current?.scrollHeight ?? 0,
      compactHeight: compact.current?.scrollHeight ?? 0,
      enterSlack,
      exitAt
    })
    if (step.condensed === condensed) return
    compensation.current = step.scrollTo === null ? null : { key: scopeKey, scroller, top, anchor: scroller.getBoundingClientRect().top }
    setMemory((current) => ({ ...current, [scopeKey]: step.condensed }))
  }

  const reset = (key = scopeKey): void => {
    setMemory((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  return { condensed, scopeKey, foldRef, compactRef, onScrollCapture, reset }
}

export interface CondensingHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  state: CondensingHeaderState
  compact: ReactNode
  children: ReactNode
}

export function CondensingHeader({ state, compact, className, children, ...rest }: CondensingHeaderProps): ReactElement {
  return (
    <div {...rest} className={cx('ui-condense', className)} data-condensed={state.condensed ? '' : undefined}>
      <div className="ui-condense__row" data-part="compact">
        <div ref={state.compactRef} className="ui-condense__clip" inert={!state.condensed}>
          {compact}
        </div>
      </div>
      <div className="ui-condense__row" data-part="full">
        <div ref={state.foldRef} className="ui-condense__clip" inert={state.condensed}>
          {children}
        </div>
      </div>
    </div>
  )
}

export interface MorphIconProps {
  icon: ReactNode
  iconKey: string
  className?: string
}

export function MorphIcon({ icon, iconKey, className }: MorphIconProps): ReactElement {
  const [shown, setShown] = useState(iconKey)
  const [leaving, setLeaving] = useState<{ key: string; icon: ReactNode } | null>(null)
  const [arriving, setArriving] = useState(false)
  const last = useRef<ReactNode>(icon)
  if (shown !== iconKey) {
    const animate = motionAllowed()
    setShown(iconKey)
    setLeaving(animate ? { key: shown, icon: last.current } : null)
    setArriving(animate)
  }
  useEffect(() => {
    last.current = icon
  })
  useEffect(() => {
    if (!arriving && !leaving) return
    const timer = window.setTimeout(() => {
      setLeaving(null)
      setArriving(false)
    }, motionMs('base'))
    return () => window.clearTimeout(timer)
  }, [arriving, leaving])
  return (
    <span className={cx('ui-morph', className)} aria-hidden="true">
      {leaving && leaving.key !== iconKey ? (
        <span key={`out:${leaving.key}`} className="ui-morph__glyph" data-state="out">
          {leaving.icon}
        </span>
      ) : null}
      <span key={`in:${iconKey}`} className="ui-morph__glyph" data-state={arriving ? 'in' : undefined}>
        {icon}
      </span>
    </span>
  )
}

export interface MotionListProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'ul' | 'ol' | 'section'
  animate?: boolean
  children?: ReactNode
}

export const MotionList = forwardRef<HTMLElement, MotionListProps>(function MotionList({ as = 'div', animate = true, className, children, ...rest }, ref) {
  const node = useRef<HTMLElement | null>(null)
  const engine = useRef<ListMotion | null>(null)
  const attach = useCallback(
    (element: HTMLElement | null) => {
      node.current = element
      assignRef(ref, element)
    },
    [ref]
  )
  useLayoutEffect(() => {
    const element = node.current
    if (!element) return
    const motion = createListMotion(element)
    engine.current = motion
    motion.update(false)
    return () => {
      motion.dispose()
      if (engine.current === motion) engine.current = null
    }
  }, [])
  useLayoutEffect(() => {
    engine.current?.update(animate)
  })
  return createElement(as, { ...rest, ref: attach, className: cx('ui-motion-list', className) }, children)
})
