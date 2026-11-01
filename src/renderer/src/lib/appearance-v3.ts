import { CONTRAST_DEFAULT, CONTRAST_MAX, FONT_STACKS, resolveUiDensity, sanitizeContrast, sanitizeFontName, sanitizeGlassOpacity, sanitizePanelMotion, sanitizeStreamWidth } from '../../../shared/appearance'
import tokens from '../design/tokens.json'
import { APPEARANCE_EVENT } from './appearance'
import { setAppReducedMotion } from './reduced-motion'

export interface AppearanceV3Settings {
  density?: string
  fontSizeUi?: number
  streamWidth?: number
  fontUi?: string
  fontUiCustom?: string
  fontCode?: string
  fontCodeCustom?: string
  reduceMotion?: boolean
  glassOpacity?: number
  contrast?: number
  panelMotionMs?: number
}

export type CodeFontChoice = 'mono' | 'maple' | 'custom'

const OVERRIDE_VARS = ['--font-ui', '--font-mono', '--size-chat', '--glass-opacity', '--panel-dur', '--line', '--line2', '--fg2', '--fg3'] as const
const LINE_TOKENS = ['line', 'line2'] as const
const TEXT_TOKENS = ['fg2', 'fg3'] as const

let mapleRequested: Promise<unknown> | null = null

function loadMaple(): Promise<unknown> {
  mapleRequested ??= import('@mogeko/maple-mono-cn/dist/font/result.css').catch(() => {
    mapleRequested = null
  })
  return mapleRequested
}

export function codeFontChoice(preset: string | undefined): CodeFontChoice {
  return preset === 'maple' || preset === 'custom' ? preset : 'mono'
}

function uiFontStack(s: AppearanceV3Settings, base: string): string | null {
  if (s.fontUi === 'serif') return FONT_STACKS.serif
  if (s.fontUi === 'maple') return FONT_STACKS.maple
  if (s.fontUi === 'custom') {
    const name = sanitizeFontName(s.fontUiCustom)
    return name ? `"${name}", ${base}` : null
  }
  return null
}

function codeFontStack(s: AppearanceV3Settings, base: string): string | null {
  const choice = codeFontChoice(s.fontCode)
  if (choice === 'maple') return FONT_STACKS.maple
  if (choice === 'custom') {
    const name = sanitizeFontName(s.fontCodeCustom)
    return name ? `"${name}", ${base}` : null
  }
  return null
}

function overrides(s: AppearanceV3Settings, base: CSSStyleDeclaration): Record<string, string> {
  const out: Record<string, string> = {}
  const ui = uiFontStack(s, base.getPropertyValue('--font-ui').trim())
  if (ui) out['--font-ui'] = ui
  const code = codeFontStack(s, base.getPropertyValue('--font-mono').trim())
  if (code) out['--font-mono'] = code
  const width = sanitizeStreamWidth(s.streamWidth)
  if (width !== undefined) out['--size-chat'] = `${width}px`
  const glass = sanitizeGlassOpacity(s.glassOpacity)
  if (glass !== undefined && !reducedTransparency()) out['--glass-opacity'] = `${glass}%`
  const panel = sanitizePanelMotion(s.panelMotionMs)
  if (panel !== undefined) out['--panel-dur'] = `${panel}ms`
  Object.assign(out, contrastOverrides(sanitizeContrast(s.contrast)))
  return out
}

function reducedTransparency(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-transparency: reduce)').matches
}

function themed(name: keyof typeof tokens.color): string {
  const [light, dark] = tokens.color[name] as unknown as [string, string]
  return `light-dark(${light}, ${dark})`
}

function contrastOverrides(contrast: number | undefined): Record<string, string> {
  if (contrast === undefined) return {}
  const shift = (contrast - CONTRAST_DEFAULT) / (CONTRAST_MAX - CONTRAST_DEFAULT)
  const out: Record<string, string> = {}
  for (const name of LINE_TOKENS) {
    out[`--${name}`] = shift > 0
      ? `color-mix(in srgb, ${themed(name)}, var(--fg) ${Math.round(shift * 30)}%)`
      : `color-mix(in srgb, ${themed(name)}, transparent ${Math.round(-shift * 60)}%)`
  }
  for (const name of TEXT_TOKENS) {
    out[`--${name}`] = shift > 0
      ? `color-mix(in srgb, ${themed(name)}, var(--fg) ${Math.round(shift * 45)}%)`
      : `color-mix(in srgb, ${themed(name)}, var(--bg) ${Math.round(-shift * 35)}%)`
  }
  return out
}

let appliedKey: string | null = null

export function applyAppearanceV3(root: HTMLElement, s: AppearanceV3Settings): void {
  const density = resolveUiDensity(s.density, s.fontSizeUi)
  if (root.dataset.density !== density) root.dataset.density = density
  setAppReducedMotion(root, s.reduceMotion === true)
  for (const name of OVERRIDE_VARS) root.style.removeProperty(name)
  const next = overrides(s, getComputedStyle(root))
  for (const [name, value] of Object.entries(next)) root.style.setProperty(name, value)
  if (s.fontUi === 'maple' || codeFontChoice(s.fontCode) === 'maple') void loadMaple()
  const key = JSON.stringify([density, next])
  if (key === appliedKey) return
  appliedKey = key
  window.dispatchEvent(new Event(APPEARANCE_EVENT))
}
