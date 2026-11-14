export type FrictionReason = 'hotkey' | 'layout-shift' | 'long-frame' | 'error' | 'rage-click' | 'scroll-jump'

export interface FrictionMark {
  at: number
  kind: FrictionReason
  detail?: string
}

export interface FrictionContext {
  route?: string
  sessionId?: string
  viewport: { width: number; height: number }
  startedAt: number
  capturedAt: number
  privateVisible?: boolean
  fonts?: string[]
}

export interface FrictionCaptureRequest {
  reason: FrictionReason
  detail?: string
  events: unknown[]
  marks: FrictionMark[]
  context: FrictionContext
}

export interface FrictionCaptureResult {
  ok: boolean
  dir?: string
  error?: string
}

export const FRICTION_CAPTURE_CHANNEL = 'yan:friction:capture'
export const FRICTION_OPEN_CHANNEL = 'yan:friction:openFolder'

export const FRICTION_LIMITS = {
  checkoutMs: 30_000,
  keepSegments: 2,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBytes: 500 * 1024 * 1024,
  maxRequestChars: 150 * 1024 * 1024,
  autoCooldownMs: 60_000,
  autoGapMs: 20_000,
  autoSettleMs: 1_500,
  layoutShift: 0.05,
  longFrameMs: 300,
  scrollJumpPx: 120,
  scrollInputQuietMs: 1_000,
  scrollMinViewportPx: 200,
  scrollBottomSlackPx: 4
} as const

export const FRICTION_PRIVATE_SELECTOR = '.v3-qsecret, [data-friction-private]'

const REASONS: ReadonlySet<string> = new Set(['hotkey', 'layout-shift', 'long-frame', 'error', 'rage-click', 'scroll-jump'])

export interface FrictionKey {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  altGraph?: boolean
}

export function isFrictionHotkey(key: FrictionKey): boolean {
  return key.code === 'KeyF' && key.ctrlKey && key.altKey && !key.shiftKey && !key.metaKey && !key.altGraph
}

export function isFrictionReason(value: unknown): value is FrictionReason {
  return typeof value === 'string' && REASONS.has(value)
}

export class SegmentRing<T> {
  private segments: T[][] = [[]]

  constructor(private readonly keep: number) {}

  push(item: T, startsSegment: boolean): void {
    if (startsSegment && this.current().length > 0) {
      this.segments.push([])
      while (this.segments.length > this.keep) this.segments.shift()
    }
    this.current().push(item)
  }

  items(): T[] {
    return this.segments.flat()
  }

  clear(): void {
    this.segments = [[]]
  }

  private current(): T[] {
    return this.segments[this.segments.length - 1]
  }
}

export interface RageClickOptions {
  count: number
  windowMs: number
  radius: number
}

export function createRageClickDetector(options: RageClickOptions = { count: 3, windowMs: 800, radius: 24 }) {
  let clicks: Array<{ at: number; x: number; y: number }> = []
  return (at: number, x: number, y: number): boolean => {
    clicks = clicks.filter((c) => at - c.at <= options.windowMs && Math.hypot(c.x - x, c.y - y) <= options.radius)
    clicks.push({ at, x, y })
    if (clicks.length < options.count) return false
    clicks = []
    return true
  }
}

export interface ScrollSample {
  at: number
  top: number
  height: number
  viewport: number
}

export interface ScrollJump {
  from: number
  to: number
  wasAtBottom: boolean
}

export function createScrollJumpDetector(limits: { jumpPx: number; quietMs: number; minViewportPx: number; bottomSlackPx: number } = {
  jumpPx: FRICTION_LIMITS.scrollJumpPx,
  quietMs: FRICTION_LIMITS.scrollInputQuietMs,
  minViewportPx: FRICTION_LIMITS.scrollMinViewportPx,
  bottomSlackPx: FRICTION_LIMITS.scrollBottomSlackPx
}) {
  const seen = new WeakMap<object, ScrollSample>()
  let quietUntil = -Infinity
  const atBottom = (s: ScrollSample): boolean => s.height - s.top - s.viewport <= limits.bottomSlackPx
  return {
    hold(at: number): void {
      quietUntil = Math.max(quietUntil, at + limits.quietMs)
    },
    sample(key: object, next: ScrollSample): ScrollJump | null {
      const prev = seen.get(key)
      seen.set(key, next)
      if (!prev || next.viewport < limits.minViewportPx || next.height <= next.viewport) return null
      if (next.at <= quietUntil) return null
      if (Math.abs(next.top - prev.top) < limits.jumpPx) return null
      const wasAtBottom = atBottom(prev)
      if (wasAtBottom && atBottom(next)) return null
      return { from: Math.round(prev.top), to: Math.round(next.top), wasAtBottom }
    }
  }
}

export function createTriggerThrottle(cooldownMs: number = FRICTION_LIMITS.autoCooldownMs, gapMs: number = FRICTION_LIMITS.autoGapMs) {
  const last = new Map<FrictionReason, number>()
  let lastAny = -Infinity
  return (kind: FrictionReason, now: number): boolean => {
    if (kind === 'hotkey') {
      lastAny = now
      return true
    }
    if (now - lastAny < gapMs) return false
    if (now - (last.get(kind) ?? -Infinity) < cooldownMs) return false
    last.set(kind, now)
    lastAny = now
    return true
  }
}

export interface FrictionEntry {
  name: string
  mtimeMs: number
  bytes: number
}

export function selectFrictionPrune(
  entries: readonly FrictionEntry[],
  now: number,
  limits: { maxAgeMs: number; maxBytes: number } = FRICTION_LIMITS
): string[] {
  const newestFirst = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)
  const drop: string[] = []
  let total = 0
  for (const entry of newestFirst) {
    total += entry.bytes
    if (now - entry.mtimeMs > limits.maxAgeMs || total > limits.maxBytes) drop.push(entry.name)
  }
  return drop
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function frictionDirName(at: Date, reason: FrictionReason): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${stamp}-${reason}`
}

export function isBenignFrictionError(message: string): boolean {
  return /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(message.trim())
}

const FONT_URL = /^file:\/\/\/[^"'()\s\\]+\.(woff2?|ttf|otf)$/i

function fontUrls(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const urls = [...new Set(value.filter((url): url is string => typeof url === 'string' && url.length <= 2000 && FONT_URL.test(url)))].slice(0, 300)
  return urls.length ? urls : undefined
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function shortText(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined
}

export function sanitizeFrictionRequest(raw: unknown): FrictionCaptureRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const req = raw as Record<string, unknown>
  if (!isFrictionReason(req.reason) || !Array.isArray(req.events) || req.events.length === 0) return null
  const ctx = (req.context ?? {}) as Record<string, unknown>
  const viewport = (ctx.viewport ?? {}) as Record<string, unknown>
  const marks = Array.isArray(req.marks)
    ? req.marks.flatMap((m): FrictionMark[] => {
        const mark = (m ?? {}) as Record<string, unknown>
        const at = finiteNumber(mark.at)
        return at !== null && isFrictionReason(mark.kind) ? [{ at, kind: mark.kind, detail: shortText(mark.detail) }] : []
      }).slice(-200)
    : []
  return {
    reason: req.reason,
    detail: shortText(req.detail),
    events: req.events,
    marks,
    context: {
      route: shortText(ctx.route, 100),
      sessionId: shortText(ctx.sessionId, 200),
      viewport: { width: finiteNumber(viewport.width) ?? 0, height: finiteNumber(viewport.height) ?? 0 },
      startedAt: finiteNumber(ctx.startedAt) ?? 0,
      capturedAt: finiteNumber(ctx.capturedAt) ?? Date.now(),
      privateVisible: ctx.privateVisible !== false,
      fonts: fontUrls(ctx.fonts)
    }
  }
}
