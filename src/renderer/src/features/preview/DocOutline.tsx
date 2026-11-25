import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent, type RefObject } from 'react'
import { activeHeading, hoverRail, OUTLINE_CORNER, OUTLINE_MIN_HEADINGS, outlineHeadings, READING_LINE_PX, tickWidth, type OutlineHeading } from './doc-outline'
import { prefersReducedMotion } from '../../lib/reduced-motion'
import './doc-outline.css'

const JUMP_LOCK_MS = 700
const JUMP_TOP_PX = 24
const JUMP_MS = 380

function glide(scroller: HTMLElement, to: number, stop: { current: (() => void) | null }): void {
  stop.current?.()
  const from = scroller.scrollTop
  const target = Math.max(0, Math.min(to, scroller.scrollHeight - scroller.clientHeight))
  if (prefersReducedMotion() || Math.abs(target - from) < 2) {
    scroller.scrollTop = target
    return
  }
  const start = performance.now()
  let frame = 0
  const finish = window.setTimeout(() => cancel(true), JUMP_MS + 120)
  function cancel(land: boolean): void {
    cancelAnimationFrame(frame)
    window.clearTimeout(finish)
    scroller.removeEventListener('wheel', interrupt)
    scroller.removeEventListener('pointerdown', interrupt)
    scroller.removeEventListener('keydown', interrupt)
    if (land) scroller.scrollTop = target
    stop.current = null
  }
  function interrupt(): void {
    cancel(false)
  }
  function step(now: number): void {
    const t = Math.min(1, (now - start) / JUMP_MS)
    scroller.scrollTop = from + (target - from) * (1 - Math.pow(1 - t, 4))
    if (t < 1) frame = requestAnimationFrame(step)
    else cancel(true)
  }
  scroller.addEventListener('wheel', interrupt, { passive: true })
  scroller.addEventListener('pointerdown', interrupt, { passive: true })
  scroller.addEventListener('keydown', interrupt, { passive: true })
  stop.current = () => cancel(false)
  frame = requestAnimationFrame(step)
}

function Rail({ from, y, visible, tone }: { from: number; y: number | null; visible: boolean; tone: 'active' | 'hover' }): JSX.Element {
  const end = y ?? 0
  return (
    <span
      className="v3-docnav-rail"
      data-tone={tone}
      data-visible={visible && y !== null ? '' : undefined}
      aria-hidden
      style={{ '--from': `${from}px`, '--y': `${end}px`, '--corner': `${OUTLINE_CORNER}px` } as CSSProperties}
    >
      <span className="v3-docnav-rail-line" />
      <svg className="v3-docnav-rail-corner" width="12" height="7" viewBox="0 0 12 7" fill="none">
        <path d="M0.5 0a6 6 0 0 0 6 6H12" stroke="currentColor" strokeDasharray="2 2" />
      </svg>
    </span>
  )
}

export function DocOutline({ scrollRef, bodyRef, label }: { scrollRef: RefObject<HTMLElement | null>; bodyRef: RefObject<HTMLElement | null>; label: string }): JSX.Element | null {
  const [headings, setHeadings] = useState<OutlineHeading[]>([])
  const [active, setActive] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [pointer, setPointer] = useState(false)
  const [centers, setCenters] = useState<number[]>([])
  const [ready, setReady] = useState(false)
  const nodesRef = useRef<HTMLElement[]>([])
  const listRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const lockRef = useRef<{ until: number } | null>(null)
  const updateRef = useRef<() => void>(() => undefined)
  const sigRef = useRef('')
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return undefined
    let frame = 0
    const scan = (): void => {
      frame = 0
      const nodes = [...body.querySelectorAll<HTMLElement>('.v3-prose h1, .v3-prose h2, .v3-prose h3, .v3-prose h4')].filter((node) => (node.textContent ?? '').trim())
      const next = outlineHeadings(nodes.map((node) => ({ level: Number(node.tagName.slice(1)), text: node.textContent ?? '' })))
      nodesRef.current = nodes
      const sig = next.map((item) => `${item.depth}:${item.text}`).join('\n')
      if (sig !== sigRef.current) {
        sigRef.current = sig
        setHeadings(next)
      }
      updateRef.current()
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(scan)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(body, { childList: true, subtree: true, characterData: true })
    scan()
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [bodyRef])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return undefined
    let frame = 0
    let timer = 0
    const update = (): void => {
      frame = 0
      if (lockRef.current && performance.now() < lockRef.current.until) return
      lockRef.current = null
      const nodes = nodesRef.current
      if (nodes.length === 0) return
      const top = scroller.getBoundingClientRect().top
      const atEnd = scroller.scrollTop > 0 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4
      setActive(activeHeading(nodes.map((node) => node.getBoundingClientRect().top - top), READING_LINE_PX, atEnd))
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update)
      if (lockRef.current) {
        window.clearTimeout(timer)
        timer = window.setTimeout(schedule, JUMP_LOCK_MS)
      }
    }
    updateRef.current = schedule
    scroller.addEventListener('scroll', schedule, { passive: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(scroller)
    schedule()
    return () => {
      scroller.removeEventListener('scroll', schedule)
      resize.disconnect()
      if (frame) cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      updateRef.current = () => undefined
    }
  }, [scrollRef])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return undefined
    const measure = (): void => setCenters(itemRefs.current.slice(0, headings.length).map((el) => (el ? el.offsetTop + el.offsetHeight / 2 : 0)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [headings])

  useEffect(() => {
    if (centers.length === 0 || ready) return undefined
    const frame = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(frame)
  }, [centers, ready])

  const jump = useCallback((index: number) => {
    const scroller = scrollRef.current
    const node = nodesRef.current[index]
    if (!scroller || !node) return
    lockRef.current = { until: performance.now() + JUMP_LOCK_MS }
    setActive(index)
    const offset = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    glide(scroller, scroller.scrollTop + offset - JUMP_TOP_PX, stopRef)
    updateRef.current()
  }, [scrollRef])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 }
    const step = keys[event.key]
    const from = itemRefs.current.findIndex((el) => el === document.activeElement)
    if (step === undefined && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const last = itemRefs.current.length - 1
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, from + step))
    itemRefs.current[to]?.focus()
  }, [])

  const count = headings.length
  const safeActive = Math.min(active, count - 1)
  const activeY = safeActive >= 0 ? centers[safeActive] ?? null : null
  const hoverY = hover === null ? null : centers[hover] ?? null
  const preview = useMemo(() => hoverRail(activeY, hoverY, pointer, hover, safeActive), [activeY, hoverY, pointer, hover, safeActive])

  if (count < OUTLINE_MIN_HEADINGS) return null

  return (
    <nav className="v3-docnav" aria-label={label} data-ready={ready ? '' : undefined} data-testid="v3-doc-outline" style={{ '--n': count } as CSSProperties}>
      <div className="v3-docnav-ticks" aria-hidden>
        {headings.map((heading, index) => (
          <span
            key={`${index}:${heading.text}`}
            className="v3-docnav-tick"
            data-active={index === safeActive ? '' : undefined}
            style={{ '--w': `${tickWidth(heading.depth)}px` } as CSSProperties}
            onClick={() => jump(index)}
          />
        ))}
      </div>
      <div className="v3-docnav-card" data-testid="v3-doc-outline-card">
        <div ref={listRef} className="v3-docnav-list" onKeyDown={onKeyDown} onPointerLeave={() => setPointer(false)} onBlur={() => setHover(null)}>
          <Rail from={preview.from} y={preview.y} visible={preview.visible} tone="hover" />
          <Rail from={0} y={activeY} visible={activeY !== null} tone="active" />
          {headings.map((heading, index) => (
            <button
              key={`${index}:${heading.text}`}
              ref={(el) => { itemRefs.current[index] = el }}
              type="button"
              className="v3-docnav-item"
              data-active={index === safeActive ? '' : undefined}
              data-testid="v3-doc-outline-item"
              aria-current={index === safeActive ? 'location' : undefined}
              tabIndex={index === safeActive ? 0 : -1}
              style={{ '--depth': heading.depth } as CSSProperties}
              onPointerEnter={() => { setHover(index); setPointer(true) }}
              onFocus={() => setHover(index)}
              onClick={() => jump(index)}
            >
              {heading.text}
            </button>
          ))}
        </div>
      </div>
    </nav>
  )
}
