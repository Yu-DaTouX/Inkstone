import type { SoundEvent } from '../../../shared/ipc'

interface Note {
  f: number
  t: number
  d: number
  type?: OscillatorType
  g?: number
}

const RECIPES: Record<SoundEvent, Note[]> = {
  done: [
    { f: 659.25, t: 0, d: 0.16 },
    { f: 880.0, t: 0.1, d: 0.3, g: 0.9 }
  ],
  question: [
    { f: 1174.66, t: 0, d: 0.1, type: 'triangle', g: 0.85 },
    { f: 880.0, t: 0.095, d: 0.1, type: 'triangle', g: 0.85 },
    { f: 739.99, t: 0.19, d: 0.34, type: 'triangle', g: 0.95 }
  ],
  error: [
    { f: 440.0, t: 0, d: 0.18, type: 'triangle' },
    { f: 349.23, t: 0.13, d: 0.34, type: 'triangle', g: 0.85 }
  ]
}

const THROTTLE: Record<SoundEvent, number> = {
  done: 250,
  question: 400,
  error: 800
}

let ctx: AudioContext | null = null
let installed = false
let idleTimer = 0
const lastAt: Partial<Record<SoundEvent, number>> = {}

function audioContext(): AudioContext | null {
  if (ctx) return ctx
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
  } catch {
    return null
  }
  return ctx
}

function suspendWhenIdle(c: AudioContext, afterMs: number): void {
  window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => {
    if (c.state === 'running') void c.suspend()
  }, afterMs)
}

export function installAudioUnlock(): void {
  if (installed) return
  installed = true
  const events = ['pointerdown', 'keydown', 'touchstart'] as const
  const unlock = (): void => {
    for (const ev of events) window.removeEventListener(ev, unlock, { capture: true })
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume()
      suspendWhenIdle(ctx, 1000)
    }
  }
  for (const ev of events) window.addEventListener(ev, unlock, { capture: true })
}

export function playSound(event: SoundEvent, volume = 0.4): void {
  const c = audioContext()
  if (!c) return
  if (c.state === 'suspended') void c.resume()

  const nowMs = Date.now()
  const last = lastAt[event] ?? 0
  if (nowMs - last < THROTTLE[event]) return
  lastAt[event] = nowMs

  const v = Math.min(1, Math.max(0, volume))
  if (v <= 0) {
    suspendWhenIdle(c, 300)
    return
  }

  const now = c.currentTime
  const master = c.createGain()
  master.gain.value = v * 0.5
  master.connect(c.destination)

  for (const n of RECIPES[event]) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = n.type ?? 'sine'
    osc.frequency.value = n.f

    const start = now + n.t
    const peak = n.g ?? 1
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.d)

    osc.connect(gain)
    gain.connect(master)
    osc.start(start)
    osc.stop(start + n.d + 0.02)
  }

  const end = now + Math.max(...RECIPES[event].map((n) => n.t + n.d)) + 0.1
  const tailMs = Math.ceil((end - now) * 1000) + 200
  window.setTimeout(() => master.disconnect(), tailMs)
  suspendWhenIdle(c, tailMs + 300)
}

export function previewSound(event: SoundEvent, volume = 0.4): void {
  lastAt[event] = 0
  playSound(event, volume)
}
