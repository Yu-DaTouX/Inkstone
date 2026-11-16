import { APPEARANCE_EVENT } from './appearance'

const CACHE_MAX = 64
const SENTINEL = '#010203'
const cache = new Map<string, string>()
let probeNode: HTMLElement | null = null
let testContext: CanvasRenderingContext2D | null | undefined

function colorProbe(): HTMLElement | null {
  if (probeNode?.isConnected) return probeNode
  if (typeof document === 'undefined' || !document.body) return null
  const host = document.createElement('div')
  host.hidden = true
  host.setAttribute('aria-hidden', 'true')
  document.body.appendChild(host)
  const probe = document.createElement('span')
  host.attachShadow({ mode: 'closed' }).appendChild(probe)
  probeNode = probe
  return probe
}

function canvasAccepts(color: string): string | null {
  if (testContext === undefined) testContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!testContext || !color) return null
  testContext.fillStyle = SENTINEL
  testContext.fillStyle = color
  const applied = String(testContext.fillStyle)
  return applied === SENTINEL ? null : applied
}

export function canvasDark(): boolean {
  const theme = document.documentElement.getAttribute('data-theme')
  if (theme) return theme === 'dark'
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function canvasColor(token: string, fallback: string, scope?: Element | null): string {
  if (typeof document === 'undefined') return fallback
  const host = scope?.isConnected ? scope : document.documentElement
  const raw = getComputedStyle(host).getPropertyValue(token).trim()
  const key = `${canvasDark() ? 'd' : 'l'}|${raw || token}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const probe = colorProbe()
  let resolved = ''
  if (probe && raw) {
    probe.style.color = ''
    probe.style.color = raw
    resolved = probe.style.color ? getComputedStyle(probe).color : ''
  }
  const value = canvasAccepts(resolved) ?? canvasAccepts(fallback) ?? fallback
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, value)
  return value
}

export function subscribeCanvasTheme(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  media?.addEventListener('change', listener)
  window.addEventListener(APPEARANCE_EVENT, listener)
  return () => {
    observer.disconnect()
    media?.removeEventListener('change', listener)
    window.removeEventListener(APPEARANCE_EVENT, listener)
  }
}

export function subscribePixelRatio(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  let media: MediaQueryList | null = null
  const watch = (): void => {
    media?.removeEventListener('change', onChange)
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    media.addEventListener('change', onChange)
  }
  function onChange(): void {
    watch()
    listener()
  }
  watch()
  return () => media?.removeEventListener('change', onChange)
}
