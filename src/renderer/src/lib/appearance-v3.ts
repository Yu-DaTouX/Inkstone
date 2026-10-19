import { FONT_STACKS, resolveUiDensity, sanitizeFontName } from '../../../shared/appearance'
import { APPEARANCE_EVENT } from './appearance'
import { setAppReducedMotion } from './reduced-motion'

export interface AppearanceV3Settings {
  density?: string
  fontSizeUi?: number
  fontUi?: string
  fontUiCustom?: string
  fontCode?: string
  fontCodeCustom?: string
  reduceMotion?: boolean
}

export type CodeFontChoice = 'mono' | 'maple' | 'custom'

const FONT_VARS = ['--font-ui', '--font-mono'] as const

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
  return out
}

let appliedKey: string | null = null

export function applyAppearanceV3(root: HTMLElement, s: AppearanceV3Settings): void {
  const density = resolveUiDensity(s.density, s.fontSizeUi)
  if (root.dataset.density !== density) root.dataset.density = density
  setAppReducedMotion(root, s.reduceMotion === true)
  for (const name of FONT_VARS) root.style.removeProperty(name)
  const next = overrides(s, getComputedStyle(root))
  for (const [name, value] of Object.entries(next)) root.style.setProperty(name, value)
  if (s.fontUi === 'maple' || codeFontChoice(s.fontCode) === 'maple') void loadMaple()
  const key = JSON.stringify([density, next])
  if (key === appliedKey) return
  appliedKey = key
  window.dispatchEvent(new Event(APPEARANCE_EVENT))
}
