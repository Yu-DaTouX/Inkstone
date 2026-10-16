import { useEffect, useRef, type JSX } from 'react'
import { prefersReducedMotion, usePresence } from '../../lib/usePresence'
import {
  ALPHA_LEVELS,
  CELL_SIZE,
  CHARSET,
  ENTER_MS,
  EXIT_MS,
  FIELD_SEED,
  STATIC_TIME,
  alphaLevel,
  animationPolicy,
  bottomClearZone,
  computeFieldFrame,
  defaultClearZones,
  levelAlpha,
  shouldDraw,
  textClearZone,
  type ClearZone,
  type FieldFrame,
  type MousePoint
} from './ascii-field-model'
import './ambient.css'

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'
const DARK_QUERY = '(prefers-color-scheme: dark)'
const glyphAtlases = new Map<string, HTMLCanvasElement>()

function resolveToken(host: HTMLElement, token: string, fallback: string): string {
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:var(${token})`
  host.appendChild(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color || fallback
}

function readMonoStack(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
  return raw || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
}

function glyphFont(cell: number, stack: string): string {
  return `${Math.max(6, Math.round(cell * 0.82))}px ${stack}`
}

function emptyStateOf(host: HTMLElement): HTMLElement | null {
  return host.parentElement?.querySelector('[data-testid="v3-empty"]') as HTMLElement | null
}

function zonesFor(host: HTMLElement, width: number, height: number): ClearZone[] {
  const empty = emptyStateOf(host)
  const base = host.getBoundingClientRect()
  const zones: ClearZone[] = []
  const blocks = empty ? Array.from(empty.querySelectorAll<HTMLElement>('.v3-empty-greet, .v3-empty-hint, .start-usage, .start-strip')) : []
  for (const el of blocks) {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    const range = document.createRange()
    range.selectNodeContents(el)
    const text = el.classList.contains('start-usage') ? rect : range.getBoundingClientRect()
    zones.push(textClearZone({ left: text.left - base.left, top: text.top - base.top, width: text.width, height: text.height }, el.classList.contains('start-usage') ? 20 : 26))
  }
  if (!zones.length) return defaultClearZones(width, height)
  zones.push(bottomClearZone(width, height))
  return zones
}

function anchorFor(host: HTMLElement, width: number, height: number): MousePoint {
  const prompt = emptyStateOf(host)?.querySelector('.v3-empty-greet') as HTMLElement | null
  if (prompt) {
    const rect = prompt.getBoundingClientRect()
    const base = host.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      return { x: rect.left - base.left + rect.width / 2, y: rect.top - base.top + rect.height / 2 }
    }
  }
  return { x: width * 0.5, y: height * 0.44 }
}

interface FieldHandle {
  setClosing(closing: boolean): void
  dispose(): void
}

function startField(host: HTMLElement, canvas: HTMLCanvasElement): FieldHandle {
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return { setClosing: () => undefined, dispose: () => undefined }

  let width = 1
  let height = 1
  let colorFg = '#888888'
  let colorAccent = '#6f8cff'
  let monoStack = readMonoStack()
  let atlas: HTMLCanvasElement | null = null
  let atlasKey = ''
  let dpr = 1
  let cellPx = CELL_SIZE
  let frame: FieldFrame | null = null
  let zones: ClearZone[] = []
  let anchor: MousePoint = { x: 0, y: 0 }
  let mouse: MousePoint | null = null
  let pulses: Array<{ x: number; y: number; at: number }> = []
  let pageVisible = document.visibilityState !== 'hidden'
  let inViewport = true
  let focused = document.hasFocus()
  let reduced = prefersReducedMotion()
  let running = false
  let raf = 0
  let lastDraw = Number.NEGATIVE_INFINITY
  let elapsed = 0
  let closing = false
  let exitElapsed = 0

  const currentVisible = (): boolean => pageVisible && inViewport

  const measure = (): void => {
    zones = zonesFor(host, width, height)
    anchor = anchorFor(host, width, height)
  }

  const resize = (): void => {
    width = Math.max(1, host.clientWidth)
    height = Math.max(1, host.clientHeight)
    dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1))
    cellPx = Math.max(1, Math.round(CELL_SIZE * dpr))
    const bw = Math.round(width * dpr)
    const bh = Math.round(height * dpr)
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    measure()
  }

  const buildAtlas = (): void => {
    const key = `${cellPx}|${colorFg}|${colorAccent}|${monoStack}`
    if (atlas && atlasKey === key) return
    const cached = glyphAtlases.get(key)
    if (cached) { atlas = cached; atlasKey = key; return }
    const next = document.createElement('canvas')
    next.width = CHARSET.length * cellPx
    next.height = cellPx * ALPHA_LEVELS * 2
    const actx = next.getContext('2d')
    if (!actx) return
    actx.clearRect(0, 0, next.width, next.height)
    actx.font = glyphFont(cellPx, monoStack)
    actx.textAlign = 'center'
    actx.textBaseline = 'middle'
    for (let tone = 0; tone < 2; tone++) {
      actx.fillStyle = tone ? colorAccent : colorFg
      for (let level = 0; level < ALPHA_LEVELS; level++) {
        actx.globalAlpha = levelAlpha(level) * (tone ? 1.25 : 1)
        const cy = (tone * ALPHA_LEVELS + level) * cellPx + cellPx / 2
        for (let i = 0; i < CHARSET.length; i++) actx.fillText(CHARSET[i], i * cellPx + cellPx / 2, cy)
      }
    }
    atlas = next
    atlasKey = key
    if (glyphAtlases.size >= 2) glyphAtlases.delete(glyphAtlases.keys().next().value!)
    glyphAtlases.set(key, next)
  }

  const readTokens = (): void => {
    const nextMono = readMonoStack()
    const nextFg = resolveToken(host, '--fg', '#888888')
    const nextAccent = resolveToken(host, '--accent', '#6f8cff')
    if (nextFg !== colorFg || nextAccent !== colorAccent || nextMono !== monoStack) {
      colorFg = nextFg
      colorAccent = nextAccent
      monoStack = nextMono
      atlasKey = ''
    }
  }

  const enterProgress = (): number => (reduced ? 1 : Math.min(1, elapsed / ENTER_MS))
  const exitProgress = (): number => (reduced || !closing ? 0 : Math.min(1, exitElapsed / EXIT_MS))

  const draw = (): void => {
    if (closing) return
    buildAtlas()
    if (!atlas) return
    frame = computeFieldFrame({
      width,
      height,
      cell: CELL_SIZE,
      time: reduced ? STATIC_TIME : elapsed / 1000,
      tick: Math.floor(elapsed / 100),
      seed: FIELD_SEED,
      zones,
      mouse,
      pulses: pulses.map((p) => ({ x: p.x, y: p.y, age: (elapsed - p.at) / 1000 })),
      anchor,
      enter: enterProgress(),
      exit: exitProgress()
    }, frame)
    pulses = pulses.filter((p) => elapsed - p.at < 2400)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const { alpha, glyph, accent, cols } = frame
    const total = alpha.length
    let col = 0
    let row = 0
    for (let i = 0; i < total; i++) {
      const a = alpha[i]
      if (a > 0) {
        const level = alphaLevel(a)
        const sy = (accent[i] * ALPHA_LEVELS + level) * cellPx
        ctx.drawImage(atlas, glyph[i] * cellPx, sy, cellPx, cellPx, Math.round(col * CELL_SIZE * dpr), Math.round(row * CELL_SIZE * dpr), cellPx, cellPx)
      }
      if (++col === cols) {
        col = 0
        row++
      }
    }
  }

  const frameStep = (now: number): void => {
    const policy = animationPolicy({ visible: currentVisible(), focused, reducedMotion: reduced })
    if (!policy.active) {
      running = false
      raf = 0
      return
    }
    raf = requestAnimationFrame(frameStep)
    if (closing) { stop(); return }
    const fps = elapsed < ENTER_MS || closing ? Math.max(policy.fps, 30) : policy.fps
    if (!shouldDraw(now, lastDraw, fps)) return
    const step = lastDraw === Number.NEGATIVE_INFINITY ? 0 : Math.min(100, now - lastDraw)
    lastDraw = now
    elapsed += step
    if (closing) exitElapsed += step
    draw()
  }

  const start = (): void => {
    if (running || reduced) return
    running = true
    lastDraw = Number.NEGATIVE_INFINITY
    raf = requestAnimationFrame(frameStep)
  }

  const stop = (): void => {
    if (!running) return
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  const applyPolicy = (): void => {
    const policy = animationPolicy({ visible: currentVisible(), focused, reducedMotion: reduced })
    if (!policy.active) {
      stop()
      if (reduced) draw()
      return
    }
    start()
  }

  const onVisibility = (): void => {
    pageVisible = document.visibilityState !== 'hidden'
    applyPolicy()
  }
  const onFocus = (): void => {
    focused = true
  }
  const onBlur = (): void => {
    focused = false
  }
  const onPointerMove = (event: PointerEvent): void => {
    const rect = host.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    mouse = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height ? { x, y } : null
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (reduced || closing) return
    const rect = host.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return
    pulses = [...pulses.slice(-3), { x, y, at: elapsed }]
  }
  const onPointerLeave = (): void => {
    mouse = null
  }
  const onReducedChange = (): void => {
    reduced = prefersReducedMotion()
    applyPolicy()
  }
  const onTheme = (): void => {
    readTokens()
    atlasKey = ''
    if (reduced || !running) draw()
  }

  const ro = new ResizeObserver(() => {
    resize()
    if (!running) draw()
  })
  const io = new IntersectionObserver((entries) => {
    inViewport = entries.some((entry) => entry.isIntersecting)
    applyPolicy()
  })
  const themeObserver = new MutationObserver(onTheme)
  const reducedMedia = window.matchMedia(REDUCED_QUERY)
  const darkMedia = window.matchMedia(DARK_QUERY)

  resize()
  readTokens()
  buildAtlas()
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  document.documentElement.addEventListener('pointerleave', onPointerLeave)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  reducedMedia.addEventListener('change', onReducedChange)
  darkMedia.addEventListener('change', onTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  ro.observe(host)
  const empty = emptyStateOf(host)
  if (empty) ro.observe(empty)
  io.observe(host)

  if (reduced) draw()
  else start()

  return {
    setClosing: (next) => {
      if (next === closing) return
      closing = next
      exitElapsed = 0
      if (next) stop()
      else applyPolicy()
    },
    dispose: () => {
      stop()
      ro.disconnect()
      io.disconnect()
      themeObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      document.documentElement.removeEventListener('pointerleave', onPointerLeave)
      reducedMedia.removeEventListener('change', onReducedChange)
      darkMedia.removeEventListener('change', onTheme)
    }
  }
}

export interface AsciiFieldProps {
  active: boolean
  enabled?: boolean
}

export function AsciiField({ active, enabled = true }: AsciiFieldProps): JSX.Element | null {
  const { mounted, closing } = usePresence(active && enabled, EXIT_MS)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const handleRef = useRef<FieldHandle | null>(null)

  useEffect(() => {
    if (!mounted) return undefined
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return undefined
    const handle = startField(host, canvas)
    handleRef.current = handle
    return () => {
      handle.dispose()
      handleRef.current = null
    }
  }, [mounted])

  useEffect(() => {
    handleRef.current?.setClosing(closing)
  }, [closing])

  if (!mounted) return null
  return (
    <div className="v3-ascii-field" data-closing={closing ? '1' : '0'} ref={hostRef} aria-hidden="true" data-testid="v3-ascii-field">
      <canvas ref={canvasRef} />
    </div>
  )
}
