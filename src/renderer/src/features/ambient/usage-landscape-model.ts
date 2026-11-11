import { fbm, smoothstep } from './ascii-field-model'

export const LANDSCAPE_DAYS = 14
export const LANDSCAPE_CELL = 10
export const LANDSCAPE_PAD = 48
export const LANDSCAPE_SEED = 2711
export const LANDSCAPE_FLOOR_GAP = 104
export const LANDSCAPE_TAIL = 30
const RISE_MAX = 380
const RISE_MIN = 64
const WIDTH_MIN = 280
const STACK = 1.32
const VALLEY = 0.24
const TAPER = 1.2
const GROUND = 0.08
const CURVE = 0.7

export interface LandscapeDay {
  date: string
  tokens: number
}

export interface LandscapeWindow {
  values: number[]
  tokens: number[]
  dates: string[]
}

export interface LandscapeData {
  near: LandscapeWindow
  mid: LandscapeWindow
  far: LandscapeWindow
  total: number
}

export interface LandscapeLayerSpec {
  id: 0 | 1 | 2
  window: 'near' | 'mid' | 'far'
  material: 'glyph' | 'dots' | 'wash'
  lift: number
  scale: number
  ink: number
  wash: number
  shift: number
  depth: number
}

export const LANDSCAPE_LAYERS: readonly LandscapeLayerSpec[] = [
  { id: 2, window: 'near', material: 'glyph', lift: 0, scale: 1, ink: 0.8, wash: 0.42, shift: 0, depth: 1 },
  { id: 1, window: 'mid', material: 'dots', lift: 0.36, scale: 0.52, ink: 0.5, wash: 0.17, shift: -0.4, depth: 0.5 },
  { id: 0, window: 'far', material: 'wash', lift: 0.5, scale: 0.66, ink: 0, wash: 0.15, shift: 0, depth: 0.2 }
]

export interface LandscapeLayout {
  width: number
  height: number
  left: number
  right: number
  base: number
  rise: number
  visible: boolean
}

export function landscapeData(heat: readonly LandscapeDay[]): LandscapeData {
  const span = LANDSCAPE_DAYS * 3
  const tail = heat.slice(-span)
  const days: LandscapeDay[] = [...Array.from({ length: span - tail.length }, () => ({ date: '', tokens: 0 })), ...tail]
  const peak = days.reduce((top, day) => (day.tokens > top ? day.tokens : top), 0)
  const window = (index: number): LandscapeWindow => {
    const part = days.slice(index * LANDSCAPE_DAYS, (index + 1) * LANDSCAPE_DAYS)
    return {
      values: part.map((day) => (peak > 0 && day.tokens > 0 ? Math.pow(day.tokens / peak, CURVE) : 0)),
      tokens: part.map((day) => Math.max(0, day.tokens)),
      dates: part.map((day) => day.date)
    }
  }
  const near = window(2)
  return { near, mid: window(1), far: window(0), total: near.tokens.reduce((sum, value) => sum + value, 0) }
}

export function landscapeLayout(width: number, height: number, skyTop: number, floor: number): LandscapeLayout {
  const base = floor - LANDSCAPE_FLOOR_GAP
  const rise = Math.min(RISE_MAX, (base - skyTop) / STACK)
  return { width, height, left: width * 0.08, right: width * 0.88, base, rise, visible: rise >= RISE_MIN && width >= WIDTH_MIN }
}

export function layerBase(layout: LandscapeLayout, spec: LandscapeLayerSpec): number {
  return layout.base - layout.rise * spec.lift
}

export function layerRise(layout: LandscapeLayout, spec: LandscapeLayerSpec): number {
  return layout.rise * spec.scale
}

export function ridgeProfile(values: readonly number[], u: number): number {
  const last = values.length - 1
  if (last < 0) return 0
  if (u < 0) return values[0] * smoothstep(1 + u / TAPER)
  if (u > last) return values[last] * smoothstep(1 - (u - last) / TAPER)
  const i = Math.min(Math.max(0, last - 1), Math.floor(u))
  const t = u - i
  const next = values[Math.min(last, i + 1)]
  return (values[i] + (next - values[i]) * smoothstep(t)) * (1 - VALLEY * Math.sin(Math.PI * t))
}

export function dayAt(layout: LandscapeLayout, px: number): number {
  return ((px - layout.left) / (layout.right - layout.left)) * (LANDSCAPE_DAYS - 1)
}

export function peakX(layout: LandscapeLayout, day: number): number {
  return layout.left + (day / (LANDSCAPE_DAYS - 1)) * (layout.right - layout.left)
}

export function ridgeHeight(layout: LandscapeLayout, spec: LandscapeLayerSpec, values: readonly number[], px: number): number {
  const rise = layerRise(layout, spec)
  const profile = ridgeProfile(values, dayAt(layout, px) + spec.shift)
  const broad = (fbm(px * 0.018 + spec.id * 31, spec.id * 7.3, 0, LANDSCAPE_SEED) - 0.5) * rise * 0.12 * (0.3 + profile)
  const fine = (fbm(px * 0.07 + spec.id * 5, 3.1, 0, LANDSCAPE_SEED + 7) - 0.5) * rise * 0.05
  return layerBase(layout, spec) - rise * (GROUND + (1 - GROUND) * profile) - broad - fine
}

export function mainDay(values: readonly number[]): number {
  return values.reduce((top, value, index) => (value > values[top] ? index : top), 0)
}

export function farCenter(layout: LandscapeLayout, day: number): number {
  return layout.width * (day > (LANDSCAPE_DAYS - 1) / 2 ? 0.27 : 0.73)
}

export function farRidgeHeight(layout: LandscapeLayout, spec: LandscapeLayerSpec, px: number, center: number): number {
  const w = layout.width
  const away = center < w / 2 ? 1 : -1
  const bump = (cx: number, sigma: number, tall: number): number => tall * Math.exp(-((px - cx) * (px - cx)) / (2 * sigma * sigma))
  const mass = bump(center, w * 0.1, 1) + bump(center + away * w * 0.19, w * 0.075, 0.58) + bump(center - away * w * 0.12, w * 0.05, 0.36)
  const rough = 1 + (fbm(px * 0.011 + 40, 1.7, 0, LANDSCAPE_SEED + 23) - 0.5) * 0.4 + (fbm(px * 0.05, 5.3, 0, LANDSCAPE_SEED + 29) - 0.5) * 0.08
  return layerBase(layout, spec) - layerRise(layout, spec) * mass * rough * 0.8
}

export function ridgePresence(layout: LandscapeLayout, spec: LandscapeLayerSpec, ridgeY: number): number {
  if (spec.lift === 0) return 1
  return smoothstep(((layerBase(layout, spec) - ridgeY) / layerRise(layout, spec) - GROUND) / 0.1)
}

export function buildRidge(layout: LandscapeLayout, spec: LandscapeLayerSpec, values: readonly number[], center = layout.width / 2): Float32Array {
  const size = Math.max(1, Math.ceil(layout.width)) + LANDSCAPE_PAD * 2
  const ridge = new Float32Array(size)
  for (let i = 0; i < size; i++) ridge[i] = spec.material === 'wash' ? farRidgeHeight(layout, spec, i - LANDSCAPE_PAD, center) : ridgeHeight(layout, spec, values, i - LANDSCAPE_PAD)
  return ridge
}

export function ridgeAt(ridge: Float32Array, px: number): number {
  const at = px + LANDSCAPE_PAD
  const i = Math.floor(at)
  if (i <= 0) return ridge[0]
  if (i >= ridge.length - 1) return ridge[ridge.length - 1]
  return ridge[i] + (ridge[i + 1] - ridge[i]) * (at - i)
}

export function glyphInk(spec: LandscapeLayerSpec, depth: number, rise: number, texture: number): number {
  if (spec.material === 'wash') return 0
  if (spec.material === 'dots') return depth > 22 ? 0 : spec.ink * Math.exp(-depth / 8)
  return spec.ink * (Math.exp(-depth / 16) + 0.3 * Math.exp(-depth / (rise * 0.55)) * texture)
}

export function reflectionAlpha(depth: number, span: number): number {
  if (span <= 0 || depth < 0 || depth >= span) return 0
  return 0.5 * Math.pow(1 - depth / span, 1.4)
}

export function hoverDay(layout: LandscapeLayout, px: number, py: number, skyTop: number): number {
  if (!layout.visible || py < skyTop - 8 || py > layout.base + 20) return -1
  const day = Math.round(dayAt(layout, px))
  return day < 0 || day > LANDSCAPE_DAYS - 1 ? -1 : day
}

export function dayLabel(date: string, amount: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(date)
  return match ? `${Number(match[1])}/${Number(match[2])} · ${amount}` : amount
}
