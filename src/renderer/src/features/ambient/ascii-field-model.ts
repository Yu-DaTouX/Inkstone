import type { AppSettings } from '../../../../shared/ipc'

export const DUST = ".,:;'"
export const CORE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
export const CHARSET = DUST + CORE
export const TARGET_FPS = 30
export const FRAME_SLACK_MS = 4

export interface MotionInput {
  visible: boolean
  focused: boolean
  reducedMotion: boolean
}

export interface MotionPolicy {
  active: boolean
  fps: number
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

export function animationPolicy(input: MotionInput): MotionPolicy {
  if (input.reducedMotion) return { active: false, fps: 0 }
  if (!input.visible) return { active: false, fps: 0 }
  if (!input.focused) return { active: false, fps: 0 }
  return { active: true, fps: TARGET_FPS }
}

export function frameInterval(fps: number): number {
  return fps > 0 ? 1000 / fps : Number.POSITIVE_INFINITY
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
