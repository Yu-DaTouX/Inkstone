import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../../lib/reduced-motion'

export const REVEAL_DRAIN_MS = 160
export const MAX_DRAIN_MS = 700
const DRAIN_SPEED = 1.2
const SLOW_TAU_MS = 4000
const SURGE_RATIO = 2
const MAX_LAG_MS = 2000
const CAPPED_LAG_MS = 4000
const TYPE_TOKENS_PER_MS = 0.12
const CJK_CHARS_PER_TOKEN = 1.2
const LATIN_CHARS_PER_TOKEN = 4
const RATE_SAMPLE_CHARS = 400
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g
const BURST_WAIT_MS = 10_000
const BURST_TOKENS_PER_MS = 0.25
const BURST_RATE_MIN_MS = 300
const BURST_GAP_MS = 500
const BURST_CHUNK_TOKENS = 240
const MIN_WEIGHT = 0.25
export const LIVE_TAIL_GRACE_MS = 200
const RATE_TAU_MS = 1000
const CHUNK_WEIGHT = 0.3
const BUFFER_CHUNKS = 0.9
const BUFFER_MS = 60
const BUFFER_MIN_CHARS = 2
const BUFFER_MAX_CHARS = 200
const CATCH_MS = 500
const EASE_OFF = 0.35
const FLOOR_RATE = 0.04
const FRAME_CAP_MS = 50
export const FRESH_TYPE_CHARS = 240
const PROGRESS_LIMIT = 400
const HEAD_CHARS = 24

const progress = new Map<string, { shown: number; head: string }>()

function remember(id: string | null | undefined, text: string, shown: number): void {
  if (!id) return
  progress.delete(id)
  progress.set(id, { shown, head: text.slice(0, HEAD_CHARS) })
  if (progress.size > PROGRESS_LIMIT) progress.delete(progress.keys().next().value as string)
}

function savedShown(id: string | null | undefined, text: string): number | undefined {
  const saved = id ? progress.get(id) : undefined
  if (!saved) return undefined
  const length = Math.min(saved.head.length, text.length)
  return saved.head.slice(0, length) === text.slice(0, length) ? saved.shown : undefined
}

export function initialShown(length: number, fresh: boolean, saved: number | undefined, reduced: boolean): number {
  if (reduced) return length
  if (saved !== undefined) return Math.min(saved, length)
  return fresh && length <= FRESH_TYPE_CHARS ? 0 : length
}

export interface RevealState {
  shown: number
  seen: number
  rate: number
  slow: number
  weight: number
  chunk: number
  drain: number
  at: number
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

export function startReveal(length: number, now: number): RevealState {
  return { shown: length, seen: length, rate: 0, slow: 0, weight: 0, chunk: 0, drain: 0, at: now }
}

export function drainMs(backlog: number): number {
  return Math.min(MAX_DRAIN_MS, Math.max(REVEAL_DRAIN_MS, backlog / DRAIN_SPEED))
}

export function tokenUnits(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return cjk / CJK_CHARS_PER_TOKEN + (text.length - cjk) / LATIN_CHARS_PER_TOKEN
}

export function typeRate(pending: string): number {
  const sample = pending.slice(0, RATE_SAMPLE_CHARS)
  const units = tokenUnits(sample)
  return units > 0 ? (TYPE_TOKENS_PER_MS * sample.length) / units : TYPE_TOKENS_PER_MS * LATIN_CHARS_PER_TOKEN
}

export interface BurstWatch {
  length: number
  firstAt: number | null
  lastAt: number | null
  units: number
  burst: boolean
}

export function startBurstWatch(length: number, now?: number): BurstWatch {
  return { length, firstAt: null, lastAt: length > 0 && now !== undefined ? now : null, units: 0, burst: false }
}

export function watchBurst(watch: BurstWatch, text: string, now: number, startedAt?: number): BurstWatch {
  if (text.length < watch.length) return { ...watch, length: text.length }
  if (text.length === watch.length) return watch
  const delta = tokenUnits(text.slice(watch.length))
  const known = typeof startedAt === 'number' && Number.isFinite(startedAt)
  const since = watch.lastAt ?? (known ? startedAt : null)
  const gap = since === null ? 0 : now - since
  const firstAt = watch.firstAt ?? now
  const units = watch.units + delta
  const waited = known && firstAt - startedAt >= BURST_WAIT_MS
  const span = now - firstAt
  const rushing = waited && span >= BURST_RATE_MIN_MS && units / span > BURST_TOKENS_PER_MS
  const chunk = delta >= BURST_CHUNK_TOKENS && gap >= BURST_GAP_MS
  return { length: text.length, firstAt, lastAt: now, units, burst: watch.burst || rushing || chunk }
}

export function stepReveal(state: RevealState, length: number, now: number, live: boolean, cap = Infinity): RevealState {
  const elapsed = Math.max(0, now - state.at)
  const dt = Math.min(FRAME_CAP_MS, elapsed)
  const arrived = Math.max(0, length - state.seen)
  const rate = state.rate * Math.exp(-elapsed / RATE_TAU_MS) + arrived / RATE_TAU_MS
  const decay = Math.exp(-elapsed / SLOW_TAU_MS)
  const slow = state.slow * decay + arrived / SLOW_TAU_MS
  const weight = state.weight * decay + 1 - decay
  const chunk = arrived > 0 ? (state.chunk > 0 ? state.chunk + (arrived - state.chunk) * CHUNK_WEIGHT : arrived) : state.chunk
  const seen = length
  const shown = Math.min(state.shown, length)
  const backlog = length - shown
  if (backlog <= 0) return { shown: length, seen, rate, slow, weight, chunk, drain: 0, at: now }
  const lagMs = Number.isFinite(cap) ? CAPPED_LAG_MS : MAX_LAG_MS
  const drain = live ? 0 : state.drain || Math.max(Math.min(backlog / drainMs(backlog), cap), backlog / lagMs)
  const buffer = Math.min(BUFFER_MAX_CHARS, Math.max(BUFFER_MIN_CHARS, chunk * BUFFER_CHUNKS, rate * BUFFER_MS))
  const paced = backlog < buffer ? rate * (EASE_OFF + (1 - EASE_OFF) * (backlog / buffer)) : rate + (backlog - buffer) / CATCH_MS
  const limit = Math.max(Math.min((slow / Math.max(weight, MIN_WEIGHT)) * SURGE_RATIO, cap), backlog / lagMs)
  const speed = Math.max(Math.min(paced, limit), FLOOR_RATE, drain)
  return { shown: Math.min(length, shown + speed * dt), seen, rate, slow, weight, chunk, drain, at: now }
}

export function revealActive(live: boolean, liveUntil: number, now: number, clamped: number, length: number, reduced: boolean): boolean {
  return !reduced && (live || (liveUntil > now && clamped < length))
}

export function revealDraining(draining: boolean, clamped: number, length: number, reduced: boolean): boolean {
  return !reduced && draining && clamped < length
}

export function revealLength(text: string, shown: number): number {
  let length = Math.min(text.length, Math.max(0, Math.floor(shown)))
  if (length <= 0 || length >= text.length) return length
  if (isHighSurrogate(text.charCodeAt(length - 1))) return length + 1
  return length
}

export function useSmoothReveal(text: string, live: boolean, id?: string | null, fresh = live, startedAt?: number): string {
  const reduced = prefersReducedMotion()
  const [start] = useState(() => initialShown(text.length, fresh, savedShown(id, text), reduced))
  const [shown, setShown] = useState(start)
  const shownRef = useRef(shown)
  const stateRef = useRef<RevealState | null>(null)
  const textRef = useRef(text)
  const liveRef = useRef(live)
  const liveUntil = useRef(0)
  const wasLiveProp = useRef(live)
  const drainRef = useRef(start < text.length)
  const baseRef = useRef(start)
  const [initialWatch] = useState(() => startBurstWatch(text.length, Date.now()))
  const burstRef = useRef<BurstWatch>(initialWatch)
  textRef.current = text
  liveRef.current = live
  if (live) burstRef.current = watchBurst(burstRef.current, text, Date.now(), startedAt)
  else if (burstRef.current.length > text.length) burstRef.current = { ...burstRef.current, length: text.length }

  const now = performance.now()
  if (live || wasLiveProp.current) liveUntil.current = now + LIVE_TAIL_GRACE_MS
  wasLiveProp.current = live
  const clamped = Math.min(Math.max(shown, baseRef.current), text.length)
  const withinGrace = revealActive(live, liveUntil.current, now, clamped, text.length, reduced)
  if (reduced || live) drainRef.current = false
  else if (withinGrace && clamped < text.length) drainRef.current = true
  const draining = revealDraining(drainRef.current, clamped, text.length, reduced)
  if (!draining && clamped >= text.length) drainRef.current = false
  const animate = withinGrace || draining
  if (!animate) {
    if (reduced || now >= liveUntil.current) liveUntil.current = 0
    baseRef.current = text.length
  }

  useEffect(() => {
    if (!animate) {
      stateRef.current = null
      return undefined
    }
    let raf = 0
    const tick = (now: number): void => {
      const current = textRef.current
      const state = stateRef.current ?? startReveal(Math.min(shownRef.current, current.length), now)
      const cap = burstRef.current.burst ? typeRate(current.slice(Math.floor(state.shown))) : Infinity
      const step = stepReveal(state, current.length, now, liveRef.current, cap)
      stateRef.current = step
      const next = revealLength(current, step.shown)
      if (next !== shownRef.current) {
        shownRef.current = next
        remember(id, current, next)
        setShown(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [animate, id])

  if (!animate) {
    shownRef.current = text.length
    if (id && progress.get(id)?.shown !== text.length) remember(id, text, text.length)
    return text
  }
  shownRef.current = clamped
  return clamped >= text.length ? text : text.slice(0, clamped)
}
