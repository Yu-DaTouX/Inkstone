const SYSTEM_QUERY = '(prefers-reduced-motion: reduce)'
export const REDUCED_MOTION_EVENT = 'yan:reduced-motion'

let systemMedia: MediaQueryList | null = null

function system(): MediaQueryList | null {
  if (systemMedia) return systemMedia
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  systemMedia = window.matchMedia(SYSTEM_QUERY)
  return systemMedia
}

export function appReducedMotion(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.reduceMotion === 'true'
}

export function prefersReducedMotion(): boolean {
  return appReducedMotion() || !!system()?.matches
}

export function setAppReducedMotion(root: HTMLElement, on: boolean): void {
  const current = root.dataset.reduceMotion === 'true'
  if (current === on) return
  if (on) root.dataset.reduceMotion = 'true'
  else delete root.dataset.reduceMotion
  window.dispatchEvent(new Event(REDUCED_MOTION_EVENT))
}

export function subscribeReducedMotion(listener: () => void): () => void {
  const media = system()
  media?.addEventListener('change', listener)
  window.addEventListener(REDUCED_MOTION_EVENT, listener)
  return () => {
    media?.removeEventListener('change', listener)
    window.removeEventListener(REDUCED_MOTION_EVENT, listener)
  }
}
