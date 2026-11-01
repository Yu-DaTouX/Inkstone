import { useSyncExternalStore } from 'react'

export type HomeBackgroundMode = 'ascii' | 'image' | 'none'
export type HomeMaskTone = 'page' | 'dark' | 'light'

export interface HomeBackground {
  mode: HomeBackgroundMode | null
  image: string | null
  fade: number
  blur: number
  tone: HomeMaskTone
}

const STORAGE_KEY = 'yan:home-background'
const MAX_EDGE = 2560
const DEFAULT_FADE = 0.35
export const HOME_BLUR_MAX = 40
const EMPTY: HomeBackground = { mode: null, image: null, fade: DEFAULT_FADE, blur: 0, tone: 'page' }

let cached: HomeBackground | null = null
const listeners = new Set<() => void>()

function read(): HomeBackground {
  if (cached) return cached
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<HomeBackground> | null
    cached = {
      mode: raw?.mode === 'ascii' || raw?.mode === 'image' || raw?.mode === 'none' ? raw.mode : null,
      image: typeof raw?.image === 'string' && raw.image.startsWith('data:image/') ? raw.image : null,
      fade: typeof raw?.fade === 'number' && raw.fade >= 0 && raw.fade <= 0.9 ? raw.fade : DEFAULT_FADE,
      blur: typeof raw?.blur === 'number' && raw.blur >= 0 && raw.blur <= HOME_BLUR_MAX ? raw.blur : 0,
      tone: raw?.tone === 'dark' || raw?.tone === 'light' ? raw.tone : 'page'
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
