import type { AppSettings } from '../../../../shared/ipc'

export const DUST = ".,:;'"
export const CORE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
export const CHARSET = DUST + CORE
export const CELL_SIZE = 12
export const MIN_ALPHA = 0.025
export const CORE_ALPHA = 0.045
export const MAX_ALPHA = 0.12
export const ALPHA_CEILING = 0.15
export const ALPHA_LEVELS = 16
export const INK_LOW = 0.4
export const INK_CORE = 0.48
export const INK_FULL = 0.86
export const TARGET_FPS = 30
const TICK_RATE = 60
export const FRAME_SLACK_MS = 4
export const FIELD_SEED = 1337
export const ENTER_MS = 480
export const EXIT_MS = 160
export const FIELD_STRIDE = 2
export const PLUME_COUNT = 4
export const DROP_SLOT = 1.7
export const DROP_CHANCE = 0.6
export const DROP_LIFE = 4.6
export const MUTATE_BASE = 0.003
export const MUTATE_EDGE = 0.07
export const STATIC_TIME = 11.3

export interface GridSpec {
  cols: number
  rows: number
  cell: number
}

export interface ClearZone {
  x: number
  y: number
  rx: number
  ry: number
  feather: number
  box?: boolean
}

export interface MousePoint {
  x: number
  y: number
}

export interface MotionInput {
  visible: boolean
  focused: boolean
  reducedMotion: boolean
}

export interface MotionPolicy {
  active: boolean
  fps: number
}

export interface InkSource {
  x: number
  y: number
  radius: number
  strength: number
}

export interface InkSources {
  plumes: InkSource[]
  drops: InkSource[]
}

export interface FieldFrameInput {
  width: number
  height: number
  cell?: number
  time: number
  tick?: number
  seed?: number
  zones?: readonly ClearZone[]
  mouse?: MousePoint | null
  pulses?: ReadonlyArray<{ x: number; y: number; age: number }>
  anchor?: MousePoint | null
  enter?: number
}

export interface FieldFrame {
  cols: number
  rows: number
  cell: number
  alpha: Float32Array
  value: Float32Array
  accent: Uint8Array
  glyph: Uint8Array
  band: Uint8Array
  visible: number
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function smoothstep(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

export function easeOutCubic(t: number): number {
  const x = 1 - clamp01(t)
  return 1 - x * x * x
}

export function hashInt(n: number): number {
  let h = n | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = h ^ (h >>> 16)
  return (h >>> 0) / 4294967296
}

export function hash3i(x: number, y: number, z: number, seed: number): number {
  const mixed = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177) ^ Math.imul(seed | 0, 2654435761)
  return hashInt(mixed)
}

export function valueNoise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const u = smoothstep(x - xi)
  const v = smoothstep(y - yi)
  const w = smoothstep(z - zi)
  const c000 = hash3i(xi, yi, zi, seed)
  const c100 = hash3i(xi + 1, yi, zi, seed)
  const c010 = hash3i(xi, yi + 1, zi, seed)
  const c110 = hash3i(xi + 1, yi + 1, zi, seed)
  const c001 = hash3i(xi, yi, zi + 1, seed)
  const c101 = hash3i(xi + 1, yi, zi + 1, seed)
  const c011 = hash3i(xi, yi + 1, zi + 1, seed)
  const c111 = hash3i(xi + 1, yi + 1, zi + 1, seed)
  const x00 = lerp(c000, c100, u)
  const x10 = lerp(c010, c110, u)
  const x01 = lerp(c001, c101, u)
  const x11 = lerp(c011, c111, u)
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w)
}

export function valueNoise2(x: number, y: number, seed = 0): number {
  return valueNoise3(x, y, 0, seed)
}

export function fbm(x: number, y: number, z: number, seed: number, octaves = 3): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = 1
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise3(x * f, y * f, z * f, seed + o * 13) * amp
    norm += amp
    amp *= 0.5
    f *= 2.03
  }
  return sum / norm
}

export function inkSources(t: number, seed: number, aspect: number): InkSources {
  const plumes: InkSource[] = []
  for (let i = 0; i < PLUME_COUNT; i++) {
    const nx = valueNoise3(t * 0.045 + i * 17.1, i * 3.7, 0.5, seed + 50)
    const ny = valueNoise3(i * 5.3, t * 0.04 + i * 9.4, 1.5, seed + 51)
    const nr = valueNoise3(t * 0.08 + i * 2.9, i * 1.3, 2.5, seed + 52)
    plumes.push({
      x: (0.04 + nx * 0.92) * aspect,
      y: 0.04 + ny * 0.92,
      radius: 0.13 + nr * 0.12,
      strength: 0.2 + nr * 0.12
    })
  }
  const drops: InkSource[] = []
  const slot = Math.floor(t / DROP_SLOT)
  const back = Math.ceil(DROP_LIFE / DROP_SLOT) + 1
  for (let k = slot - back; k <= slot; k++) {
    if (hash3i(k, 0, 0, seed + 90) >= DROP_CHANCE) continue
    const born = (k + hash3i(k, 1, 0, seed + 90)) * DROP_SLOT
    const age = t - born
    if (age < 0 || age >= DROP_LIFE) continue
    const grow = easeOutCubic(age / 2.4)
    const fade = 1 - smoothstep((age - 1.1) / (DROP_LIFE - 1.1))
    drops.push({
      x: (0.06 + hash3i(k, 2, 0, seed + 90) * 0.88) * aspect,
      y: 0.08 + hash3i(k, 3, 0, seed + 90) * 0.84,
      radius: 0.025 + grow * (0.1 + hash3i(k, 4, 0, seed + 90) * 0.1),
      strength: 0.46 * fade
    })
  }
  return { plumes, drops }
}

function sourceSum(list: readonly InkSource[], x: number, y: number): number {
  let sum = 0
  for (const s of list) {
    const dx = x - s.x
    const dy = y - s.y
    const d2 = (dx * dx + dy * dy) / (s.radius * s.radius)
    if (d2 < 6) sum += s.strength * Math.exp(-d2)
  }
  return sum
}

export function inkAt(x: number, y: number, t: number, seed: number, sources: InkSources): number {
  const sx = x * 2.1
  const sy = y * 2.1
  const qx = fbm(sx + t * 0.03, sy, t * 0.045, seed, 2)
  const qy = fbm(sx + 5.2, sy + 1.3 - t * 0.026, t * 0.045, seed + 1, 2)
  const r = fbm(sx + 3.1 * qx + 1.7 + t * 0.018, sy + 3.1 * qy + 9.2, t * 0.06, seed + 2, 3)
  const wx = x + (qx - 0.5) * 0.34
  const wy = y + (qy - 0.5) * 0.34
  const blobs = clamp01((r - 0.5) * 1.9 + 0.5)
  return clamp01(blobs * 0.86 + sourceSum(sources.plumes, wx, wy) + sourceSum(sources.drops, wx, wy) - 0.06)
}

export function stirPoint(x: number, y: number, mouse: { x: number; y: number } | null, radius: number, t: number): { x: number; y: number; k: number } {
  if (!mouse) return { x, y, k: 0 }
  const dx = x - mouse.x
  const dy = y - mouse.y
  const d = Math.sqrt(dx * dx + dy * dy)
  if (d >= radius) return { x, y, k: 0 }
  const k = smoothstep(1 - d / radius)
  const angle = k * (2.0 + 0.35 * Math.sin(t * 1.7))
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: mouse.x + dx * c - dy * s, y: mouse.y + dx * s + dy * c, k }
}

export function cellJitter(col: number, row: number, seed: number): number {
  return (hash3i(col, row, 7, seed + 404) - 0.5) * 0.07
}

export function inkBand(value: number): 0 | 1 | 2 {
  return value > INK_CORE ? 2 : value > INK_LOW ? 1 : 0
}

export function cellAlpha(value: number): number {
  if (!(value > INK_LOW)) return 0
  if (value <= INK_CORE) return MIN_ALPHA + ((value - INK_LOW) / (INK_CORE - INK_LOW)) * (CORE_ALPHA - MIN_ALPHA) * 0.6
  const k = clamp01((value - INK_CORE) / (INK_FULL - INK_CORE))
  return CORE_ALPHA + (MAX_ALPHA - CORE_ALPHA) * Math.pow(k, 1.1)
}

export function edgeActivity(value: number): number {
  return 1 - smoothstep(Math.abs(value - INK_CORE) / 0.07)
}

export function shouldMutate(col: number, row: number, tick: number, seed: number, value: number): boolean {
  return hash3i(col, row, tick, seed + 4211) < MUTATE_BASE + MUTATE_EDGE * edgeActivity(value)
}

export function pickGlyph(band: number, col: number, row: number, tick: number, seed: number): number {
  const h = hash3i(col, row, tick, seed + 991)
  if (band === 1) return Math.floor(h * DUST.length)
  return DUST.length + Math.floor(h * CORE.length)
}

export function alphaLevel(alpha: number, levels = ALPHA_LEVELS): number {
  if (!(alpha > 0)) return -1
  const l = Math.round((alpha / ALPHA_CEILING) * levels) - 1
  if (l < 0) return 0
  return l >= levels ? levels - 1 : l
}

export function levelAlpha(level: number, levels = ALPHA_LEVELS): number {
  return ((level + 1) / levels) * ALPHA_CEILING
}

export function computeGrid(width: number, height: number, cell = CELL_SIZE): GridSpec {
  const safeCell = Math.max(6, Math.floor(cell))
  const w = Math.max(0, width)
  const h = Math.max(0, height)
  return {
    cols: Math.max(0, Math.ceil(w / safeCell)),
    rows: Math.max(0, Math.ceil(h / safeCell)),
    cell: safeCell
  }
}

export function defaultClearZones(width: number, height: number): ClearZone[] {
  const min = Math.min(width, height)
  return [
    { x: width * 0.5, y: height * 0.46, rx: Math.max(120, min * 0.18), ry: Math.max(100, min * 0.16), feather: 1.2 },
    bottomClearZone(width, height)
  ]
}

export function bottomClearZone(width: number, height: number): ClearZone {
  return { x: width * 0.5, y: height * 1.04, rx: Math.max(300, width * 0.42), ry: Math.max(110, height * 0.2), feather: 0.6 }
}

export function textClearZone(rect: { left: number; top: number; width: number; height: number }, pad = 28): ClearZone {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    rx: rect.width / 2 + pad,
    ry: rect.height / 2 + pad,
    feather: 40,
    box: true
  }
}

export function maskFactor(px: number, py: number, zones: readonly ClearZone[]): number {
  let factor = 1
  for (const zone of zones) {
    if (zone.box) {
      const dx = Math.max(0, Math.abs(px - zone.x) - zone.rx)
      const dy = Math.max(0, Math.abs(py - zone.y) - zone.ry)
      if (dx === 0 && dy === 0) return 0
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < zone.feather) {
        const next = smoothstep(d / zone.feather)
        if (next < factor) factor = next
      }
      continue
    }
    const nx = (px - zone.x) / zone.rx
    const ny = (py - zone.y) / zone.ry
    const d2 = nx * nx + ny * ny
    if (d2 <= 1) return 0
    const edge = 1 + zone.feather
    if (d2 < edge * edge) {
      const next = smoothstep((Math.sqrt(d2) - 1) / zone.feather)
      if (next < factor) factor = next
    }
  }
  return factor
}

export function ensureFrame(prev: FieldFrame | null | undefined, cols: number, rows: number, cell: number): FieldFrame {
  const total = cols * rows
  if (prev && prev.alpha.length === total && prev.cols === cols) {
    prev.rows = rows
    prev.cell = cell
    return prev
  }
  return {
    cols,
    rows,
    cell,
    alpha: new Float32Array(total),
    value: new Float32Array(total),
    accent: new Uint8Array(total),
    glyph: new Uint8Array(total),
    band: new Uint8Array(total),
    visible: 0
  }
}

let inkScratch = new Float32Array(0)

export function computeFieldFrame(input: FieldFrameInput, out?: FieldFrame | null): FieldFrame {
  const cell = Math.max(6, Math.floor(input.cell ?? CELL_SIZE))
  const grid = computeGrid(input.width, input.height, cell)
  const frame = ensureFrame(out, grid.cols, grid.rows, grid.cell)
  const { alpha, value, accent, glyph, band } = frame
  alpha.fill(0)
  value.fill(0)
  accent.fill(0)
  const zones = input.zones ?? defaultClearZones(input.width, input.height)
  const seed = input.seed ?? FIELD_SEED
  const anchor = input.anchor ?? { x: input.width * 0.5, y: input.height * 0.44 }
  const enter = input.enter ?? 1
  const t = input.time
  const tick = input.tick ?? Math.floor(t * TICK_RATE)
  const fade = Math.min(1, enter * 2)
  const height = input.height > 0 ? input.height : 1
  const mouse = input.mouse ? { x: input.mouse.x / height, y: input.mouse.y / height } : null
  const stirRadius = 250 / height
  const ax = anchor.x / height
  const ay = anchor.y / height
  const drift = Math.floor(t / 2.4)
  const ripples: Array<{ x: number; y: number; radius: number; strength: number }> = [0, 1, 2].map((k) => {
    const slot = drift - k
    const age = t - slot * 2.4
    return { x: ax + (hash3i(slot, 31, 0, seed) - 0.5) * 0.7, y: ay + (hash3i(slot, 73, 0, seed) - 0.5) * 0.5, radius: age * 0.24, strength: Math.max(0, 1 - age / 7.2) * Math.min(1, age / 0.35) }
  })

  for (const pulse of input.pulses ?? []) {
    ripples.push({ x: pulse.x / height, y: pulse.y / height, radius: pulse.age * 0.55, strength: Math.max(0, 1 - pulse.age / 2.4) * Math.min(1, pulse.age / 0.08) * 1.6 })
  }

  const fcols = Math.ceil(grid.cols / FIELD_STRIDE) + 1
  const frows = Math.ceil(grid.rows / FIELD_STRIDE) + 1
  if (inkScratch.length < fcols * frows) {
    inkScratch = new Float32Array(fcols * frows)
  }
  const step = (FIELD_STRIDE * grid.cell) / height
  const half = (grid.cell * 0.5) / height
  for (let fr = 0; fr < frows; fr++) {
    const y0 = fr * step + half
    for (let fc = 0; fc < fcols; fc++) {
      const x0 = fc * step + half
      const p = stirPoint(x0, y0, mouse, stirRadius, t)
      const i = fr * fcols + fc
      let ripple = 0
      for (const wave of ripples) {
        const distance = Math.hypot(p.x - wave.x, p.y - wave.y)
        const edge = (distance - wave.radius) / 0.075
        ripple += Math.exp(-edge * edge) * wave.strength
      }
      const focus = Math.exp(-Math.hypot(p.x - ax, p.y - ay) * 1.7)
      inkScratch[i] = 0.31 + ripple * 0.37 + focus * 0.15 + p.k * 0.3
    }
  }

  let visible = 0
  for (let row = 0; row < grid.rows; row++) {
    const py = (row + 0.5) * grid.cell
    const fy = row / FIELD_STRIDE
    const fr0 = fy | 0
    const ty = fy - fr0
    for (let col = 0; col < grid.cols; col++) {
      const px = (col + 0.5) * grid.cell
      const idx = row * grid.cols + col
      const fx = col / FIELD_STRIDE
      const fc0 = fx | 0
      const tx = fx - fc0
      const base = fr0 * fcols + fc0
      const ink = lerp(
        lerp(inkScratch[base], inkScratch[base + 1], tx),
        lerp(inkScratch[base + fcols], inkScratch[base + fcols + 1], tx),
        ty
      )
      const mask = maskFactor(px, py, zones)
      if (mask <= 0) {
        band[idx] = 0
        continue
      }
      const sample = clamp01(ink + cellJitter(col, row, seed))
      value[idx] = sample
      const nextBand = inkBand(sample)
      if (nextBand === 0) {
        band[idx] = 0
        continue
      }
      if (nextBand !== band[idx] || shouldMutate(col, row, tick, seed, sample)) {
        glyph[idx] = pickGlyph(nextBand, col, row, tick, seed)
      }
      band[idx] = nextBand
      const a = cellAlpha(sample) * fade * mask
      if (a <= 0.004) continue
      alpha[idx] = a > ALPHA_CEILING ? ALPHA_CEILING : a
      if (nextBand === 2) accent[idx] = ink > 0.72 ? 1 : 0
      visible++
    }
  }
  frame.visible = visible
  return frame
}

export function animationPolicy(input: MotionInput): MotionPolicy {
  if (input.reducedMotion) return { active: false, fps: 0 }
  if (!input.visible) return { active: false, fps: 0 }
  if (!input.focused) return { active: false, fps: 0 }
  return { active: true, fps: TARGET_FPS }
}

export function frameInterval(fps: number): number {
  return fps > 0 ? 1000 / fps : Number.POSITIVE_INFINITY
}

export function shouldDraw(now: number, lastDraw: number, fps: number): boolean {
  return now - lastDraw >= frameInterval(fps) - FRAME_SLACK_MS
}

export interface AsciiBackgroundSettings {
  asciiBackground?: boolean
}

export function asciiBackgroundEnabled(settings: AsciiBackgroundSettings | AppSettings | null | undefined): boolean {
  return (settings as AsciiBackgroundSettings | null | undefined)?.asciiBackground !== false
}

export function asciiBackgroundPatch(enabled: boolean): AsciiBackgroundSettings & Partial<AppSettings> {
  return { asciiBackground: enabled }
}
