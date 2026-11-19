export const BROWSER_VIEWPORT_PRESETS = {
  mobile: { width: 375, height: 812, group: 'mobile' },
  'mobile-wide': { width: 430, height: 932, group: 'mobile' },
  tablet: { width: 768, height: 1024, group: 'tablet' },
  'tablet-landscape': { width: 1024, height: 768, group: 'tablet' },
  desktop: { width: 1280, height: 800, group: 'desktop' },
  'desktop-wide': { width: 1440, height: 900, group: 'desktop' }
} as const

type Preset = keyof typeof BROWSER_VIEWPORT_PRESETS
export type BrowserViewport = 'responsive' | Preset

export function isBrowserViewport(value: unknown): value is BrowserViewport {
  return typeof value === 'string' && (value === 'responsive' || Object.hasOwn(BROWSER_VIEWPORT_PRESETS, value))
}

export function browserViewportPreset(viewport: BrowserViewport) {
  return viewport === 'responsive' ? null : BROWSER_VIEWPORT_PRESETS[viewport]
}

export function viewportRect(pane: { x: number; y: number; width: number; height: number }, viewport: BrowserViewport) {
  const preset = browserViewportPreset(viewport)
  if (!preset) return { ...pane, scale: 1, emulated: null }
  const scale = Math.min(1, pane.width / preset.width, pane.height / preset.height)
  const width = Math.max(1, Math.min(pane.width, Math.round(preset.width * scale)))
  const height = Math.max(1, Math.min(pane.height, Math.round(preset.height * scale)))
  return {
    x: pane.x + Math.round((pane.width - width) / 2),
    y: pane.y + Math.round((pane.height - height) / 2),
    width, height, scale,
    emulated: { width: preset.width, height: preset.height }
  }
}
