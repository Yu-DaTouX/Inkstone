import { prefersReducedMotion } from '../lib/reduced-motion'

export const SHIMMER_WINDOW_PX = 44
const SWEEP_MS = 1100
const REST_MS = 1200
const HIDDEN_RECHECK_MS = 500
const EASING = 'cubic-bezier(.4,0,.2,1)'

const members = new Set<HTMLElement>()
const owned = new WeakMap<HTMLElement, Animation[]>()
let timer = 0
let sweepStart: CSSNumberish | null = null

function reducedMotion(): boolean {
  return prefersReducedMotion()
}

function schedule(delay: number): void {
  if (timer || sweepStart !== null) return
  timer = window.setTimeout(tick, delay)
}

function onScreen(el: HTMLElement): boolean {
  if (!el.isConnected) return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
}

function hiWidth(el: HTMLElement, base: HTMLElement): string {
  const width = el.getBoundingClientRect().width
  return base.getBoundingClientRect().width > width + 0.5 ? `${width}px` : 'max-content'
}

export function syncShimmerWidth(el: HTMLElement): void {
  const base = el.querySelector<HTMLElement>('.ui-shimmer__base')
  const hi = el.querySelector<HTMLElement>('.ui-shimmer__hi')
  if (!base || !hi) return
  hi.style.width = hiWidth(el, base)
}

function cancelOwned(el: HTMLElement): void {
  for (const animation of owned.get(el) ?? []) animation.cancel()
  owned.delete(el)
}

interface SweepPlan {
  el: HTMLElement
  win: HTMLElement
  hi: HTMLElement
  width: number
  hiWidth: string
}

function measure(el: HTMLElement): SweepPlan | null {
  const base = el.querySelector<HTMLElement>('.ui-shimmer__base')
  const win = el.querySelector<HTMLElement>('.ui-shimmer__win')
  const hi = el.querySelector<HTMLElement>('.ui-shimmer__hi')
  if (!base || !win || !hi) return null
  const width = Math.ceil(Math.min(el.clientWidth, base.offsetWidth))
  if (!width) return null
  return { el, win, hi, width, hiWidth: hiWidth(el, base) }
}

function apply({ el, win, hi, width, hiWidth: nextWidth }: SweepPlan, startTime: CSSNumberish | null): Animation[] {
  cancelOwned(el)
  hi.style.width = nextWidth
  const timing = { duration: SWEEP_MS, easing: EASING }
  const animations = [
    win.animate([{ transform: `translateX(${-SHIMMER_WINDOW_PX}px)` }, { transform: `translateX(${width}px)` }], timing),
    hi.animate([{ transform: `translateX(${SHIMMER_WINDOW_PX}px)` }, { transform: `translateX(${-width}px)` }], timing)
  ]
  if (startTime !== null) for (const animation of animations) animation.startTime = startTime
  owned.set(el, animations)
  return animations
}

function sweep(el: HTMLElement, startTime: CSSNumberish | null): Animation[] {
  const plan = measure(el)
  if (plan) return apply(plan, startTime)
  cancelOwned(el)
  return []
}

function tick(): void {
  timer = 0
  if (!members.size) return
  if (document.visibilityState !== 'visible' || reducedMotion()) {
    schedule(HIDDEN_RECHECK_MS)
    return
  }
  const start = document.timeline.currentTime
  let swept = 0
  const plans: SweepPlan[] = []
  for (const el of members) {
    if (!onScreen(el)) continue
    const plan = measure(el)
    if (plan) plans.push(plan)
    else cancelOwned(el)
  }
  for (const plan of plans) swept += apply(plan, start).length
  if (!swept) {
    schedule(SWEEP_MS + REST_MS)
    return
  }
  sweepStart = start
  window.setTimeout(() => {
    sweepStart = null
    schedule(REST_MS)
  }, SWEEP_MS)
}

export function joinShimmer(el: HTMLElement): () => void {
  members.add(el)
  if (sweepStart !== null && !reducedMotion() && onScreen(el)) sweep(el, sweepStart)
  else schedule(0)
  return () => {
    members.delete(el)
    cancelOwned(el)
  }
}

export function sweepOnce(el: HTMLElement): void {
  if (reducedMotion() || document.visibilityState !== 'visible') return
  el.animate([{ transform: 'translateX(-100%)' }, { transform: 'translateX(300%)' }], { duration: 650, easing: EASING })
}
