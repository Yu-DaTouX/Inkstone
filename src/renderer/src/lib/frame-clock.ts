import { prefersReducedMotion, subscribeReducedMotion } from './reduced-motion'

const TARGET_FRAME_MS = 1000 / 60
const BLURRED_FRAME_MS = 1000 / 30
const HIGH_REFRESH_VSYNC_MS = 12
const VSYNC_SAMPLE_MAX_MS = 40
const UNKNOWN_SLACK_MS = 4
const VSYNC_DRIFT_MS = 0.02
const SCAN_BUDGET = 0.02
const SCAN_MIN_GAP_MS = 250
const SCAN_LIMIT_MS = 8
const AMBIENT_NAMES = new Set([
  'ui-spin',
  'ui-status-pulse',
  'ui-term-spin',
  'ui-progress-indeterminate',
  'ui-shimmer',
  'v3-sa-wave',
  'v3-split-ask-breathe',
  'v3-boot-breathe',
  'wb-ctxw-shimmer',
  'ws-globe',
  'ws-spin',
  'ws-beam',
  'ws-ghost-sweep'
])

interface Cadence {
  last: number
  next: number
}

interface Driven {
  base: number
  at: number
  rate: number
  end: number
}

const callbacks = new Map<number, FrameRequestCallback>()
const driven = new Map<Animation, Driven>()
const queued = new Set<Animation>()
let starts = new Map<Element, Set<string>>()
let scanDue = false
let scanTimer = 0
let nextScanAt = 0
let cssTakeover = true
let seq = 0
let frame = 0
const contentCadence: Cadence = { last: -Infinity, next: -Infinity }
const decorCadence: Cadence = { last: -Infinity, next: -Infinity }
let lastNative = 0
let vsync = 0
let focused = true
let installed = false

function hasWindow(): boolean {
  return typeof requestAnimationFrame === 'function'
}

export function highRefreshDisplay(): boolean {
  return vsync > 0 && vsync < HIGH_REFRESH_VSYNC_MS
}

function decorPeriod(): number {
  return focused ? TARGET_FRAME_MS : BLURRED_FRAME_MS
}

function due(cadence: Cadence, now: number, period: number): boolean {
  if (now <= cadence.last) return true
  const slack = vsync ? Math.min(vsync, TARGET_FRAME_MS) / 2 : UNKNOWN_SLACK_MS
  if (now < cadence.next - slack) return false
  cadence.next = now - cadence.next > period ? now + period : cadence.next + period
  cadence.last = now
  return true
}

function sampleVsync(now: number): void {
  const delta = now - lastNative
  lastNative = now
  if (delta <= 0 || delta > VSYNC_SAMPLE_MAX_MS) return
  vsync = vsync ? Math.min(delta, vsync + VSYNC_DRIFT_MS) : delta
}

function report(error: unknown): void {
  queueMicrotask(() => {
    throw error
  })
}

function control(animation: Animation, action: () => void): void {
  try {
    action()
  } catch (error) {
    driven.delete(animation)
    report(error)
  }
}

function handBack(animations: Animation[]): void {
  const paused = animations.filter((animation) => animation.playState === 'paused')
  for (const animation of paused) control(animation, () => animation.play())
}

function stopCssTakeover(): void {
  cssTakeover = false
  starts = new Map()
  scanDue = false
  for (const animation of queued) if (animation instanceof CSSAnimation) queued.delete(animation)
  const held = [...driven.keys()].filter((animation) => animation instanceof CSSAnimation)
  for (const animation of held) driven.delete(animation)
  handBack(held)
}

function ambientLoop(animation: Animation, wanted?: Map<Element, Set<string>>): boolean {
  if (!(animation instanceof CSSAnimation) || !AMBIENT_NAMES.has(animation.animationName)) return false
  if (wanted) {
    const target = (animation.effect as KeyframeEffect | null)?.target
    if (!target || !wanted.get(target)?.has(animation.animationName)) return false
  }
  return animation.effect?.getComputedTiming().iterations === Infinity
}

function scan(wanted?: Map<Element, Set<string>>): void {
  const started = performance.now()
  const found = document.getAnimations().filter((animation) => ambientLoop(animation, wanted))
  const finished = performance.now()
  if (finished - started > SCAN_LIMIT_MS) {
    stopCssTakeover()
    return
  }
  for (const animation of found) queued.add(animation)
  nextScanAt = finished + Math.max(SCAN_MIN_GAP_MS, (finished - started) / SCAN_BUDGET)
}

function collectStarts(): void {
  scanDue = false
  const wanted = starts
  starts = new Map()
  if (wanted.size) scan(wanted)
}

function planAdoptions(now: number): [Animation, Driven][] {
  if (scanDue) collectStarts()
  if (!queued.size) return []
  if (prefersReducedMotion()) {
    queued.clear()
    return []
  }
  const ready: [Animation, Driven][] = []
  for (const animation of queued) {
    if (driven.has(animation) || animation.playState !== 'running') continue
    const timing = animation.effect?.getComputedTiming()
    const current = animation.currentTime
    if (!timing || typeof current !== 'number') continue
    ready.push([animation, { base: current, at: now, rate: animation.playbackRate || 1, end: typeof timing.endTime === 'number' ? timing.endTime : Infinity }])
  }
  queued.clear()
  return ready
}

function planAdvance(now: number, moves: [Animation, number][], done: Animation[]): void {
  for (const [animation, state] of driven) {
    const target = (animation.effect as KeyframeEffect | null)?.target
    if (!target?.isConnected || animation.playState === 'idle') {
      driven.delete(animation)
      continue
    }
    const time = state.base + (now - state.at) * state.rate
    if (time >= state.end) {
      driven.delete(animation)
      done.push(animation)
      continue
    }
    moves.push([animation, time])
  }
}

function busy(): boolean {
  return callbacks.size > 0 || driven.size > 0 || queued.size > 0 || scanDue
}

function schedule(): void {
  if (!frame && hasWindow() && busy()) frame = requestAnimationFrame(tick)
}

function runCallbacks(now: number): void {
  const pending = [...callbacks.values()]
  callbacks.clear()
  for (const callback of pending) {
    try {
      callback(now)
    } catch (error) {
      queueMicrotask(() => {
        throw error
      })
    }
  }
}

function tick(now: number): void {
  frame = 0
  sampleVsync(now)
  if (callbacks.size && due(contentCadence, now, TARGET_FRAME_MS)) runCallbacks(now)
  const moves: [Animation, number][] = []
  const done: Animation[] = []
  if (driven.size && due(decorCadence, now, decorPeriod())) planAdvance(now, moves, done)
  const adoptions = planAdoptions(now)
  for (const [animation, time] of moves) if (driven.has(animation)) control(animation, () => { animation.currentTime = time })
  for (const animation of done) control(animation, () => animation.finish())
  for (const [animation, state] of adoptions) {
    driven.set(animation, state)
    control(animation, () => animation.pause())
  }
  schedule()
  if (!frame) lastNative = 0
}

export function requestClockFrame(callback: FrameRequestCallback): number {
  const id = ++seq
  callbacks.set(id, callback)
  schedule()
  return id
}

export function cancelClockFrame(id: number): void {
  callbacks.delete(id)
  if (!frame || busy() || !hasWindow()) return
  cancelAnimationFrame(frame)
  frame = 0
  lastNative = 0
}

export function driveAnimation(animation: Animation): void {
  if (!highRefreshDisplay() || driven.has(animation)) return
  queued.add(animation)
  schedule()
}

function onAnimationStart(event: AnimationEvent): void {
  if (!cssTakeover || !AMBIENT_NAMES.has(event.animationName) || !highRefreshDisplay() || prefersReducedMotion()) return
  const target = event.target
  if (!(target instanceof Element)) return
  const names = starts.get(target)
  if (names) names.add(event.animationName)
  else starts.set(target, new Set([event.animationName]))
  if (scanDue || scanTimer) return
  scanTimer = window.setTimeout(() => {
    scanTimer = 0
    scanDue = true
    schedule()
  }, Math.max(0, nextScanAt - performance.now()))
}

function releaseAll(): void {
  queued.clear()
  starts = new Map()
  scanDue = false
  const held = [...driven.keys()]
  driven.clear()
  handBack(held)
}

function rescan(): void {
  if (!highRefreshDisplay() || prefersReducedMotion() || typeof document.getAnimations !== 'function') return
  scan()
  schedule()
}

function onReducedMotionChange(): void {
  releaseAll()
  cssTakeover = true
  rescan()
}

export function installFrameClock(): void {
  if (installed || !hasWindow() || typeof document === 'undefined') return
  installed = true
  focused = document.hasFocus()
  window.addEventListener('focus', () => { focused = true })
  window.addEventListener('blur', () => { focused = document.hasFocus() })
  document.addEventListener('animationstart', onAnimationStart, true)
  subscribeReducedMotion(onReducedMotionChange)
  let probes = 8
  const probe = (now: number): void => {
    sampleVsync(now)
    if (--probes > 0) {
      window.requestAnimationFrame(probe)
      return
    }
    lastNative = 0
    rescan()
  }
  window.requestAnimationFrame(probe)
}
