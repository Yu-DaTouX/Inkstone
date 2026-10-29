import { clamp } from '../../../shared/clamp'

const LIMIT_MS = 8000
const KEY = 'yan.boot.ms'
const MIN_MS = 360
const MAX_MS = 1600
const MAX_WAIT_MS = 500
let done = false
let drawMs = 0

const splashMs = (n: number): number => clamp(Math.round(n), MIN_MS, MAX_MS)

function readLast(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    return Number.isFinite(n) && n > 0 ? splashMs(n) : 0
  } catch {
    return 0
  }
}

function applyDrawTime(): void {
  const el = document.getElementById('boot')
  const ms = readLast()
  if (!el || !ms) return
  drawMs = ms
  el.style.setProperty('--boot-ms', ms + 'ms')
}

export function dismissBootSplash(): void {
  if (done) return
  done = true
  performance.mark('yan:splash-dismiss')
  const el = document.getElementById('boot')
  if (!el) return
  const ready = performance.now()
  try {
    localStorage.setItem(KEY, String(splashMs(ready)))
  } catch { }
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const wait = reduced || !drawMs ? 0 : Math.min(MAX_WAIT_MS, Math.max(0, drawMs - ready))
  const fade = (): void => {
    el.classList.add('out')
    const remove = (): void => el.remove()
    el.addEventListener('animationend', (e) => { if (e.target === el) remove() })
    window.setTimeout(remove, 400)
  }
  if (wait > 0) window.setTimeout(fade, wait)
  else fade()
}

applyDrawTime()
window.setTimeout(dismissBootSplash, LIMIT_MS)
