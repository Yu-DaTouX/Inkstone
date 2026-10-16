import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { Caret, RunDot } from '../ui'

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

const SEGMENTER =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null
const SENTENCE_SEGMENTER =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'sentence' })
    : null

function toUnits(s: string): string[] {
  if (!s) return []
  if (SEGMENTER) return [...SEGMENTER.segment(s)].map((x) => x.segment)
  return Array.from(s)
}

function ReasoningCapsuleImpl({
  text,
  ms,
  live,
  turnLive,
  defaultOpen = false
}: {
  text: string
  ms?: number
  live?: boolean
  turnLive?: boolean
  defaultOpen?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(defaultOpen && !!(turnLive ?? live))
  const touchedRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const streaming = turnLive ?? live
  const [reduced, setReduced] = useState(prefersReducedMotion)
  const shown = useTypewriter(text, !!streaming && !reduced)
  const previewSentence = useMemo(() => latestSentence(shown), [shown])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(media.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && open && followRef.current) el.scrollTop = el.scrollHeight
  }, [shown, open])

  const wasRunning = useRef(!!streaming)
  useEffect(() => {
    if (wasRunning.current && !streaming && defaultOpen && !touchedRef.current) setOpen(false)
    wasRunning.current = !!streaming
  }, [streaming, defaultOpen])

  if (!text.trim()) return null

  const secs = ms ? Math.max(1, Math.round(ms / 1000)) : null

  const label = live ? t('reason.now') : secs ? t('reason.done', { n: secs }) : t('reason.past')

  const { head, tail } = splitTail(shown, !!live && shown.length <= 4000)

  const toggleOpen = (): void => {
    touchedRef.current = true
    const next = !open
    setOpen(next)
    followRef.current = true
    if (next) {
      requestAnimationFrame(() => {
        rootRef.current?.scrollIntoView({ block: 'nearest' })
      })
    }
  }

  return (
    <div
      ref={rootRef}
      className={`reason ${open ? 'open' : ''} ${live ? 'live' : ''}`}
      data-layout="reasoning"
      data-testid="reasoning"
    >
      <button className="reason-head" onClick={toggleOpen} aria-expanded={open} data-testid="reasoning-toggle">
        {live ? (
          <span className="reason-spin" aria-hidden>
            <RunDot />
          </span>
        ) : (
          <Icon name="chevron-right" size={12} className="chev" />
        )}
        <span className="reason-label">{label}</span>
        {!open ? (
          <span className="reason-peek" data-testid="reasoning-preview" dir="rtl">
            <span dir="ltr">{peekText(previewSentence)}</span>
          </span>
        ) : null}
        {live ? <Caret className="cursor cursor-inline" /> : null}
      </button>

      <div
        ref={bodyRef}
        className={`reason-body ${open ? 'open' : ''}`}
        aria-hidden={!open}
        inert={!open}
        onScroll={(event) => {
          const el = event.currentTarget
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
        }}
      >
        {open ? (
          <div className="reason-window-content" data-testid="reasoning-body">
            {head}
            {tail ? (
              <span className="reason-tail" key={shown.length}>
                {tail}
              </span>
            ) : null}
            {live ? <Caret className="cursor cursor-inline" /> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function splitTail(s: string, enabled: boolean): { head: string; tail: string } {
  if (!enabled || s.length < 8) return { head: s, tail: '' }
  const units = toUnits(s)
  if (units.length < 4) return { head: s, tail: '' }
  const tail = units.slice(-3).join('')
  const head = units.slice(0, -3).join('')
  return { head, tail }
}

export const ReasoningCapsule = memo(
  ReasoningCapsuleImpl,
  (a, b) => a.text === b.text && a.ms === b.ms && a.live === b.live && a.turnLive === b.turnLive && a.defaultOpen === b.defaultOpen
)

export function latestSentence(s: string): string {
  const lines = s.split('\n').map((line) => line.trim()).filter(Boolean)
  const line = lines.at(-1) ?? ''
  if (!line) return ''
  const sentences = SENTENCE_SEGMENTER
    ? [...SENTENCE_SEGMENTER.segment(line)].map((part) => part.segment.trim()).filter(Boolean)
    : fallbackSentences(line)
  const candidate = sentences.at(-1) ?? line
  return candidate.replace(/^[#>*\-\s]+/u, '')
}

const PEEK_UNITS = 60
export function peekText(s: string): string {
  const units = toUnits(s)
  if (units.length <= PEEK_UNITS) return s
  return '…' + units.slice(-PEEK_UNITS).join('')
}

function fallbackSentences(text: string): string[] {
  const units = toUnits(text)
  const result: string[] = []
  let start = 0
  for (let i = 0; i < units.length; i++) {
    const stop = /[。！？!?]/u.test(units[i]) || (units[i] === '.' && (i === units.length - 1 || /\s/u.test(units[i + 1])))
    if (!stop) continue
    let end = i + 1
    while (end < units.length && /[。！？!?]/u.test(units[end])) end++
    while (end < units.length && /["'”’）)】\]}]/u.test(units[end])) end++
    result.push(units.slice(start, end).join(''))
    start = end
    i = end - 1
  }
  if (start < units.length) result.push(units.slice(start).join(''))
  return result
}

export function useTypewriter(text: string, enabled: boolean): string {
  const [shown, setShown] = useState(text)
  const mountedRef = useRef(false)
  const target = useRef(text)
  const shownCount = useRef(0)
  const cache = useRef<{ text: string; units: string[] }>({ text: '', units: [] })
  const raf = useRef<number | null>(null)
  const lastTs = useRef(0)
  const carry = useRef(0)
  const idle = useRef(0)

  const unitsFor = useCallback((next: string): string[] => {
    const c = cache.current
    if (next === c.text) return c.units
    if (next.startsWith(c.text) && c.text.length > 0) {
      const added = toUnits(next.slice(c.text.length))
      cache.current = { text: next, units: [...c.units, ...added] }
    } else {
      cache.current = { text: next, units: toUnits(next) }
    }
    return cache.current.units
  }, [])

  const render = useCallback(
    (count: number): void => {
      const units = cache.current.units
      shownCount.current = count
      setShown(units.slice(0, count).join(''))
    },
    []
  )

  useEffect(() => {
    target.current = text
    if (!enabled) {
      cache.current = { text: '', units: [] }
      shownCount.current = 0
      setShown(text)
      return
    }
    const previousText = cache.current.text
    const replaced = !!previousText && !text.startsWith(previousText)
    const units = unitsFor(text)
    if (!mountedRef.current) {
      mountedRef.current = true
      render(units.length)
    }
    if (units.length < shownCount.current) {
      cache.current = { text, units: toUnits(text) }
      render(cache.current.units.length)
      return
    }
    if (replaced) {
      shownCount.current = 0
      setShown('')
      carry.current = 0
    }
    idle.current = 0
    if (raf.current === null) start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, enabled])

  const tick = useCallback(
    (ts: number): void => {
      const units = cache.current.units
      const total = units.length
      let count = shownCount.current

      if (total > count) {
        const backlog = total - count
        if (backlog > 900) {
          count = total
        } else {
          const dt = lastTs.current ? Math.min(0.1, (ts - lastTs.current) / 1000) : 1 / 60
          lastTs.current = ts
          const cps = 90 + Math.min(900, backlog * 12)
          const perSecond = cps
          const add = perSecond * dt + carry.current
          const n = Math.floor(add)
          carry.current = add - n
          if (n > 0) count = Math.min(total, count + n)
        }
        if (count !== shownCount.current) {
          shownCount.current = count
          setShown(units.slice(0, count).join(''))
        }
        idle.current = 0
      } else {
        lastTs.current = 0
        idle.current += 1
        if (idle.current > 30) {
          raf.current = null
          return
        }
      }

      raf.current = requestAnimationFrame(tick)
    },
    []
  )

  const start = useCallback((): void => {
    if (raf.current !== null) return
    lastTs.current = 0
    carry.current = 0
    idle.current = 0
    raf.current = requestAnimationFrame(tick)
  }, [tick])

  useEffect(() => {
    if (!enabled) return
    start()
    return () => {
      if (raf.current !== null) {
        cancelAnimationFrame(raf.current)
        raf.current = null
      }
    }
  }, [enabled, start])

  useEffect(() => {
    if (!enabled) return
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      const total = cache.current.units.length
      if (total > shownCount.current) render(total)
      start()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabled, render, start])

  return shown
}
