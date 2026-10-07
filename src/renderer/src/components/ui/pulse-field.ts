/**
 * 思考强度滑块的点阵画布：方点阵沿整条轨道取档位连续色，已点亮的部分有亮脉冲沿点行跑过。
 * 档位越高脉冲越密、越快、拖尾越长，最高两档会分叉到相邻行；切档时从手柄处向左回灌一束脉冲。
 * 填充前沿用弹簧追到目标档，并把当前位置写回 `--step-x`，让 DOM 手柄与点阵同步。
 *
 * 只在控件挂载（菜单打开）时运行；页面隐藏时停帧，减少动态时只画静态点阵。
 */
export interface PulseFieldColors {
  /** 每个档位的颜色，已解析为 [r, g, b] */
  levels: [number, number, number][]
  /** 未点亮的暗点 */
  off: [number, number, number]
  /** 深色主题下脉冲向前景色提亮；浅色主题只提高不透明度 */
  dark: boolean
}

type Pulse = { row: number; x: number; speed: number; life: number; burst?: boolean; split?: boolean }

const PITCH = 5
const ROWS = 5
const DOT = 2

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
  private written = ''
  private reduced = false
  private colors: PulseFieldColors = { levels: [[128, 128, 128]], off: [128, 128, 128], dark: false }
  private readonly resizeObserver: ResizeObserver
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)')

  constructor(private readonly canvas: HTMLCanvasElement, private readonly host: HTMLElement) {
    this.ctx = canvas.getContext('2d')
    this.reduced = this.motion.matches
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
    this.motion.addEventListener('change', this.onMotion)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.resize()
  }

  /** `disabled` 时点阵静止（不产生脉冲），但仍显示当前档位 */
  setLevel(level: number, count: number, disabled: boolean): void {
    const changed = level !== this.level && this.last !== 0
    this.count = Math.max(2, count)
    this.active = !disabled
    if (changed && !this.reduced && this.active) {
      /* 切档：从新档位处向左回灌一束脉冲，像念头被重新点燃 */
      const from = (level / (this.count - 1)) * this.w
      for (let row = 0; row < ROWS; row++) this.pulses.push({ row, x: from, speed: -(170 + row * 26), life: 1, burst: true })
    }
    this.level = level
    /* 菜单打开：前沿从最左「充能」到当前档；减少动态时直接就位 */
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
    this.motion.removeEventListener('change', this.onMotion)
    document.removeEventListener('visibilitychange', this.onVisibility)
  }

  private target(): number {
    return this.level / (this.count - 1)
  }

  private onMotion = (e: MediaQueryListEvent): void => {
    this.reduced = e.matches
    if (this.reduced) this.pulses = []
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
    this.dpr = window.devicePixelRatio || 1
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
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0
    this.last = now
    const moving = this.step(dt)
    this.draw()
    /* 静止且没有脉冲可跑时不再排帧，下一次变化再唤醒 */
    if (moving || (!this.reduced && this.active && this.level > 0)) this.kick()
  }

  /** 推进弹簧与脉冲；返回填充是否仍在移动 */
  private step(dt: number): boolean {
    const goal = this.target()
    if (this.reduced) {
      this.x = goal
      this.v = 0
    } else {
      /* 轻微欠阻尼：前沿略冲过目标再回落 */
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
    if (!this.reduced && this.active && this.level > 0) {
      /* 脉冲密度随档位上升；「关」没有脉冲 */
      this.spawn += dt * (3 + k * 15)
      while (this.spawn > 1) {
        this.spawn -= 1
        this.pulses.push({ row: (Math.random() * ROWS) | 0, x: -PITCH * 2, speed: 80 + k * 210 + Math.random() * 60, life: 1 })
      }
    }
    for (const p of this.pulses) {
      p.x += p.speed * dt
      if (p.burst) p.life -= dt * 1.3
      /* 最高两档：脉冲途经时偶尔分叉到相邻行 */
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

    /* 每个点的亮度：所有脉冲头部最亮、拖尾线性衰减，取最大值 */
    const glow = new Float32Array(cols * ROWS)
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

/** 把任意 CSS 颜色（含 `var(...)`）解析成 [r, g, b]：借一个隐藏元素让浏览器算 */
export function resolveColor(probe: HTMLElement, css: string): [number, number, number] {
  probe.style.color = ''
  probe.style.color = css
  const m = getComputedStyle(probe).color.match(/[\d.]+/g)
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [128, 128, 128]
}
