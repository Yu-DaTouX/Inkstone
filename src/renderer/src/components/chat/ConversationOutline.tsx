import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useInteractionState } from '../../lib/interaction-state'
import { useT } from '../../i18n'
import { streamingMessageId, useStore } from '../../state/store'
import { createOutlineProjector, type OutlineTurn } from '../../../../shared/outline-turns'
import { formatDuration } from '../../../../shared/duration'
import type { UIMessage } from '../../../../shared/ipc'

const noopScroll = (): void => {}

export function ConversationOutline({ messages: projected, streamingId: projectedStreaming }: { messages?: UIMessage[]; streamingId?: string } = {}) {
  const t = useT()
  const storeMessages = useStore((s) => projected ?? s.messages)
  const storeScrollToTurn = useStore((s) => projected ? noopScroll : s.scrollToTurn)
  const storeStreamingId = useStore((s) => projected ? projectedStreaming : streamingMessageId(s, false))
  const messages = projected ?? storeMessages
  const streamingId = projected ? projectedStreaming : storeStreamingId
  const scrollToTurn = projected ? noopScroll : storeScrollToTurn
  const [hover, setHoverNow] = useState<number | null>(null)
  const saved = useInteractionState()
  const [markError, setMarkError] = useState('')
  const [savingMark, setSavingMark] = useState(false)
  const marks = new Set(Object.keys(saved.values).filter((key) => key.startsWith('bookmark:')).map((key) => key.slice(9)))
  const toggleBookmark = async (id: string): Promise<void> => {
    setSavingMark(true)
    setMarkError('')
    try { await saved.save(`bookmark:${id}`, marks.has(id) ? null : '1') }
    catch (e) { setMarkError(String(e)) }
    finally { setSavingMark(false) }
  }
  const hideTimer = useRef(0)
  const setHover = (next: number | null | ((h: number | null) => number | null)): void => {
    window.clearTimeout(hideTimer.current)
    if (typeof next === 'function') {
      hideTimer.current = window.setTimeout(() => setHoverNow(next), 160)
      return
    }
    setHoverNow(next)
  }
  const keepHover = (): void => window.clearTimeout(hideTimer.current)
  useEffect(() => () => window.clearTimeout(hideTimer.current), [])

  const projectOutline = useMemo(() => createOutlineProjector(), [])
  const turns = useMemo(() => projectOutline(messages, streamingId), [messages, streamingId, projectOutline])
  const turnIndex = useMemo(() => new Map(turns.map((turn, index) => [turn.msgId, index])), [turns])
  const turnIndexRef = useRef(turnIndex)
  turnIndexRef.current = turnIndex

  const conversationId = useStore((s) => s.session?.conversationId ?? '')
  const [active, setActive] = useState(0)
  const pinned = useRef<number | null>(null)
  const programmaticAt = useRef(0)

  const activeFromGeometry = (): number => {
    const scope: ParentNode = (root.current?.offsetParent as HTMLElement | null) ?? document
    const box = scope.querySelector('.stream')
    if (!box) return 0
    const boxTop = box.getBoundingClientRect().top

    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 32
    if (atBottom && turns.length > 0) return turns.length - 1
    if (box.scrollTop <= 1 && turns.length > 0) return 0

    let best = -1
    let bestTop = -Infinity
    let topmost = -1
    let topmostTop = Infinity
    for (const el of box.querySelectorAll<HTMLElement>('[data-turn-id]')) {
      const id = el.dataset.turnId
      const idx = id ? turnIndexRef.current.get(id) : undefined
      if (idx === undefined) continue
      const top = el.getBoundingClientRect().top - boxTop
      if (top <= 8 && top > bestTop) {
        bestTop = top
        best = idx
      }
      if (top < topmostTop) {
        topmostTop = top
        topmost = idx
      }
    }
    if (best >= 0) return best
    if (topmost >= 0) return topmost
    return 0
  }

  useEffect(() => {
    let raf = 0
    const onScroll = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.classList.contains('stream')) return
      const scope = root.current?.offsetParent
      if (!scope || scope.querySelector('.stream') !== target) return
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (Date.now() - programmaticAt.current < 300) return
        pinned.current = null
        setActive(activeFromGeometry())
      })
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length, turns.map((x) => x.msgId).join(',')])

  useEffect(() => {
    pinned.current = null
    setActive(activeFromGeometry())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, turns.length])

  const track = useRef<HTMLDivElement>(null)
  const [hoverRatio, setHoverRatio] = useState(0)

  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = root.current
    const host = el?.offsetParent as HTMLElement | null
    if (!el || !host) return

    const cs = getComputedStyle(el)
    const inset = parseFloat(cs.getPropertyValue('--outline-slot-inset')) || 0
    const slotW = parseFloat(cs.getPropertyValue('--outline-slot-w')) || 0
    const gap = parseFloat(cs.getPropertyValue('--outline-slot-gap')) || 0
    const need0 = inset + slotW + gap

    const innerOf = (): HTMLElement | null =>
      host.querySelector<HTMLElement>('.stream-inner, .stream-row')

    const streamOf = (): HTMLElement | null => host.querySelector<HTMLElement>('.stream')

    const measure = (): void => {
      const stream = streamOf()
      if (stream) {
        const hb0 = host.getBoundingClientRect()
        const sb = stream.getBoundingClientRect()
        const top = `${Math.round(sb.top - hb0.top)}px`
        const height = `${Math.round(sb.height)}px`
        if (el.style.top !== top) el.style.top = top
        if (el.style.height !== height) el.style.height = height
        if (el.style.bottom !== 'auto') el.style.bottom = 'auto'
      }

      const inner = innerOf()
      if (!inner) return
      const applied = parseFloat(host.style.getPropertyValue('--outline-avoid')) || 0
      const hb = host.getBoundingClientRect()
      const ib = inner.getBoundingClientRect()
      const padLeft = parseFloat(getComputedStyle(inner).paddingLeft) || 0
      const base = ib.left + padLeft - hb.left - applied
      const need = Math.max(0, need0 - base)
      const next = `${Math.round(need)}px`
      if (host.style.getPropertyValue('--outline-avoid') !== next) {
        host.style.setProperty('--outline-avoid', next)
      }
    }
    measure()
    let raf = 0
    const schedule = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        measure()
      })
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(host)
    const inner0 = innerOf()
    if (inner0) ro.observe(inner0)
    const stream0 = streamOf()
    if (stream0) ro.observe(stream0)
    const composer0 = host.querySelector<HTMLElement>('.composer-wrap')
    if (composer0) ro.observe(composer0)
    window.addEventListener('resize', measure)
    window.addEventListener('yan:stream-width', measure)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('yan:stream-width', measure)
      host.style.removeProperty('--outline-avoid')
      el.style.removeProperty('top')
      el.style.removeProperty('height')
      el.style.removeProperty('bottom')
    }
  }, [turns.length])

  useLayoutEffect(() => {
    if (hover === null) return
    const el = track.current?.querySelectorAll<HTMLElement>('[data-testid="outline-tick"]')[hover]
    const box = track.current
    if (!el || !box) return
    const a = el.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    if (b.height <= 0) return
    setHoverRatio(Math.min(1, Math.max(0, (a.top + a.height / 2 - b.top) / b.height)))
  }, [hover, turns.length])

  if (turns.length < 3) return null

  return (
    <div
      className="outline"
      ref={root}
      data-testid="outline"
      role="navigation"
      aria-label={t('outline.label')}
    >
      <div className="outline-track" ref={track}>
        {turns.map((turn, i) => (
          <button
            key={turn.msgId}
            className={`outline-hit ${i === active ? 'on' : ''} ${i === hover ? 'hover' : ''} ${turn.failed ? 'err' : ''} ${marks.has(turn.msgId) ? 'mark' : ''}`}
            onMouseOver={() => setHover(i)}
            onMouseOut={() => setHover((h) => (h === i ? null : h))}
            onFocus={() => setHover(i)}
            onBlur={() => setHover((h) => (h === i ? null : h))}
            onClick={() => {
              pinned.current = i
              programmaticAt.current = Date.now()
              setActive(i)
              scrollToTurn(i)
            }}
            data-testid="outline-tick"
            aria-label={t('outline.tick', { n: i + 1 })}
          >
            <span className="outline-bar" />
          </button>
        ))}
      </div>

      {hover !== null && turns[hover] ? (
        <OutlinePreview
          turn={turns[hover]}
          n={hover + 1}
          total={turns.length}
          ratio={hoverRatio}
          marked={marks.has(turns[hover].msgId)}
          onToggleMark={() => void toggleBookmark(turns[hover].msgId)}
          markDisabled={!saved.ready || savingMark}
          markError={markError || saved.error}
          onEnter={keepHover}
          onLeave={() => setHover((h) => (h === hover ? null : h))}
        />
      ) : null}
    </div>
  )
}

function OutlinePreview({
  turn,
  n,
  total,
  ratio,
  marked,
  onToggleMark,
  markDisabled,
  markError,
  onEnter,
  onLeave
}: {
  turn: OutlineTurn
  n: number
  total: number
  ratio: number
  marked: boolean
  onToggleMark: () => void
  markDisabled: boolean
  markError?: string
  onEnter: () => void
  onLeave: () => void
}) {
  const t = useT()
  const card = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = card.current
    const host = el?.offsetParent as HTMLElement | null
    const anchor = el?.parentElement?.querySelector<HTMLElement>('.outline-track')
    if (!el || !host || !anchor) return

    const area = host.offsetParent as HTMLElement | null
    if (area) {
      const ab = area.getBoundingClientRect()
      const hb0 = host.getBoundingClientRect()
      const slotW = parseFloat(getComputedStyle(host).getPropertyValue('--outline-slot-w')) || 44
      const left = slotW + 6
      const maxW = ab.right - 8 - (hb0.left + left)
      el.style.left = `${left}px`
      el.style.width = `${Math.round(Math.max(160, Math.min(320, maxW)))}px`
    }

    const a = anchor.getBoundingClientRect()
    const hb = host.getBoundingClientRect()
    const h = el.offsetHeight

    const targetMid = a.top + ratio * a.height
    let top = targetMid - hb.top - h / 2

    const min = 4
    const max = Math.max(min, hb.height - h - 4)
    if (top < min) top = min
    if (top > max) top = max
    el.style.top = `${Math.round(top)}px`
  }, [ratio, n])

  useEffect(() => {
    const el = card.current
    const host = el?.offsetParent as HTMLElement | null
    if (!el || !host) return
    const id = requestAnimationFrame(() => {
      const over = el.getBoundingClientRect().bottom - (host.getBoundingClientRect().bottom - 4)
      if (over > 0) el.style.top = `${Math.max(4, Math.round(el.offsetTop - over))}px`
    })
    return () => cancelAnimationFrame(id)
  }, [ratio, n, turn.assistant])

  return (
    <div className="outline-preview" ref={card} data-testid="outline-preview" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {markError ? <div role="alert" className="set-warn">{markError}</div> : null}
      <div className="op-head">
        <span className="op-n">
          {n}/{total}
        </span>
        <span className="op-title" data-testid="outline-preview-title" title={clean(turn.user, 400)}>
          {makeTitle(turn.user) || t('outline.untitled')}
        </span>
        <button
          type="button"
          className="op-mark"
          aria-pressed={marked}
          title={marked ? t('outline.unmark') : t('outline.mark')}
          aria-label={marked ? t('outline.unmark') : t('outline.mark')}
          data-testid="outline-bookmark"
          onClick={onToggleMark}
          disabled={markDisabled}
        >
          {marked ? '◼' : '◻'}
        </button>
      </div>

      {turn.assistant ? (
        <div className="op-answer" data-testid="outline-preview-answer">
          {summaryParts(turn.assistant).map((part, i) => part.hl ? <b key={i}>{part.text}</b> : <span key={i}>{part.text}</span>)}
        </div>
      ) : (
        <div className="op-empty">{t('outline.noAnswer')}</div>
      )}

      <div className={`op-meta ${turn.failed ? 'err' : ''}`}>
        <span>{[
          turn.timestamp ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(turn.timestamp)) : null,
          turn.failed ? t('act.failed') : null,
          turn.steps ? t('turn.steps', { n: turn.steps }) : null,
          turn.elapsedMs ? formatDuration(turn.elapsedMs) : null
        ].filter(Boolean).join(' · ')}</span>
        <span className="spacer" />
        <span className="op-hint">{t('outline.click')}</span>
      </div>
    </div>
  )
}

function makeTitle(s: string): string {
  let t = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[<>{}[\]|]/g, ' ')
    .replace(/[A-Za-z]:[\\/][^\s]*/g, ' ')
    .replace(/(?:^|\s)[~/][\w./-]{4,}/g, ' ')
    .replace(/\S+\.(png|jpe?g|gif|webp|svg|ts|tsx|js|json|md|css|html|txt|log|py|rs|go)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!t) t = s.replace(/\s+/g, ' ').trim()

  const m = /^[^。！？!?\n]{1,60}/.exec(t)
  if (m) t = m[0].trim()

  t = t.replace(/[，,、；;：:。.]+$/, '').trim()

  return t.length > 22 ? `${t.slice(0, 22)}…` : t
}

function summaryParts(s: string): { text: string; hl: boolean }[] {
  const marked = /(\*\*|__)(.+?)\1/.exec(s)
  if (!marked) return [{ text: clean(s, 600), hl: false }]
  const before = clean(s.slice(0, marked.index), 300)
  const after = clean(s.slice(marked.index + marked[0].length), 300)
  return [
    ...(before ? [{ text: before + ' ', hl: false }] : []),
    { text: clean(marked[2], 200), hl: true },
    ...(after ? [{ text: ' ' + after, hl: false }] : [])
  ]
}

function clean(s: string, max = 220): string {
  const plain = s
    .replace(/```[\s\S]*?```/g, ' […] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/^[*_#>|]+\s*/gm, '')
    .trim()
  return plain.length > max ? `${plain.slice(0, max)}…` : plain
}
