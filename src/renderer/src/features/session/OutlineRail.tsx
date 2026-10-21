import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type JSX, type KeyboardEvent } from 'react'
import { useT } from '../../i18n'
import type { UIMessage } from '../../../../shared/ipc'
import { createOutlineProjector } from '../../../../shared/outline-turns'
import './rail.css'

const OPEN_DELAY_MS = 70
const CLOSE_DELAY_MS = 220
const READING_LINE_RATIO = 0.25
const READING_LINE_MAX_PX = 120

export function userTurnRenderIndex(turns: readonly { kind: string }[], userIndex: number): number | undefined {
  const userTurns: number[] = []
  turns.forEach((turn, index) => {
    if (turn.kind === 'user') userTurns.push(index)
  })
  return userTurns[userIndex]
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function turnIndexAt(nodes: ArrayLike<HTMLElement>, at: number, indexById: ReadonlyMap<string, number>): number {
  for (let i = at; i >= 0; i--) {
    const index = indexById.get(nodes[i].dataset.turnId ?? '')
    if (index !== undefined) return index
  }
  for (let i = at + 1; i < nodes.length; i++) {
    const index = indexById.get(nodes[i].dataset.turnId ?? '')
    if (index !== undefined) return Math.max(0, index - 1)
  }
  return -1
}

function locateActiveTurn(stream: HTMLElement, indexById: ReadonlyMap<string, number>): number {
  const nodes = stream.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')
  if (nodes.length === 0 || indexById.size === 0) return -1
  const scrollable = stream.scrollHeight > stream.clientHeight + 1
  if (scrollable && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 4) return indexById.size - 1
  const box = stream.getBoundingClientRect()
  const readingLine = box.top + Math.min(box.height * READING_LINE_RATIO, READING_LINE_MAX_PX)
  let low = 0
  let high = nodes.length - 1
  let found = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (nodes[mid].getBoundingClientRect().top <= readingLine) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return turnIndexAt(nodes, found, indexById)
}

function revealWithin(container: HTMLElement | null, index: number, center: boolean): void {
  const row = container?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  if (!container || !row) return
  const top = row.offsetTop
  const bottom = top + row.offsetHeight
  if (center) {
    container.scrollTop = Math.max(0, top - (container.clientHeight - row.offsetHeight) / 2)
  } else if (top < container.scrollTop) {
    container.scrollTop = top
  } else if (bottom > container.scrollTop + container.clientHeight) {
    container.scrollTop = bottom - container.clientHeight
  }
}

export interface OutlineRailProps {
  messages: UIMessage[]
  streamingId?: string
  onJump: (index: number) => void
  className?: string
}

function OutlineRailView({ messages, streamingId, onJump, className }: OutlineRailProps): JSX.Element | null {
  const t = useT()
  const projectOutline = useMemo(() => createOutlineProjector(), [])
  const turns = useMemo(() => projectOutline(messages, streamingId), [messages, streamingId, projectOutline])
  const lines = useMemo(() => turns.map((turn) => firstLine(turn.user)), [turns])
  const indexById = useMemo(() => new Map(turns.map((turn, index) => [turn.msgId, index])), [turns])
  const visible = turns.length >= 2

  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const [listMounted, setListMounted] = useState(false)
  if (open && !listMounted) setListMounted(true)
  const [focusIndex, setFocusIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const scheduleRef = useRef<(() => void) | undefined>(undefined)
  const indexByIdRef = useRef(indexById)
  indexByIdRef.current = indexById

  const current = active >= 0 && active < turns.length ? active : turns.length - 1
  const tabStop = focusIndex >= 0 && focusIndex < turns.length ? focusIndex : current

  const clearTimer = useCallback(() => {
    if (timerRef.current === undefined) return
    window.clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])

  const openSoon = useCallback(() => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      setOpen(true)
    }, OPEN_DELAY_MS)
  }, [clearTimer])

  const closeSoon = useCallback(() => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      setOpen(false)
      setFocusIndex(-1)
    }, CLOSE_DELAY_MS)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  useEffect(() => {
    const root = rootRef.current
    const host = root?.parentElement
    if (!visible || !root || !host) return undefined
    let frame = 0
    const update = (): void => {
      frame = 0
      const stream = host.querySelector<HTMLElement>('.v3-stream')
      if (!stream) return
      const next = locateActiveTurn(stream, indexByIdRef.current)
      if (next >= 0) setActive(next)
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && root.contains(event.target)) return
      schedule()
    }
    host.addEventListener('scroll', onScroll, { capture: true, passive: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(host)
    scheduleRef.current = schedule
    schedule()
    return () => {
      host.removeEventListener('scroll', onScroll, { capture: true })
      resize.disconnect()
      if (frame) cancelAnimationFrame(frame)
      scheduleRef.current = undefined
    }
  }, [visible])

  useEffect(() => {
    scheduleRef.current?.()
  }, [turns])

  useEffect(() => {
    revealWithin(trackRef.current, current, false)
  }, [current, visible])

  useEffect(() => {
    if (open) revealWithin(listRef.current, current, true)
  }, [open])

  useEffect(() => {
    if (open && focusIndex >= 0) revealWithin(listRef.current, focusIndex, false)
  }, [open, focusIndex])

  const focusTick = useCallback((index: number) => {
    const next = Math.max(0, Math.min(turns.length - 1, index))
    trackRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus()
  }, [turns.length])

  const onFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const index = Number(target.dataset.index)
    if (!Number.isInteger(index) || !target.matches(':focus-visible')) return
    clearTimer()
    setFocusIndex(index)
    setOpen(true)
  }, [clearTimer])

  const onBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    clearTimer()
    setFocusIndex(-1)
    setOpen(false)
  }, [clearTimer])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const from = focusIndex >= 0 ? focusIndex : current
    if (event.key === 'Escape') {
      if (!open) return
      event.preventDefault()
      clearTimer()
      setOpen(false)
      return
    }
    const target = event.key === 'ArrowDown' ? from + 1
      : event.key === 'ArrowUp' ? from - 1
      : event.key === 'Home' ? 0
      : event.key === 'End' ? turns.length - 1
      : undefined
    if (target === undefined) return
    event.preventDefault()
    setOpen(true)
    focusTick(target)
  }, [focusIndex, current, open, turns.length, clearTimer, focusTick])

  if (!visible) return null

  return (
    <div
      ref={rootRef}
      className={`v3-rail ${className ?? ''}`.trim()}
      data-testid="v3-outline-rail"
      data-open={open ? '' : undefined}
      onPointerEnter={openSoon}
      onPointerLeave={closeSoon}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="v3-rail-dock">
        <div className="v3-rail-zone" data-testid="v3-outline-zone" aria-hidden />
        <nav ref={trackRef} className="v3-rail-track" aria-label={t('outline.label')} onKeyDown={onKeyDown}>
          {turns.map((turn, index) => (
            <button
              key={turn.msgId}
              type="button"
              className="v3-rail-tick"
              data-testid="v3-outline-tick"
              data-index={index}
              title={turn.user}
              aria-label={t('outline.tick', { n: index + 1 })}
              aria-current={index === current ? 'location' : undefined}
              tabIndex={index === tabStop ? 0 : -1}
              style={{ '--i': Math.min(index, 14) } as CSSProperties}
              onClick={() => onJump(index)}
            >
              <span className="v3-rail-bar" />
            </button>
          ))}
        </nav>
      </div>
      <div className="v3-rail-card" data-testid="v3-outline-card" aria-hidden>
        <div className="v3-rail-card-head">
          <span className="v3-rail-card-title">{t('outline.label')}</span>
          <span className="v3-rail-card-count">{turns.length}</span>
        </div>
        <ol ref={listRef} className="v3-rail-list">
          {(listMounted || open) && turns.map((turn, index) => (
            <li key={turn.msgId}>
              <button
                type="button"
                className="v3-rail-item"
                data-testid="v3-outline-item"
                data-index={index}
                data-current={index === current ? '' : undefined}
                data-focus={open && index === focusIndex ? '' : undefined}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onJump(index)}
              >
                <span className="v3-rail-num">{index + 1}</span>
                <span className="v3-rail-text">{lines[index] || t('outline.tick', { n: index + 1 })}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

export const OutlineRail = memo(OutlineRailView)
