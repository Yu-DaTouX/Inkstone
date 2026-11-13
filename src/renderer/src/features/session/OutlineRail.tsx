import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { ChevronDown, ChevronUp } from '../../ui/icons'
import { useT } from '../../i18n'
import { CONTROL_ICON_SIZE, IconButton } from '../../ui'
import type { UIMessage } from '../../../../shared/ipc'
import { createOutlineProjector, type OutlineTurn } from '../../../../shared/outline-turns'
import { clampTurn, MINIMAP_MIN_TURNS, MINIMAP_PAGE_STEP, minimapIndexAt, minimapTopPercent, turnLine, turnPreview, valueTextLine, type TurnPreview, type TurnRange } from './outline-minimap'
import './rail.css'

const READING_LINE_RATIO = 0.25
const READING_LINE_MAX_PX = 120
const PRECISION_DELAY_MS = 120
const PENDING_JUMP_MS = 1500
const DENSE_SPACING_PX = 3
const LINE_DELTA_PX = 16

export function userTurnRenderIndex(turns: readonly { kind: string }[], userIndex: number): number | undefined {
  const userTurns: number[] = []
  turns.forEach((turn, index) => {
    if (turn.kind === 'user') userTurns.push(index)
  })
  return userTurns[userIndex]
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

function lastIndexWhere(nodes: ArrayLike<HTMLElement>, test: (node: HTMLElement) => boolean): number {
  let low = 0
  let high = nodes.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (test(nodes[mid])) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

interface StreamScan {
  current: number
  range: TurnRange | undefined
}

function scanStream(stream: HTMLElement, indexById: ReadonlyMap<string, number>): StreamScan {
  const nodes = stream.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')
  if (nodes.length === 0 || indexById.size === 0) return { current: -1, range: undefined }
  const box = stream.getBoundingClientRect()
  const atEnd = stream.scrollHeight > stream.clientHeight + 1 && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 4
  const readingLine = box.top + Math.min(box.height * READING_LINE_RATIO, READING_LINE_MAX_PX)
  const reading = lastIndexWhere(nodes, (node) => node.getBoundingClientRect().top <= readingLine)
  const current = atEnd ? indexById.size - 1 : turnIndexAt(nodes, Math.max(0, reading), indexById)
  const above = lastIndexWhere(nodes, (node) => node.getBoundingClientRect().bottom <= box.top)
  const before = lastIndexWhere(nodes, (node) => node.getBoundingClientRect().top < box.bottom)
  const from = above + 1
  if (before < from) return { current, range: undefined }
  const first = turnIndexAt(nodes, from, indexById)
  const last = turnIndexAt(nodes, before, indexById)
  if (first < 0 || last < 0) return { current, range: undefined }
  return { current, range: { first, last: Math.max(first, last) } }
}

function tickAt(box: HTMLElement | null, index: number): Element | null {
  return index >= 0 ? box?.children.item(index) ?? null : null
}

type Edge = 'none' | 'start' | 'end' | 'both'

function edgeOf(index: number, count: number): Edge {
  const start = index <= 0
  const end = index >= count - 1
  return start && end ? 'both' : start ? 'start' : end ? 'end' : 'none'
}

interface Preview {
  index: number
  open: boolean
}

interface ShownCard {
  index: number
  count: number
  failed: boolean
  text: TurnPreview
}

const CLOSED: Preview = { index: -1, open: false }

interface OutlineRailProps {
  messages: UIMessage[]
  streamingId?: string
  onJump: (index: number) => void
  readActiveIndex?: () => number | undefined
  readRange?: () => TurnRange | undefined
  className?: string
}

function OutlineRailView({ messages, streamingId, onJump, readActiveIndex, readRange, className }: OutlineRailProps): JSX.Element | null {
  const t = useT()
  const projectOutline = useMemo(() => createOutlineProjector(), [])
  const turns = useMemo(() => projectOutline(messages, streamingId), [messages, streamingId, projectOutline])
  const count = turns.length
  const hasTurns = count > 0
  const visible = count >= MINIMAP_MIN_TURNS
  const indexById = useMemo(() => new Map(turns.map((turn, index) => [turn.msgId, index])), [turns])
  const tickSig = useMemo(() => turns.map((turn) => (turn.failed ? `${turn.msgId}\u0001` : turn.msgId)).join('\u0000'), [turns])

  const [preview, setPreview] = useState<Preview>(CLOSED)
  const [edge, setEdge] = useState<Edge>('end')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const ticksRef = useRef<HTMLDivElement | null>(null)
  const laneRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const scheduleRef = useRef<(() => void) | undefined>(undefined)
  const currentRef = useRef(-1)
  const currentElRef = useRef<Element | null>(null)
  const bandRef = useRef<TurnRange>({ first: -1, last: -2 })
  const repaintRef = useRef(true)
  const pendingRef = useRef<{ index: number; at: number } | null>(null)
  const previewOpenRef = useRef(false)
  const shownRef = useRef<ShownCard | null>(null)
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const indexByIdRef = useRef(indexById)
  indexByIdRef.current = indexById
  const readActiveIndexRef = useRef(readActiveIndex)
  readActiveIndexRef.current = readActiveIndex
  const readRangeRef = useRef(readRange)
  readRangeRef.current = readRange
  const onJumpRef = useRef(onJump)
  onJumpRef.current = onJump
  const tRef = useRef(t)
  tRef.current = t

  const syncAria = useCallback((index: number) => {
    const track = trackRef.current
    const list = turnsRef.current
    if (!track || list.length === 0) return
    const at = clampTurn(index < 0 ? list.length - 1 : index, list.length)
    const line = valueTextLine(turnLine(list[at]))
    const text = line ? tRef.current('outline.value', { n: at + 1, text: line }) : tRef.current('outline.tick', { n: at + 1 })
    if (track.getAttribute('aria-valuenow') !== String(at + 1)) track.setAttribute('aria-valuenow', String(at + 1))
    if (track.getAttribute('aria-valuetext') !== text) track.setAttribute('aria-valuetext', text)
  }, [])

  const paint = useCallback((range: TurnRange | undefined, current: number) => {
    const box = ticksRef.current
    const total = turnsRef.current.length
    if (!box || total === 0) return
    const valid = !!range && range.last >= 0 && range.first <= range.last
    const first = valid ? clampTurn(range.first, total) : -1
    const last = valid ? clampTurn(range.last, total) : -2
    const prior = bandRef.current
    if (repaintRef.current || first !== prior.first || last !== prior.last) {
      const from = repaintRef.current ? 0 : Math.max(0, Math.min(prior.first, first))
      const to = repaintRef.current ? total - 1 : Math.min(total - 1, Math.max(prior.last, last))
      for (let i = from; i <= to; i++) {
        const tick = box.children.item(i)
        const on = i >= first && i <= last
        if (tick && tick.hasAttribute('data-in-view') !== on) tick.toggleAttribute('data-in-view', on)
      }
      bandRef.current = { first, last }
      repaintRef.current = false
      const lane = laneRef.current
      if (lane) {
        lane.toggleAttribute('data-band', first >= 0)
        lane.style.setProperty('--band-a', String(minimapTopPercent(Math.max(0, first), total) / 100))
        lane.style.setProperty('--band-b', String(minimapTopPercent(Math.max(0, last), total) / 100))
      }
    }
    const at = current >= 0 ? clampTurn(current, total) : -1
    const el = tickAt(box, at)
    if (currentElRef.current !== el || (el && !el.hasAttribute('data-current'))) {
      currentElRef.current?.removeAttribute('data-current')
      el?.setAttribute('data-current', '')
      currentElRef.current = el
    }
    if (at >= 0) currentRef.current = at
    const pending = pendingRef.current
    if (pending && (pending.index === at || performance.now() - pending.at > PENDING_JUMP_MS)) pendingRef.current = null
    setEdge(edgeOf(pendingRef.current?.index ?? currentRef.current, total))
    if (!previewOpenRef.current) syncAria(currentRef.current)
  }, [syncAria])

  const jump = useCallback((index: number) => {
    const total = turnsRef.current.length
    if (total === 0) return
    const target = clampTurn(index, total)
    pendingRef.current = { index: target, at: performance.now() }
    setEdge(edgeOf(target, total))
    onJumpRef.current(target)
  }, [])

  const stepBy = useCallback((delta: number) => {
    jump((pendingRef.current?.index ?? currentRef.current) + delta)
  }, [jump])

  const indexAtPointer = useCallback((clientY: number): number => {
    const box = ticksRef.current
    const total = turnsRef.current.length
    if (!box || total === 0) return -1
    const rect = box.getBoundingClientRect()
    return minimapIndexAt(clientY - rect.top, rect.height, total)
  }, [])

  const show = useCallback((index: number) => {
    setPreview((prev) => (prev.open && prev.index === index ? prev : { index, open: true }))
  }, [])

  const hide = useCallback(() => {
    setPreview((prev) => (prev.open ? { index: prev.index, open: false } : prev))
  }, [])

  useLayoutEffect(() => {
    const chat = hasTurns ? rootRef.current?.closest<HTMLElement>('.v3-chat') : null
    if (!chat) return undefined
    chat.dataset.outline = ''
    return () => {
      delete chat.dataset.outline
    }
  }, [hasTurns])

  useEffect(() => {
    const root = rootRef.current
    const host = root?.parentElement
    if (!visible || !root || !host) return undefined
    let frame = 0
    let precisionTimer = 0
    const streamOf = (): HTMLElement | null => host.querySelector<HTMLElement>('.v3-stream')
    const measure = (): void => {
      const box = ticksRef.current
      const total = turnsRef.current.length
      if (!box || total < 2) return
      const dense = box.clientHeight / (total - 1) < DENSE_SPACING_PX
      if (root.hasAttribute('data-dense') !== dense) root.toggleAttribute('data-dense', dense)
    }
    const update = (): void => {
      frame = 0
      measure()
      const stream = streamOf()
      let scan: StreamScan | undefined
      const scanned = (): StreamScan => (scan ??= stream ? scanStream(stream, indexByIdRef.current) : { current: -1, range: undefined })
      const range = readRangeRef.current?.() ?? scanned().range
      const current = readActiveIndexRef.current?.() ?? scanned().current
      paint(range ?? (current >= 0 ? { first: current, last: current } : undefined), current)
    }
    const refine = (): void => {
      const stream = streamOf()
      if (!stream) return
      const scan = scanStream(stream, indexByIdRef.current)
      if (scan.current < 0 && !scan.range) return
      paint(scan.range ?? (bandRef.current.first >= 0 ? bandRef.current : undefined), scan.current >= 0 ? scan.current : currentRef.current)
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update)
      window.clearTimeout(precisionTimer)
      precisionTimer = window.setTimeout(refine, PRECISION_DELAY_MS)
    }
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && root.contains(event.target)) return
      schedule()
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return
      const stream = streamOf()
      if (!stream) return
      event.preventDefault()
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_DELTA_PX : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? stream.clientHeight : 1
      stream.scrollBy({ top: event.deltaY * unit })
    }
    host.addEventListener('scroll', onScroll, { capture: true, passive: true })
    root.addEventListener('wheel', onWheel, { passive: false })
    const resize = new ResizeObserver(schedule)
    resize.observe(host)
    scheduleRef.current = schedule
    repaintRef.current = true
    schedule()
    return () => {
      host.removeEventListener('scroll', onScroll, { capture: true })
      root.removeEventListener('wheel', onWheel)
      resize.disconnect()
      if (frame) cancelAnimationFrame(frame)
      window.clearTimeout(precisionTimer)
      scheduleRef.current = undefined
      currentElRef.current = null
      bandRef.current = { first: -1, last: -2 }
    }
  }, [visible, paint])

  useEffect(() => {
    repaintRef.current = true
    scheduleRef.current?.()
  }, [tickSig])

  useEffect(() => {
    scheduleRef.current?.()
  }, [turns])

  useLayoutEffect(() => {
    previewOpenRef.current = preview.open
    const box = ticksRef.current
    const center = preview.open ? preview.index : -1
    if (box) {
      for (const tick of box.querySelectorAll<HTMLElement>('[data-near]')) {
        if (center < 0 || Math.abs(Number(tick.dataset.index) - center) > 2) tick.removeAttribute('data-near')
      }
      for (let i = center - 2; center >= 0 && i <= center + 2; i++) {
        const tick = tickAt(box, i)
        const near = String(Math.abs(i - center))
        if (tick && tick.getAttribute('data-near') !== near) tick.setAttribute('data-near', near)
      }
    }
    syncAria(preview.open ? preview.index : currentRef.current)
    const card = cardRef.current
    const root = rootRef.current
    if (!card || !root || !box) return
    if (!preview.open) {
      card.removeAttribute('data-follow')
      return
    }
    const rootRect = root.getBoundingClientRect()
    const rect = box.getBoundingClientRect()
    const y = rect.top - rootRect.top + (minimapTopPercent(preview.index, turnsRef.current.length) / 100) * rect.height
    const height = card.offsetHeight
    const top = Math.max(0, Math.min(rootRect.height - height, y - height / 2))
    card.style.setProperty('--card-y', `${Math.round(top)}px`)
    if (!card.hasAttribute('data-follow')) {
      requestAnimationFrame(() => {
        if (previewOpenRef.current) card.setAttribute('data-follow', '')
      })
    }
  }, [preview, tickSig, syncAria])

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const index = indexAtPointer(event.clientY)
    if (index >= 0) show(index)
  }, [indexAtPointer, show])

  const onPointerLeave = useCallback(() => {
    if (trackRef.current && document.activeElement === trackRef.current) return
    hide()
  }, [hide])

  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const index = indexAtPointer(event.clientY)
    if (index >= 0) jump(index)
  }, [indexAtPointer, jump])

  const onFocus = useCallback(() => {
    const total = turnsRef.current.length
    if (total === 0) return
    setPreview((prev) => (prev.open ? prev : { index: clampTurn(currentRef.current < 0 ? total - 1 : currentRef.current, total), open: true }))
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const total = turnsRef.current.length
    if (total === 0) return
    const from = preview.open ? preview.index : clampTurn(currentRef.current < 0 ? total - 1 : currentRef.current, total)
    if (event.key === 'Escape') {
      if (!preview.open) return
      event.preventDefault()
      event.stopPropagation()
      hide()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      show(from)
      jump(from)
      return
    }
    const target = event.key === 'ArrowDown' ? from + 1
      : event.key === 'ArrowUp' ? from - 1
      : event.key === 'PageDown' ? from + MINIMAP_PAGE_STEP
      : event.key === 'PageUp' ? from - MINIMAP_PAGE_STEP
      : event.key === 'Home' ? 0
      : event.key === 'End' ? total - 1
      : undefined
    if (target === undefined) return
    event.preventDefault()
    show(clampTurn(target, total))
  }, [preview, hide, show, jump])

  const ticks = useMemo(() => {
    if (!tickSig) return []
    const entries = tickSig.split('\u0000')
    return entries.map((entry, index) => {
      const failed = entry.endsWith('\u0001')
      const id = failed ? entry.slice(0, -1) : entry
      return (
        <span
          key={id}
          className="v3-rail-tick"
          data-testid="v3-outline-tick"
          data-index={index}
          data-failed={failed ? '' : undefined}
          aria-hidden
          style={{ top: `${minimapTopPercent(index, entries.length)}%` }}
          onClick={(event) => {
            event.stopPropagation()
            jump(index)
          }}
        />
      )
    })
  }, [tickSig, jump])

  if (!hasTurns) return null
  if (!visible) return <div ref={rootRef} hidden />

  const previewTurn: OutlineTurn | undefined = preview.open ? turns[clampTurn(preview.index, count)] : undefined
  if (previewTurn) shownRef.current = { index: clampTurn(preview.index, count), count, failed: previewTurn.failed, text: turnPreview(previewTurn) }
  const shown = shownRef.current

  return (
    <div
      ref={rootRef}
      className={`v3-rail ${className ?? ''}`.trim()}
      data-testid="v3-outline-rail"
      data-preview={preview.open ? '' : undefined}
    >
      <div className="v3-rail-dock" style={{ '--n': count } as CSSProperties}>
        <span className="v3-rail-step" data-dir="prev">
          <IconButton
            data-testid="v3-outline-prev"
            size="xs"
            aria-label={t('outline.prev')}
            title={t('outline.prev')}
            excludeFromTabOrder
            isDisabled={edge === 'start' || edge === 'both'}
            onPress={() => stepBy(-1)}
          >
            <ChevronUp size={CONTROL_ICON_SIZE.xs} aria-hidden="true" />
          </IconButton>
        </span>
        <div
          ref={trackRef}
          className="v3-rail-track"
          role="slider"
          tabIndex={0}
          aria-label={t('outline.label')}
          aria-orientation="vertical"
          aria-valuemin={1}
          aria-valuemax={count}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
          onFocus={onFocus}
          onBlur={hide}
          onKeyDown={onKeyDown}
        >
          <div ref={laneRef} className="v3-rail-lane" aria-hidden>
            <span className="v3-rail-band" />
          </div>
          <div ref={ticksRef} className="v3-rail-ticks">
            {ticks}
          </div>
        </div>
        <span className="v3-rail-step" data-dir="next">
          <IconButton
            data-testid="v3-outline-next"
            size="xs"
            aria-label={t('outline.next')}
            title={t('outline.next')}
            excludeFromTabOrder
            isDisabled={edge === 'end' || edge === 'both'}
            onPress={() => stepBy(1)}
          >
            <ChevronDown size={CONTROL_ICON_SIZE.xs} aria-hidden="true" />
          </IconButton>
        </span>
      </div>
      <div ref={cardRef} className="v3-rail-card" data-testid="v3-outline-preview" data-failed={shown?.failed ? '' : undefined} aria-hidden>
        {shown ? (
          <>
            <span className="v3-rail-card-num">{shown.index + 1} / {shown.count}</span>
            <span className="v3-rail-card-user">{shown.text.line || t('outline.tick', { n: shown.index + 1 })}</span>
            {shown.text.answer ? <span className="v3-rail-card-answer">{shown.text.answer}</span> : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

export const OutlineRail = memo(OutlineRailView)
