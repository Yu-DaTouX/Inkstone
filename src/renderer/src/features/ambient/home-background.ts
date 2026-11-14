import { useSyncExternalStore } from 'react'
const twilightPainting = new URL('../../assets/wallpapers/twilight-in-the-wilderness.webp', import.meta.url).href
const blossomPhoto = new URL('../../assets/wallpapers/blossom.webp', import.meta.url).href

export type HomeBackgroundMode = 'ascii' | 'dither' | 'image' | 'none'
export type HomeImageEffect = 'none' | 'dither' | 'halftone'
export type HomeMaskTone = 'page' | 'dark' | 'light'

export type HomeDitherShape = 'warp' | 'swirl' | 'simplex' | 'ripple' | 'wave'
export type HomeInk = 'mono' | 'accent' | 'ember' | 'cyan' | 'gray'
export type HomeDotShape = 'classic' | 'gooey' | 'holes' | 'soft'
export type HomeGrid = 'hex' | 'square'

export interface HomeEffectParams {
  shape: HomeDitherShape
  ink: HomeInk
  pixel: number
  speed: number
  strength: number
  colorSteps: number
  dotSize: number
  contrast: number
  grid: HomeGrid
  dotShape: HomeDotShape
  twinkle: number
  breath: number
  scale: number
  offsetX: number
  offsetY: number
  sessionStrength: number
  sessionSpeed: number
}

export const HOME_PARAM_DEFAULTS: HomeEffectParams = { shape: 'warp', ink: 'accent', pixel: 2, speed: 0.18, strength: 0.42, colorSteps: 4, dotSize: 0.3, contrast: 0.75, grid: 'hex', dotShape: 'classic', twinkle: 0.7, breath: 0.5, scale: 1, offsetX: 0, offsetY: 0, sessionStrength: 0.2, sessionSpeed: 0.1 }
export const HOME_PARAM_RANGES = {
  pixel: [1, 8, 1],
  speed: [0, 1, 0.02],
  strength: [0.1, 1, 0.02],
  colorSteps: [1, 7, 1],
  dotSize: [0.1, 1, 0.02],
  contrast: [0, 1, 0.05],
  twinkle: [0, 1, 0.05],
  breath: [0, 1, 0.05],
  scale: [0.4, 1.6, 0.02],
  offsetX: [-0.5, 0.5, 0.02],
  offsetY: [-0.5, 0.5, 0.02],
  sessionStrength: [0, 1, 0.02],
  sessionSpeed: [0, 1, 0.02]
} as const satisfies Record<string, readonly [number, number, number]>

function pickOne<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function within(value: unknown, key: keyof typeof HOME_PARAM_RANGES): number {
  const [min, max] = HOME_PARAM_RANGES[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : HOME_PARAM_DEFAULTS[key]
}

export function sanitizeHomeParams(raw: unknown): HomeEffectParams {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    shape: pickOne(v.shape, ['warp', 'swirl', 'simplex', 'ripple', 'wave'], HOME_PARAM_DEFAULTS.shape),
    ink: pickOne(v.ink, ['mono', 'accent', 'ember', 'cyan', 'gray'], HOME_PARAM_DEFAULTS.ink),
    pixel: within(v.pixel, 'pixel'),
    speed: within(v.speed, 'speed'),
    strength: within(v.strength, 'strength'),
    colorSteps: within(v.colorSteps, 'colorSteps'),
    dotSize: within(v.dotSize, 'dotSize'),
    contrast: within(v.contrast, 'contrast'),
    grid: pickOne(v.grid, ['hex', 'square'], HOME_PARAM_DEFAULTS.grid),
    dotShape: pickOne(v.dotShape, ['classic', 'gooey', 'holes', 'soft'], HOME_PARAM_DEFAULTS.dotShape),
    twinkle: within(v.twinkle, 'twinkle'),
    breath: within(v.breath, 'breath'),
    scale: within(v.scale, 'scale'),
    offsetX: within(v.offsetX, 'offsetX'),
    offsetY: within(v.offsetY, 'offsetY'),
    sessionStrength: within(v.sessionStrength, 'sessionStrength'),
    sessionSpeed: within(v.sessionSpeed, 'sessionSpeed')
  }
}

export interface HomeBackground {
  mode: HomeBackgroundMode | null
  image: string | null
  fade: number
  blur: number
  tone: HomeMaskTone
  effect: HomeImageEffect
  flowImage: boolean
  flowStyle: HomeFlowStyle
  params: HomeEffectParams
}

export type HomeFlowStyle = 'dither' | 'halftone'

export const BUILTIN_PAINTING = 'builtin:twilight'
export const BUILTIN_BLOSSOM = 'builtin:blossom'
const BUILTIN_IMAGES: Record<string, string> = { [BUILTIN_PAINTING]: twilightPainting, [BUILTIN_BLOSSOM]: blossomPhoto }
export const BLOSSOM_PARAMS: Partial<HomeEffectParams> = { ink: 'mono', dotShape: 'classic', grid: 'square', dotSize: 0.45, contrast: 0.6, strength: 0.8, speed: 0.3, twinkle: 0.7, breath: 0.5, scale: 0.72, offsetX: 0, offsetY: 0 }
const STORAGE_KEY = 'yan:home-background'
const MAX_EDGE = 2560
const DEFAULT_FADE = 0.35
export const HOME_BLUR_MAX = 40
const EMPTY: HomeBackground = { mode: null, image: null, fade: DEFAULT_FADE, blur: 0, tone: 'page', effect: 'none', flowImage: false, flowStyle: 'dither', params: HOME_PARAM_DEFAULTS }

let cached: HomeBackground | null = null
const listeners = new Set<() => void>()

function read(): HomeBackground {
  if (cached) return cached
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<HomeBackground> | null
    cached = {
      mode: raw?.mode === 'ascii' || raw?.mode === 'dither' || raw?.mode === 'image' || raw?.mode === 'none' ? raw.mode : null,
      image: typeof raw?.image === 'string' && (raw.image.startsWith('data:image/') || raw.image in BUILTIN_IMAGES) ? raw.image : null,
      fade: typeof raw?.fade === 'number' && raw.fade >= 0 && raw.fade <= 0.9 ? raw.fade : DEFAULT_FADE,
      blur: typeof raw?.blur === 'number' && raw.blur >= 0 && raw.blur <= HOME_BLUR_MAX ? raw.blur : 0,
      tone: raw?.tone === 'dark' || raw?.tone === 'light' ? raw.tone : 'page',
      effect: raw?.effect === 'dither' || raw?.effect === 'halftone' ? raw.effect : 'none',
      flowImage: raw?.flowImage === true,
      flowStyle: raw?.flowStyle === 'halftone' ? 'halftone' : 'dither',
      params: sanitizeHomeParams(raw?.params)
    }
  } catch {
    cached = EMPTY
  }
  return cached
}

export function updateHomeBackground(patch: Partial<HomeBackground>): void {
  const next = { ...read(), ...patch }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  cached = next
  for (const listener of listeners) listener()
}

export function updateHomeParams(patch: Partial<HomeEffectParams>): void {
  updateHomeBackground({ params: { ...read().params, ...patch } })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY) return
    cached = null
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useHomeBackground(): HomeBackground {
  return useSyncExternalStore(subscribe, read, () => EMPTY)
}

export function homeBackgroundMode(background: HomeBackground, asciiEnabled: boolean): HomeBackgroundMode {
  if (background.mode === 'image' && !background.image) return asciiEnabled ? 'ascii' : 'none'
  return background.mode ?? (asciiEnabled ? 'ascii' : 'none')
}

export async function shrinkImage(dataUrl: string): Promise<string> {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/webp', 0.85)
}

export function homeImageSource(image: string): string {
  return BUILTIN_IMAGES[image] ?? image
}
