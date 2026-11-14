import { record } from '@rrweb/record'
import {
  FRICTION_LIMITS,
  FRICTION_PRIVATE_SELECTOR,
  SegmentRing,
  createRageClickDetector,
  createScrollJumpDetector,
  createTriggerThrottle,
  isBenignFrictionError,
  isFrictionHotkey,
  type FrictionMark,
  type FrictionReason
} from '../../../../shared/friction'
import { pick } from '../../../../shared/ui-lang'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { showToast } from '../../ui'

interface Recording {
  stop: () => void
}

let recording: Recording | null = null

function start(): Recording {
  const ring = new SegmentRing<unknown>(FRICTION_LIMITS.keepSegments)
  let marks: FrictionMark[] = []
  let startedAt = Date.now()
  const allow = createTriggerThrottle()
  const rage = createRageClickDetector()
  const cleanups: Array<() => void> = []
  let saving = false
  let queued: { reason: FrictionReason; detail?: string } | null = null

  const stopRecord = record({
    emit(event, isCheckout) {
      ring.push(event, !!isCheckout)
      if (isCheckout) {
        const first = ring.items()[0] as { timestamp?: number } | undefined
        startedAt = first?.timestamp ?? Date.now()
        marks = marks.filter((m) => m.at >= startedAt)
      }
    },
    checkoutEveryNms: FRICTION_LIMITS.checkoutMs,
    blockSelector: FRICTION_PRIVATE_SELECTOR,
    maskInputOptions: { password: true },
    sampling: { mousemove: 100, scroll: 100, input: 'last', media: 800 },
    recordCanvas: false,
    collectFonts: false,
    errorHandler: () => true
  })

  const save = (reason: FrictionReason, detail?: string): void => {
    if (saving) {
      if (!queued || reason === 'hotkey') queued = { reason, detail }
      return
    }
    saving = true
    const events = ring.items()
    const session = useStore.getState().session
    void window.yan.friction
      .capture({
        reason,
        detail,
        events,
        marks,
        context: {
          route: useUiV3.getState().route.name,
          sessionId: session?.sessionId,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          startedAt,
          capturedAt: Date.now(),
          privateVisible: !!document.querySelector(FRICTION_PRIVATE_SELECTOR),
          fonts: loadedFontUrls()
        }
      })
      .then((result) => {
        if (reason !== 'hotkey') return
        showToast(result.ok ? pick('已记录刚才的界面问题', 'Recorded what just happened') : pick('记录失败', 'Recording failed'), {
          tone: result.ok ? 'success' : 'warning',
          timeout: 2200
        })
      })
      .catch(() => undefined)
      .finally(() => {
        saving = false
        const next = queued
        queued = null
        if (next) save(next.reason, next.detail)
      })
  }

  const trigger = (kind: FrictionReason, detail?: string): void => {
    const now = Date.now()
    try {
      record.addCustomEvent('friction', { kind, detail })
    } catch {
      return
    }
    marks.push({ at: now, kind, detail })
    if (!allow(kind, now)) return
    if (kind === 'hotkey') save(kind, detail)
    else window.setTimeout(() => save(kind, detail), FRICTION_LIMITS.autoSettleMs)
  }

  const onKey = (event: KeyboardEvent): void => {
    const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')
    if (!isFrictionHotkey({ code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey, altGraph })) return
    event.preventDefault()
    event.stopPropagation()
    trigger('hotkey')
  }
  window.addEventListener('keydown', onKey, true)
  cleanups.push(() => window.removeEventListener('keydown', onKey, true))

  const onClick = (event: MouseEvent): void => {
    if (rage(event.timeStamp, event.clientX, event.clientY)) trigger('rage-click', describe(event.target))
  }
  window.addEventListener('click', onClick, true)
  cleanups.push(() => window.removeEventListener('click', onClick, true))

  const onError = (event: ErrorEvent): void => {
    const message = String(event.message || event.error)
    if (!isBenignFrictionError(message)) trigger('error', message)
  }
  const onRejection = (event: PromiseRejectionEvent): void => trigger('error', String(event.reason instanceof Error ? event.reason.message : event.reason))
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  cleanups.push(() => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  })

  const jumps = createScrollJumpDetector()
  const hold = (event: Event): void => jumps.hold(event.timeStamp)
  const holdEvents = ['wheel', 'touchmove', 'pointerdown', 'keydown', 'resize'] as const
  for (const type of holdEvents) window.addEventListener(type, hold, { capture: true, passive: true })
  cleanups.push(() => {
    for (const type of holdEvents) window.removeEventListener(type, hold, { capture: true })
  })
  const holdOnContext = (): void => jumps.hold(performance.now())
  cleanups.push(useStore.subscribe((state, prev) => {
    if (state.session?.sessionId !== prev.session?.sessionId) holdOnContext()
  }))
  cleanups.push(useUiV3.subscribe((state, prev) => {
    if (state.route !== prev.route || state.sidebarOpen !== prev.sidebarOpen) holdOnContext()
  }))
  const onScroll = (event: Event): void => {
    const el = event.target
    if (!(el instanceof Element)) return
    const jump = jumps.sample(el, { at: event.timeStamp, top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight })
    if (jump) trigger('scroll-jump', `${jump.from}->${jump.to}${jump.wasAtBottom ? ' from-bottom' : ''} ${describe(el)}`)
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  cleanups.push(() => document.removeEventListener('scroll', onScroll, { capture: true }))

  observe('layout-shift', (entry) => {
    const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node | null }> }
    if (shift.hadRecentInput || shift.value < FRICTION_LIMITS.layoutShift) return
    const node = shift.sources?.find((s) => s.node)?.node
    trigger('layout-shift', `${shift.value.toFixed(3)} ${describe(node ?? null)}`)
  }, cleanups)
  observe('long-animation-frame', (entry) => {
    if (entry.duration >= FRICTION_LIMITS.longFrameMs) trigger('long-frame', `${Math.round(entry.duration)}ms`)
  }, cleanups)

  return {
    stop() {
      stopRecord?.()
      for (const fn of cleanups) fn()
      ring.clear()
    }
  }
}

function observe(type: string, onEntry: (entry: PerformanceEntry) => void, cleanups: Array<() => void>): void {
  if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) onEntry(entry)
  })
  observer.observe({ type, buffered: false })
  cleanups.push(() => observer.disconnect())
}

function loadedFontUrls(): string[] {
  const key = (family: string, weight: string, style: string, range: string): string => [family.replace(/["']/g, ''), weight, style, range].join('|')
  const loaded = new Set<string>()
  document.fonts.forEach((font) => {
    if (font.status === 'loaded') loaded.add(key(font.family, font.weight, font.style, font.unicodeRange))
  })
  const urls: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue
      const s = rule.style
      const k = key(s.getPropertyValue('font-family'), s.getPropertyValue('font-weight') || 'normal', s.getPropertyValue('font-style') || 'normal', s.getPropertyValue('unicode-range') || 'U+0-10FFFF')
      if (!loaded.has(k)) continue
      const src = /url\(\s*["']?([^"')]+)/.exec(s.getPropertyValue('src'))?.[1]
      if (src) urls.push(new URL(src, sheet.href || location.href).href)
    }
  }
  return urls
}

function describe(target: EventTarget | Node | null): string {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  if (!el) return ''
  const testId = el.closest('[data-testid]')?.getAttribute('data-testid')
  const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''
  return [testId, `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`].filter(Boolean).join(' ')
}

export function syncFrictionRecorder(enabled: boolean): void {
  if (enabled && !recording) recording = start()
  else if (!enabled && recording) {
    recording.stop()
    recording = null
  }
}
