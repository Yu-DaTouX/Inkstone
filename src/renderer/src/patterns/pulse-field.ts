import { prefersReducedMotion, subscribeReducedMotion } from '../lib/reduced-motion'

export interface PulseFieldColors {
  levels: [number, number, number][]
  off: [number, number, number]
  dark: boolean
}

type Pulse = { row: number; x: number; speed: number; life: number; burst?: boolean; split?: boolean }

const PITCH = 5
const ROWS = 5
const DOT = 2
const AMBIENT_FRAME_MS = 30

export class PulseField {
  private ctx: CanvasRenderingContext2D | null
  private w = 0
  private h = 0
  private dpr = 1
  private level = 0
  private count = 2
  private x = 0
  private v = 0
  private pulses: Pulse[] = []
  private spawn = 0
  private frame = 0
  private last = 0
  private active = true
  private calm = false
  private blurred = false
  private written = ''
  private glow = new Float32Array(0)
  private reduced = false
  private colors: PulseFieldColors = { levels: [[128, 128, 128]], off: [128, 128, 128], dark: false }
  private readonly resizeObserver: ResizeObserver
  private unsubscribeMotion: () => void = () => {}

  constructor(private readonly canvas: HTMLCanvasElement, private readonly host: HTMLElement) {
    this.ctx = canvas.getContext('2d')
    this.reduced = prefersReducedMotion()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
    this.unsubscribeMotion = subscribeReducedMotion(this.onMotion)
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('focus', this.onFocus)
    this.blurred = !document.hasFocus()
    this.resize()
  }

  setLevel(level: number, count: number, disabled: boolean): void {
    const changed = level !== this.level && this.last !== 0
    this.count = Math.max(2, count)
    this.active = !disabled
    if (changed && !this.reduced && this.active) {
      const from = (level / (this.count - 1)) * this.w
      for (let row = 0; row < ROWS; row++) this.pulses.push({ row, x: from, speed: -(170 + row * 26), life: 1, burst: true })
    }
    this.level = level
    if (this.last === 0) this.x = this.reduced ? this.target() : 0
    this.kick()
  }

  setColors(colors: PulseFieldColors): void {
    this.colors = colors
    this.kick()
  }

  dispose(): void {
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.resizeObserver.disconnect()
    this.unsubscribeMotion()
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('focus', this.onFocus)
  }

  private target(): number {
    return this.level / (this.count - 1)
  }

  private onMotion = (): void => {
    this.reduced = prefersReducedMotion()
    if (this.reduced) this.pulses = []
    this.kick()
  }

  private onBlur = (): void => {
    this.blurred = true
  }

  private onFocus = (): void => {
    this.blurred = false
    this.kick()
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    } else this.kick()
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.w = rect.width
    this.h = rect.height
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr))
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr))
    this.kick()
  }

  private kick(): void {
    if (this.frame || document.hidden) return
    this.frame = requestAnimationFrame(this.tick)
  }

  private tick = (now: number): void => {
    this.frame = 0
    if (this.calm && this.last && now - this.last < AMBIENT_FRAME_MS) {
      this.kick()
      return
    }
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0
    this.last = now
    const moving = this.step(dt)
    this.calm = this.v === 0 && !this.pulses.some((p) => p.burst)
    this.draw()
    if (moving || (!this.reduced && !this.blurred && this.active && this.level > 0)) this.kick()
  }

  private step(dt: number): boolean {
    const goal = this.target()
    if (this.reduced) {
      this.x = goal
      this.v = 0
    } else {
      this.v += (210 * (goal - this.x) - 21 * this.v) * dt
      this.x += this.v * dt
      if (Math.abs(goal - this.x) < 0.0005 && Math.abs(this.v) < 0.001) {
        this.x = goal
        this.v = 0
      }
    }
    const at = `${this.x * 100}%`
    if (at !== this.written) {
      this.written = at
      this.host.style.setProperty('--step-x', at)
    }

    const k = this.level / (this.count - 1)
    const fill = this.x * this.w
    if (!this.reduced && !this.blurred && this.active && this.level > 0) {
      this.spawn += dt * (3 + k * 15)
      while (this.spawn > 1) {
        this.spawn -= 1
        this.pulses.push({ row: (Math.random() * ROWS) | 0, x: -PITCH * 2, speed: 80 + k * 210 + Math.random() * 60, life: 1 })
      }
    }
    for (const p of this.pulses) {
      p.x += p.speed * dt
      if (p.burst) p.life -= dt * 1.3
      if (!p.burst && !p.split && k > 0.7 && p.x > fill * 0.25 && Math.random() < dt * (k - 0.55) * 4) {
        p.split = true
        const row = Math.max(0, Math.min(ROWS - 1, p.row + (Math.random() < 0.5 ? -1 : 1)))
        this.pulses.push({ row, x: p.x, speed: p.speed * 0.92, life: 1, split: true })
      }
    }
    this.pulses = this.pulses.filter((p) => p.life > 0 && p.x < fill + PITCH * 2 && p.x > -PITCH * 4)
    return this.v !== 0 || this.pulses.length > 0
  }

  private draw(): void {
    const ctx = this.ctx
    if (!ctx || this.w <= 0) return
    const { levels, off, dark } = this.colors
    const cols = Math.floor(this.w / PITCH) + 1
    const fill = this.x * this.w
    const top = this.h / 2 - ((ROWS - 1) * PITCH) / 2
    const k = this.level / (this.count - 1)
    const tail = 7 + Math.round(k * 9)

    if (this.glow.length !== cols * ROWS) this.glow = new Float32Array(cols * ROWS)
    const glow = this.glow
    glow.fill(0)
    for (const p of this.pulses) {
      const head = Math.round(p.x / PITCH)
      const len = p.burst ? 4 : tail
      const dir = p.speed > 0 ? 1 : -1
      for (let j = 0; j <= len; j++) {
        const c = head - dir * j
        if (c < 0 || c >= cols) continue
        const value = (1 - j / (len + 1)) * Math.max(0, p.life)
        const i = p.row * cols + c
        if (value > glow[i]) glow[i] = value
      }
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)
    const steps = levels.length - 1
    for (let c = 0; c < cols; c++) {
      const x = c * PITCH + 1
      const lit = x <= fill + 0.5
      const u = Math.min(1, Math.max(0, x / this.w)) * steps
      const i = Math.min(steps - 1, Math.floor(u))
      const base = lit && steps > 0 ? mix(levels[i], levels[i + 1], u - i) : off
      for (let r = 0; r < ROWS; r++) {
        const g = lit ? glow[r * cols + c] : 0
        const color = g && dark ? mix(base, [255, 255, 255], g * 0.4) : base
        const alpha = lit ? (dark ? 0.5 : 0.55) + (dark ? 0.5 : 0.45) * g : 1
        const size = DOT + g * 1.1
        ctx.fillStyle = `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${alpha})`
        ctx.fillRect(x - size / 2, top + r * PITCH - size / 2, size, size)
      }
    }
  }
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function resolveColor(probe: HTMLElement, css: string): [number, number, number] {
  probe.style.color = ''
  probe.style.color = css
  const m = getComputedStyle(probe).color.match(/[\d.]+/g)
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [128, 128, 128]
}
