import { FONT_STACKS, FONT_UI_DEFAULT, FONT_UI_MAX, FONT_UI_MIN, sanitizeFontName, sanitizeFontSize } from '../../../shared/appearance'
import { APPEARANCE_EVENT } from './appearance'

export interface AppearanceV3Settings {
  density?: string
  fontSizeUi?: number
  fontUi?: string
  fontUiCustom?: string
  fontCode?: string
  fontCodeCustom?: string
}

export type CodeFontChoice = 'mono' | 'maple' | 'custom'

const SCALED_SIZES = [
  ['--t-meta', '--t-meta-lh'],
  ['--t-ui', '--t-ui-lh'],
  ['--t-body', '--t-body-lh'],
  ['--t-title', '--t-title-lh'],
  ['--t-prose', '--t-prose-lh'],
  ['--d-prose', '--d-prose-lh']
] as const

const FONT_VARS = ['--font-ui', '--font-mono'] as const
const OVERRIDDEN = [...SCALED_SIZES.flat(), ...FONT_VARS]
const DENSITIES = new Set(['compact', 'standard', 'comfortable'])

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

function px(value: string): number | null {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : null
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
  const size = sanitizeFontSize(s.fontSizeUi, FONT_UI_MIN, FONT_UI_MAX, FONT_UI_DEFAULT)
  const delta = size === undefined ? 0 : size - FONT_UI_DEFAULT
  if (delta !== 0) {
    for (const [sizeVar, lineVar] of SCALED_SIZES) {
      const fontSize = px(base.getPropertyValue(sizeVar))
      const lineHeight = px(base.getPropertyValue(lineVar))
      if (fontSize !== null) out[sizeVar] = `${fontSize + delta}px`
      if (lineHeight !== null) out[lineVar] = `${Math.round(lineHeight + delta * 1.5)}px`
    }
  }
  const ui = uiFontStack(s, base.getPropertyValue('--font-ui').trim())
  if (ui) out['--font-ui'] = ui
  const code = codeFontStack(s, base.getPropertyValue('--font-mono').trim())
  if (code) out['--font-mono'] = code
  return out
}

let appliedKey: string | null = null

export function applyAppearanceV3(root: HTMLElement, s: AppearanceV3Settings): void {
  const density = s.density && DENSITIES.has(s.density) ? s.density : 'standard'
  if (root.dataset.density !== density) root.dataset.density = density
  for (const name of OVERRIDDEN) root.style.removeProperty(name)
  const next = overrides(s, getComputedStyle(root))
  for (const [name, value] of Object.entries(next)) root.style.setProperty(name, value)
  if (s.fontUi === 'maple' || codeFontChoice(s.fontCode) === 'maple') void loadMaple()
  const key = JSON.stringify([density, next])
  if (key === appliedKey) return
  appliedKey = key
  window.dispatchEvent(new Event(APPEARANCE_EVENT))
}
