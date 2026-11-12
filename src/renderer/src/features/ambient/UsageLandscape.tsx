import { useEffect, useMemo, useRef, type JSX } from 'react'
import { prefersReducedMotion, subscribeReducedMotion } from '../../lib/reduced-motion'
import { usePresence } from '../../ui'
import { compactNumber } from '../usage/usage-format'
import { useUsageStats } from '../usage/UsageOverview'
import { CHARSET, CORE, DUST, FRAME_SLACK_MS, animationPolicy, easeOutCubic, fbm, frameInterval, hash3i, smoothstep } from './ascii-field-model'
import {
  LANDSCAPE_CELL,
  LANDSCAPE_DAYS,
  LANDSCAPE_LAYERS,
  LANDSCAPE_PAD,
  LANDSCAPE_SEED,
  LANDSCAPE_TAIL,
  buildRidge,
  farCenter,
  mainDay,
  reflectionAlpha,
  dayAt,
  dayLabel,
  glyphInk,
  hoverDay,
  landscapeData,
  landscapeLayout,
  layerBase,
  layerRise,
  peakX,
  ridgeAt,
  ridgePresence,
  type LandscapeData,
  type LandscapeLayerSpec,
  type LandscapeLayout
} from './usage-landscape-model'
import { landscapeSky, traceMoon } from './landscape-sky'
import './ambient.css'

const LEVELS = 20
const ALPHA_TOP = 0.92
const IDLE_FPS = 24
const LIVE_FPS = 60
const RISE_S = 0.9
const SWEEP_S = 1.25
const SETTLE_S = 1.9
const PULSE_S = 1.5
const PULSE_SPEED = 520
const DUST_BELOW = 0.07
const WATER_SQUASH = 1.7
const PARALLAX_PX = 18
const STRIP = 3
const TEX_COLS = 512
const TEX_ROWS = 256
const MEASURE_MS = 400
const LAST = LANDSCAPE_DAYS - 1
const FOG_W = 160
const FOG_H = 40
const FOG_SPAN = 960
const SKY_FALLBACK = 96
const FLOOR_INSET = 190
const INTERACTIVE = 'button, a, input, textarea, label, [role="dialog"], [role="menu"], [role="listbox"], [contenteditable="true"]'

type Rgba = [number, number, number, number]

interface Palette {
  ink: Rgba
  accent: Rgba
  fg: Rgba
  fg3: Rgba
  bg: Rgba
  dark: boolean
}

interface LayerArt {
  ink: HTMLCanvasElement
  mask: HTMLCanvasElement
  ridge: Float32Array
  presence: Float32Array
  top: number
  base: number
  rise: number
}

interface Pulse {
  x: number
  y: number
  at: number
}

interface LandscapeHandle {
  setData(data: LandscapeData | null): void
  setClosing(closing: boolean): void
  dispose(): void
}

let probe: CanvasRenderingContext2D | null = null

function resolveColor(host: HTMLElement, token: string): Rgba {
  const el = document.createElement('span')
  el.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:var(${token})`
  host.appendChild(el)
  const color = getComputedStyle(el).color
  el.remove()
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!probe) return [0, 0, 0, 1]
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  const data = probe.getImageData(0, 0, 1, 1).data
  return [data[0], data[1], data[2], data[3] / 255]
}

function readPalette(host: HTMLElement): Palette {
  const bg = resolveColor(host, '--bg')
  return {
    ink: resolveColor(host, '--ascii-field'),
    accent: resolveColor(host, '--accent'),
    fg: resolveColor(host, '--fg'),
    fg3: resolveColor(host, '--fg3'),
    bg,
    dark: bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114 < 128
  }
}

function css(color: Rgba, alpha = 1): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${(color[3] * alpha).toFixed(3)})`
}

function readMonoStack(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
  return raw || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function easeOutExpo(value: number): number {
  const x = clamp01(value)
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)
}

function buildFog(): HTMLCanvasElement {
  const tile = document.createElement('canvas')
  tile.width = FOG_W
  tile.height = FOG_H
  const g = tile.getContext('2d')
  if (!g) return tile
  const image = g.createImageData(FOG_W, FOG_H)
  for (let y = 0; y < FOG_H; y++) {
    const bell = Math.pow(Math.sin((Math.PI * (y + 0.5)) / FOG_H), 1.4)
    for (let x = 0; x < FOG_W; x++) {
      const k = x / FOG_W
      const noise = fbm(x * 0.045, y * 0.09, 0, LANDSCAPE_SEED + 31) * (1 - k) + fbm((x - FOG_W) * 0.045, y * 0.09, 0, LANDSCAPE_SEED + 31) * k
      image.data[(y * FOG_W + x) * 4 + 3] = Math.round(smoothstep((noise - 0.4) / 0.28) * bell * 255)
    }
  }
  g.putImageData(image, 0, 0)
  return tile
}

function buildAtlas(cellPx: number, ink: string, accent: string, mono: string): HTMLCanvasElement {
  const atlas = document.createElement('canvas')
  atlas.width = CHARSET.length * cellPx
  atlas.height = cellPx * LEVELS * 2
  const g = atlas.getContext('2d')
  if (!g) return atlas
  g.font = `${Math.max(6, cellPx)}px ${mono}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  for (let tone = 0; tone < 2; tone++) {
    g.fillStyle = tone ? accent : ink
    for (let level = 0; level < LEVELS; level++) {
      g.globalAlpha = ((level + 1) / LEVELS) * ALPHA_TOP
      const cy = (tone * LEVELS + level) * cellPx + cellPx / 2
      for (let i = 0; i < CHARSET.length; i++) g.fillText(CHARSET[i], i * cellPx + cellPx / 2, cy)
    }
  }
  return atlas
}

function buildLayer(layout: LandscapeLayout, spec: LandscapeLayerSpec, values: readonly number[], dpr: number, palette: Palette, washGain: number, center: number): LayerArt {
  const ridge = buildRidge(layout, spec, values, center)
  const base = layerBase(layout, spec)
  const rise = layerRise(layout, spec)
  let top = Number.POSITIVE_INFINITY
  for (let i = 0; i < ridge.length; i++) if (ridge[i] < top) top = ridge[i]
  top = Math.floor(top) - 2
  const spanW = ridge.length
  const spanH = Math.max(1, Math.ceil(base + LANDSCAPE_TAIL) - top)
  const make = (): HTMLCanvasElement => {
    const el = document.createElement('canvas')
    el.width = Math.ceil(spanW * dpr)
    el.height = Math.ceil(spanH * dpr)
    return el
  }
  const trace = (g: CanvasRenderingContext2D): void => {
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.beginPath()
    g.moveTo(0, spanH)
    for (let i = 0; i < spanW; i += 2) g.lineTo(i, ridge[i] - top)
    g.lineTo(spanW, ridge[spanW - 1] - top)
    g.lineTo(spanW, spanH)
    g.closePath()
  }
  const mask = make()
  const ink = make()
  const presence = new Float32Array(spanW)
  const m = mask.getContext('2d')
  const g = ink.getContext('2d')
  if (!m || !g) return { ink, mask, ridge, presence, top, base, rise }
  trace(m)
  m.clip()
  trace(g)
  g.clip()
  for (let i = 0; i < spanW; i += STRIP) {
    const mid = Math.min(spanW - 1, i + 1)
    const y = ridge[mid] - top
    const here = ridgePresence(layout, spec, ridge[mid])
    for (let k = i; k < i + STRIP && k < spanW; k++) presence[k] = here
    if (here <= 0) continue
    m.fillStyle = `rgba(0,0,0,${here.toFixed(3)})`
    m.fillRect(i, 0, STRIP, spanH)
    const today = spec.id === 2 ? smoothstep(1 - Math.abs(dayAt(layout, mid - LANDSCAPE_PAD) - LAST) / 0.6) : 0
    const tint: Rgba = [
      Math.round(palette.ink[0] + (palette.accent[0] - palette.ink[0]) * today),
      Math.round(palette.ink[1] + (palette.accent[1] - palette.ink[1]) * today),
      Math.round(palette.ink[2] + (palette.accent[2] - palette.ink[2]) * today),
      palette.ink[3] + (palette.accent[3] - palette.ink[3]) * today
    ]
    const alpha = spec.wash * washGain * (1 + today * 0.5) * here
    const grad = g.createLinearGradient(0, y - 2, 0, spanH)
    grad.addColorStop(0, css(tint, alpha))
    grad.addColorStop(0.1, css(tint, alpha * 0.6))
    grad.addColorStop(0.32, css(tint, alpha * 0.3))
    grad.addColorStop(0.62, css(tint, alpha * (spec.material === 'glyph' ? 0.2 : 0.1)))
    grad.addColorStop(1, css(tint, spec.material === 'glyph' ? alpha * 0.16 : 0))
    g.fillStyle = grad
    g.fillRect(i, 0, STRIP, spanH)
  }
  return { ink, mask, ridge, presence, top, base, rise }
}

function startLandscape(host: HTMLElement, canvas: HTMLCanvasElement): LandscapeHandle {
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return { setData: () => undefined, setClosing: () => undefined, dispose: () => undefined }

  let width = 1
  let height = 1
  let dpr = 1
  let cellPx = LANDSCAPE_CELL
  let data: LandscapeData | null = null
  let layout: LandscapeLayout | null = null
  let layers: LayerArt[] = []
  let palette = readPalette(host)
  let sky = landscapeSky(Date.now())
  let mono = readMonoStack()
  let atlas: HTMLCanvasElement | null = null
  let atlasKey = ''
  let fog: HTMLCanvasElement | null = null
  const texture = new Float32Array(LANDSCAPE_LAYERS.length * TEX_COLS * TEX_ROWS).fill(-1)
  let skyTop = SKY_FALLBACK
  let floor = 0
  let hostRect = host.getBoundingClientRect()
  let pageVisible = document.visibilityState !== 'hidden'
  let inViewport = true
  let focused = document.hasFocus()
  let reduced = prefersReducedMotion()
  let closing = false
  let running = false
  let raf = 0
  let lastDraw = Number.NEGATIVE_INFINITY
  let elapsed = 0
  let enterAt = 0
  let measuredAt = 0
  let busy = true
  let parallax = 0
  let parallaxTarget = 0
  let hoverIndex = -1
  let hoverWeight = 0
  let hoverTarget = 0
  let hoverX = 0
  let hoverGoal = 0
  let pulses: Pulse[] = []
  let stir = 0
  let lastPointerX = 0
  let lastPointerY = 0
  const ridgeY = new Float32Array(LANDSCAPE_LAYERS.length)
  const shiftX = new Float32Array(LANDSCAPE_LAYERS.length)
  const shiftY = new Float32Array(LANDSCAPE_LAYERS.length)
  const shown = new Float32Array(LANDSCAPE_LAYERS.length)

  const textureAt = (layer: number, col: number, row: number): number => {
    if (col >= TEX_COLS || row >= TEX_ROWS) return 0.9
    const index = (layer * TEX_ROWS + row) * TEX_COLS + col
    const cached = texture[index]
    if (cached >= 0) return cached
    const id = LANDSCAPE_LAYERS[layer].id
    const value = 0.35 + 1.1 * fbm((col + 0.5) * LANDSCAPE_CELL * 0.06 + id * 9, (row + 0.5) * LANDSCAPE_CELL * 0.009 + id * 3, 0, LANDSCAPE_SEED + 3)
    texture[index] = value
    return value
  }

  const measure = (): boolean => {
    const empty = host.parentElement?.querySelector<HTMLElement>('[data-testid="v3-empty"]') ?? null
    const sky = empty?.querySelector<HTMLElement>('[data-landscape-sky]')?.getBoundingClientRect()
    hostRect = host.getBoundingClientRect()
    const nextSky = sky && sky.height > 0 ? Math.round(sky.bottom - hostRect.top + 12) : SKY_FALLBACK
    const nextFloor = height - FLOOR_INSET
    if (nextSky === skyTop && nextFloor === floor) return false
    skyTop = nextSky
    floor = nextFloor
    return true
  }

  const rebuild = (): void => {
    if (!data) {
      layout = null
      layers = []
      return
    }
    layout = landscapeLayout(width, height, skyTop, floor)
    const source = data
    const plan = layout
    const washGain = palette.dark ? 0.7 : 1
    const center = farCenter(plan, mainDay(source.near.values))
    layers = plan.visible ? LANDSCAPE_LAYERS.map((spec) => buildLayer(plan, spec, source[spec.window].values, dpr, palette, washGain, center)) : []
  }

  const ensureAtlas = (): void => {
    const key = `${cellPx}|${css(palette.ink)}|${css(palette.accent)}|${mono}`
    if (atlas && atlasKey === key) return
    atlas = buildAtlas(cellPx, css(palette.ink), css(palette.accent), mono)
    atlasKey = key
  }

  const resize = (): void => {
    width = Math.max(1, host.clientWidth)
    height = Math.max(1, host.clientHeight)
    dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1))
    cellPx = Math.max(1, Math.round(LANDSCAPE_CELL * dpr))
    const bw = Math.round(width * dpr)
    const bh = Math.round(height * dpr)
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    measure()
    rebuild()
  }

  const draw = (dt: number): void => {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (closing || !data || !layout || !layout.visible || layers.length === 0) {
      busy = false
      return
    }
    ensureAtlas()
    if (!atlas) return
    const plan = layout
    const source = data
    const sheet = atlas
    const t = elapsed / 1000
    const since = reduced || !running ? SETTLE_S + 1 : t - enterAt

    if (reduced) {
      parallax = 0
      hoverWeight = hoverTarget
      hoverX = hoverGoal
    } else {
      parallax += (parallaxTarget - parallax) * (1 - Math.exp(-dt * 6))
      hoverWeight += (hoverTarget - hoverWeight) * (1 - Math.exp(-dt * 10))
      hoverX = hoverWeight < 0.04 && hoverTarget > 0 ? hoverGoal : hoverX + (hoverGoal - hoverX) * (1 - Math.exp(-dt * 14))
    }
    pulses = pulses.filter((pulse) => t - pulse.at < PULSE_S)

    for (let i = 0; i < LANDSCAPE_LAYERS.length; i++) {
      const spec = LANDSCAPE_LAYERS[i]
      const rise = easeOutExpo((since - (2 - spec.id) * 0.12) / RISE_S)
      shown[i] = rise
      shiftX[i] = -parallax * PARALLAX_PX * spec.depth
      shiftY[i] = (1 - rise) * plan.rise * 0.16
    }

    stir = reduced ? 0 : stir * Math.exp(-dt * 1.6)
    const veil = clamp01(since / 1.6)
    if (sky) {
      const discR = plan.rise * 0.12 * dpr
      const glowR = discR * 3.4
      const glowCx = (width * (0.16 + sky.progress * 0.68) - parallax * PARALLAX_PX * 0.1) * dpr
      const glowCy = (plan.base - plan.rise * (0.62 + 0.58 * Math.sin(Math.PI * sky.progress))) * dpr
      const visible = veil * smoothstep(Math.min(sky.progress, 1 - sky.progress) / 0.04)
      const glow = ctx.createRadialGradient(glowCx, glowCy, 0, glowCx, glowCy, glowR)
      const glowAlpha = (palette.dark ? 0.07 : 0.04) * visible * (sky.moon?.illumination ?? 1)
      glow.addColorStop(0, css(palette.ink, glowAlpha))
      glow.addColorStop(0.4, css(palette.ink, glowAlpha * 0.3))
      glow.addColorStop(1, css(palette.ink, 0))
      ctx.fillStyle = glow
      ctx.fillRect(glowCx - glowR, glowCy - glowR, glowR * 2, glowR * 2)
      ctx.save()
      ctx.fillStyle = css(palette.ink, (palette.dark ? 0.3 : 0.2) * visible)
      ctx.shadowColor = css(palette.ink, 0.15 * visible)
      ctx.shadowBlur = discR * 0.08
      if (sky.moon) traceMoon(ctx, glowCx, glowCy, discR, sky.moon)
      else {
        ctx.beginPath()
        ctx.arc(glowCx, glowCy, discR, 0, Math.PI * 2)
      }
      ctx.fill()
      ctx.restore()
    }

    const band = (center: number, tall: number, speed: number, strength: number): void => {
      if (reduced) return
      fog ??= buildFog()
      const tileW = FOG_SPAN * dpr
      let at = -((((t * speed * dpr) % tileW) + tileW) % tileW)
      ctx.globalCompositeOperation = 'destination-out'
      ctx.globalAlpha = strength * veil
      for (; at < canvas.width; at += tileW) ctx.drawImage(fog, at, (center - tall / 2) * dpr, tileW, tall * dpr)
      ctx.globalCompositeOperation = 'source-over'
    }

    for (let i = layers.length - 1; i >= 0; i--) {
      if (shown[i] <= 0) continue
      const art = layers[i]
      const x = (shiftX[i] - LANDSCAPE_PAD) * dpr
      const y = (art.top + shiftY[i]) * dpr
      ctx.globalAlpha = shown[i]
      ctx.globalCompositeOperation = 'destination-out'
      ctx.drawImage(art.mask, x, y)
      ctx.globalCompositeOperation = 'source-over'
      ctx.drawImage(art.ink, x, y)
      if (i > 0) band(art.base - art.rise * 0.12, plan.rise * (i === 1 ? 0.34 : 0.46), i === 1 ? -7 : 11, i === 1 ? 0.6 : 0.5)
    }

    ctx.globalAlpha = 1
    const inkGain = palette.dark ? 0.72 : 1
    const step = LANDSCAPE_CELL * dpr
    const cols = Math.ceil(width / LANDSCAPE_CELL)
    const rowTop = 0
    const rowBottom = Math.min(Math.ceil(height / LANDSCAPE_CELL), Math.floor(plan.base / LANDSCAPE_CELL))
    const sweeping = since < SWEEP_S + 0.4
    const sweep = sweeping ? easeOutCubic(clamp01(since / SWEEP_S)) * (width + 360) - 180 : 0
    const hoverU = dayAt(plan, hoverX)
    const hovering = hoverWeight > 0.01
    const ringing = pulses.length > 0

    for (let col = 0; col < cols; col++) {
      const px = (col + 0.5) * LANDSCAPE_CELL
      let reveal = 1
      let front = 0
      if (sweeping) {
        reveal = smoothstep((sweep - px) / 240)
        const edge = (sweep - px - 50) / 60
        front = Math.exp(-edge * edge)
      }
      for (let i = 0; i < layers.length; i++) ridgeY[i] = shown[i] > 0 ? ridgeAt(layers[i].ridge, px - shiftX[i]) + shiftY[i] : Number.POSITIVE_INFINITY
      const u = dayAt(plan, px - shiftX[0])
      const today = smoothstep(1 - Math.abs(u - LAST) / 0.6)
      const near = hovering ? Math.exp(-((u - hoverU) * (u - hoverU)) / 0.26) : 0
      const x = Math.round(col * step)
      for (let row = rowTop; row < rowBottom; row++) {
        const py = (row + 0.5) * LANDSCAPE_CELL
        let alpha = 0
        let tone = 0
        let inside = false
        let dotted = false
        for (let i = 0; i < layers.length; i++) {
          const depth = py - ridgeY[i]
          if (depth < 0) continue
          const art = layers[i]
          const solid = art.presence[Math.min(art.presence.length - 1, Math.max(0, Math.round(px - shiftX[i]) + LANDSCAPE_PAD))]
          if (solid < 0.5) continue
          if (LANDSCAPE_LAYERS[i].material === 'wash') break
          inside = true
          alpha = solid * glyphInk(LANDSCAPE_LAYERS[i], depth, art.rise, textureAt(i, col, row)) * shown[i] * inkGain
          if (i === 1) dotted = true
          if (i === 0) {
            if (today > 0 && depth < art.rise * 0.14) {
              alpha = Math.max(alpha, 0.75 * Math.exp(-depth / 22) * today * shown[0])
              if (today > 0.5) tone = 1
            }
            if (hovering) alpha *= 1 + hoverWeight * (near * 0.7 - (1 - near) * 0.3)
          }
          break
        }
        let ring = 0
        if (ringing) {
          for (const pulse of pulses) {
            const age = t - pulse.at
            const edge = (Math.hypot(px - pulse.x, py - pulse.y) - age * PULSE_SPEED) / 34
            ring += Math.exp(-edge * edge) * (1 - age / PULSE_S)
          }
        }
        if (inside) alpha *= reveal * (1 + front * 1.4) * (1 + ring * 1.5)
        else if (ring > 0.04) alpha = ring * 0.3
        else continue
        if (alpha <= 0.014) continue
        alpha *= 0.9 + 0.1 * Math.sin(t * 0.7 + hash3i(col, row, 2, LANDSCAPE_SEED) * 6.283)
        const tick = Math.floor(t / (0.5 + hash3i(col, row, 5, LANDSCAPE_SEED) * 3) + hash3i(col, row, 9, LANDSCAPE_SEED) * 7)
        const pick = hash3i(col, row, tick, LANDSCAPE_SEED + 11)
        const glyph = dotted || alpha < DUST_BELOW ? Math.floor(pick * DUST.length) : DUST.length + Math.floor(pick * CORE.length)
        const level = Math.min(LEVELS - 1, Math.floor((alpha / ALPHA_TOP) * LEVELS))
        ctx.drawImage(sheet, glyph * cellPx, (tone * LEVELS + level) * cellPx, cellPx, cellPx, x, Math.round(row * step), cellPx, cellPx)
      }
    }

    const waterTop = Math.round(plan.base * dpr)
    ctx.globalAlpha = 1
    ctx.clearRect(0, waterTop, canvas.width, canvas.height - waterTop)
    const span = Math.max(0, Math.min(plan.rise * 0.5, floor - plan.base - 6))
    const slice = Math.max(2, Math.round(2 * dpr))
    const slices = Math.floor((span * dpr) / slice)
    for (let k = 0; k < slices; k++) {
      const sy = waterTop - (k + 1) * slice * WATER_SQUASH
      if (sy < 0) break
      const far = k / slices
      const sway = reduced ? 0 : (Math.sin(k * 0.52 + t * 1.25) * (1.2 + 5 * far) * (1 + stir * 2.4) + Math.sin(k * 0.19 - t * 0.6) * 3.5 * far) * dpr
      ctx.globalAlpha = reflectionAlpha(k * slice, slices * slice) * veil
      ctx.drawImage(canvas, 0, sy, canvas.width, slice * WATER_SQUASH, sway, waterTop + k * slice, canvas.width, slice)
    }
    ctx.globalAlpha = 0.5 * veil
    ctx.fillStyle = css(palette.ink, palette.dark ? 0.1 : 0.12)
    ctx.fillRect(0, waterTop, canvas.width, Math.max(1, Math.round(dpr)))
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 1
    const feather = Math.min(160, Math.max(48, width * 0.1)) * dpr
    const left = ctx.createLinearGradient(0, 0, feather, 0)
    left.addColorStop(0, 'rgba(0,0,0,1)')
    left.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = left
    ctx.fillRect(0, 0, feather, canvas.height)
    const right = ctx.createLinearGradient(canvas.width, 0, canvas.width - feather, 0)
    right.addColorStop(0, 'rgba(0,0,0,1)')
    right.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = right
    ctx.fillRect(canvas.width - feather, 0, feather, canvas.height)
    ctx.globalCompositeOperation = 'source-over'

    const summit = peakX(plan, LAST)
    if (!reduced && shown[0] > 0.6 && summit + shiftX[0] < width - feather / dpr / 2) {
      const crest = ridgeAt(layers[0].ridge, summit) + shiftY[0]
      for (let k = 0; k < 5; k++) {
        const cycle = t * 0.2 + k / 5
        const round = Math.floor(cycle)
        const life = cycle - round
        const ex = summit + shiftX[0] + (hash3i(k, round, 1, LANDSCAPE_SEED) - 0.5) * 26 * (0.3 + life)
        const ey = crest - 4 - life * plan.rise * 0.26
        const level = Math.min(LEVELS - 1, Math.floor(Math.sin(Math.PI * life) * 0.7 * LEVELS))
        const glyph = DUST.length + Math.floor(hash3i(k, round, 3, LANDSCAPE_SEED) * CORE.length)
        ctx.drawImage(sheet, glyph * cellPx, (LEVELS + level) * cellPx, cellPx, cellPx, ex * dpr - cellPx / 2, ey * dpr - cellPx / 2, cellPx, cellPx)
      }
    }

    if (hoverWeight > 0.02 && hoverIndex >= 0) {
      const lx = Math.min(width - 52, Math.max(52, hoverX + shiftX[0]))
      const ly = ridgeAt(layers[0].ridge, hoverX) + shiftY[0]
      const text = dayLabel(source.near.dates[hoverIndex], compactNumber(source.near.tokens[hoverIndex]))
      ctx.globalAlpha = hoverWeight
      ctx.fillStyle = css(palette.fg3)
      ctx.fillRect(Math.round(lx * dpr), Math.round((ly - 16) * dpr), Math.max(1, Math.round(dpr)), Math.round(9 * dpr))
      ctx.font = `${Math.round(12 * dpr)}px ${mono}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.shadowColor = css(palette.bg)
      ctx.shadowBlur = 8 * dpr
      ctx.fillStyle = css(palette.fg)
      ctx.fillText(text, lx * dpr, (ly - 22) * dpr)
      ctx.fillText(text, lx * dpr, (ly - 22) * dpr)
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'
      ctx.globalAlpha = 1
    }

    busy =
      since < SETTLE_S ||
      ringing ||
      stir > 0.03 ||
      Math.abs(parallaxTarget - parallax) > 0.002 ||
      Math.abs(hoverTarget - hoverWeight) > 0.01 ||
      (hoverWeight > 0.01 && Math.abs(hoverGoal - hoverX) > 0.3)
  }

  const policy = (): { active: boolean; fps: number } => animationPolicy({ visible: pageVisible && inViewport, focused, reducedMotion: reduced })

  const frameStep = (now: number): void => {
    raf = 0
    if (closing || !policy().active) {
      running = false
      return
    }
    const fps = busy ? LIVE_FPS : IDLE_FPS
    if (now - lastDraw >= frameInterval(fps) - FRAME_SLACK_MS) {
      const dt = lastDraw === Number.NEGATIVE_INFINITY ? 0 : Math.min(100, now - lastDraw)
      lastDraw = now
      elapsed += dt
      if (elapsed - measuredAt > MEASURE_MS) {
        measuredAt = elapsed
        if (measure()) rebuild()
      }
      draw(dt / 1000)
    }
    raf = requestAnimationFrame(frameStep)
  }

  const start = (): void => {
    if (running || reduced || closing) return
    running = true
    lastDraw = Number.NEGATIVE_INFINITY
    raf = requestAnimationFrame(frameStep)
  }

  const stop = (): void => {
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  const apply = (): void => {
    if (closing) return
    if (!policy().active) {
      stop()
      if (reduced) draw(0)
      return
    }
    start()
  }

  const wake = (): void => {
    busy = true
    if (reduced) draw(0)
  }

  const localPoint = (event: PointerEvent): { x: number; y: number; inside: boolean; free: boolean } => {
    const x = event.clientX - hostRect.left
    const y = event.clientY - hostRect.top
    const target = event.target instanceof Element ? event.target : null
    const inside = x >= 0 && y >= 0 && x <= hostRect.width && y <= hostRect.height
    const free = inside && !!target && !!host.parentElement?.contains(target) && !target.closest(INTERACTIVE)
    return { x, y, inside, free }
  }

  const onPointerMove = (event: PointerEvent): void => {
    const point = localPoint(event)
    parallaxTarget = point.inside ? Math.max(-1, Math.min(1, (point.x - width / 2) / (width / 2))) : 0
    if (point.inside) stir = Math.min(1, stir + Math.hypot(point.x - lastPointerX, point.y - lastPointerY) * 0.004)
    lastPointerX = point.x
    lastPointerY = point.y
    const day = point.free && layout && data ? hoverDay(layout, point.x - shiftX[0], point.y, skyTop) : -1
    if (day >= 0 && layout) {
      hoverIndex = day
      hoverGoal = peakX(layout, day)
      hoverTarget = 1
    } else {
      hoverTarget = 0
    }
    wake()
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (reduced || closing || !layout?.visible) return
    const point = localPoint(event)
    if (!point.free || point.y > floor) return
    pulses = [...pulses.slice(-2), { x: point.x, y: point.y, at: elapsed / 1000 }]
    stir = 1
    wake()
  }
  const onPointerLeave = (): void => {
    parallaxTarget = 0
    hoverTarget = 0
    wake()
  }
  const onScroll = (): void => {
    hostRect = host.getBoundingClientRect()
  }
  const onClock = (): void => {
    sky = landscapeSky(Date.now())
    if (!pageVisible || !inViewport) return
    wake()
    if (!running && !reduced) draw(0)
  }
  const onVisibility = (): void => {
    pageVisible = document.visibilityState !== 'hidden'
    if (pageVisible) onClock()
    apply()
  }
  const onFocus = (): void => {
    focused = true
    onClock()
    apply()
  }
  const onBlur = (): void => {
    focused = false
    parallaxTarget = 0
    hoverTarget = 0
    apply()
  }
  const onReducedChange = (): void => {
    reduced = prefersReducedMotion()
    apply()
  }
  const onTheme = (): void => {
    palette = readPalette(host)
    mono = readMonoStack()
    rebuild()
    wake()
    if (!running) draw(0)
  }

  const ro = new ResizeObserver(() => {
    resize()
    draw(0)
  })
  const io = new IntersectionObserver((entries) => {
    inViewport = entries.some((entry) => entry.isIntersecting)
    apply()
  })
  const themeObserver = new MutationObserver(onTheme)
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)')

  resize()
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  document.documentElement.addEventListener('pointerleave', onPointerLeave)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  const unsubscribeReduced = subscribeReducedMotion(onReducedChange)
  darkMedia.addEventListener('change', onTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  ro.observe(host)
  io.observe(host)
  const settle = window.setTimeout(() => {
    if (measure()) rebuild()
    if (!running) draw(0)
  }, MEASURE_MS)
  const clock = window.setInterval(onClock, 60_000)
  apply()

  return {
    setData: (next) => {
      const first = !data && !!next
      data = next
      if (first) enterAt = elapsed / 1000
      measure()
      rebuild()
      wake()
      if (!running) draw(0)
    },
    setClosing: (next) => {
      if (next === closing) return
      closing = next
      if (next) stop()
      else apply()
    },
    dispose: () => {
      stop()
      window.clearTimeout(settle)
      window.clearInterval(clock)
      ro.disconnect()
      io.disconnect()
      themeObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onScroll, { capture: true })
      document.documentElement.removeEventListener('pointerleave', onPointerLeave)
      unsubscribeReduced()
      darkMedia.removeEventListener('change', onTheme)
    }
  }
}

export interface UsageLandscapeProps {
  active: boolean
  enabled?: boolean
}

export function UsageLandscape({ active, enabled = true }: UsageLandscapeProps): JSX.Element | null {
  const { present: mounted, closing } = usePresence(active && enabled)
  const stats = useUsageStats('all')
  const data = useMemo(() => (stats ? landscapeData(stats.heat) : null), [stats])
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const handleRef = useRef<LandscapeHandle | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  useEffect(() => {
    if (!mounted) return undefined
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return undefined
    const handle = startLandscape(host, canvas)
    handleRef.current = handle
    handle.setData(dataRef.current)
    return () => {
      handle.dispose()
      handleRef.current = null
    }
  }, [mounted])

  useEffect(() => {
    handleRef.current?.setData(data)
  }, [data])

  useEffect(() => {
    handleRef.current?.setClosing(closing)
  }, [closing])

  if (!mounted) return null
  return (
    <div className="v3-ascii-field" data-kind="landscape" data-closing={closing ? '1' : '0'} ref={hostRef} aria-hidden="true" data-testid="v3-ascii-field">
      <canvas ref={canvasRef} />
    </div>
  )
}
