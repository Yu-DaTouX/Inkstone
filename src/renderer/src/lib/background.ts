/**
 * 界面背景色：模板与自定义。
 *
 * 背景是一组层级令牌（--bg-0 页面底 … --bg-4 最高一层）。模板与自定义色都只给出
 * 「页面底色」，其余层级按明度台阶推出，保证层次关系与默认主题一致。
 * 自定义色会按主题夹在可读范围内：深色主题不会选出浅底、浅色主题不会选出深底，
 * 避免文字对比度失效。
 */

export type BackgroundTheme = 'dark' | 'light'

export interface BackgroundPreset {
  id: string
  /** i18n 键 */
  key: string
  dark?: string
  light?: string
}

/** 缺省（id = default）不写任何覆盖，沿用 tokens.css */
export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { id: 'default', key: 'set.bg.default' },
  { id: 'graphite', key: 'set.bg.graphite', dark: '#141414', light: '#f4f4f4' },
  { id: 'midnight', key: 'set.bg.midnight', dark: '#0f1623', light: '#eef2f8' },
  { id: 'forest', key: 'set.bg.forest', dark: '#101a16', light: '#eef5f1' },
  { id: 'plum', key: 'set.bg.plum', dark: '#1a1422', light: '#f6f0f8' },
  { id: 'warm', key: 'set.bg.warm', dark: '#1c1814', light: '#f7f3ea' },
  { id: 'black', key: 'set.bg.black', dark: '#000000', light: '#ffffff' }
]

export const CUSTOM_BACKGROUND_ID = 'custom'

const TOKENS = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-4', '--split-dim', '--on-accent'] as const

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [(h * 60 + 360) % 360, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  const to = (v: number): string => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** 自定义色夹进主题的可读范围 */
export function clampBackground(hex: string, theme: BackgroundTheme): string {
  const [h, s, l] = hexToHsl(hex)
  const clamped = theme === 'dark' ? Math.min(l, 0.26) : Math.max(l, 0.9)
  return hslToHex(h, Math.min(s, 0.6), clamped)
}

/** 由页面底色推出整组层级令牌 */
export function backgroundLadder(base: string, theme: BackgroundTheme): Record<(typeof TOKENS)[number], string> {
  const [h, s, l] = hexToHsl(base)
  const at = (delta: number): string => hslToHex(h, s, Math.min(1, Math.max(0, l + delta)))
  if (theme === 'dark') {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(base.slice(i, i + 2), 16))
    return {
      '--bg-0': base,
      '--bg-1': at(0.035),
      '--bg-2': at(0.08),
      '--bg-3': at(0.11),
      '--bg-4': at(0.17),
      '--split-dim': `rgba(${r}, ${g}, ${b}, 0.38)`,
      '--on-accent': base
    }
  }
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(base.slice(i, i + 2), 16))
  return {
    '--bg-0': base,
    '--bg-1': at(-0.025),
    '--bg-2': at(0.05),
    '--bg-3': at(-0.06),
    '--bg-4': at(-0.1),
    '--split-dim': `rgba(${r}, ${g}, ${b}, 0.5)`,
    '--on-accent': '#ffffff'
  }
}

/** 当前设置对应的页面底色；null = 用默认主题 */
export function resolveBackground(preset: string | undefined, custom: string | undefined, theme: BackgroundTheme): string | null {
  if (preset === CUSTOM_BACKGROUND_ID) return isHexColor(custom) ? clampBackground(custom, theme) : null
  const hit = BACKGROUND_PRESETS.find((p) => p.id === preset)
  return hit?.[theme] ?? null
}

export function applyBackground(root: HTMLElement, preset: string | undefined, custom: string | undefined, theme: BackgroundTheme): void {
  const base = resolveBackground(preset, custom, theme)
  if (!base) {
    for (const token of TOKENS) root.style.removeProperty(token)
    return
  }
  const ladder = backgroundLadder(base, theme)
  for (const token of TOKENS) root.style.setProperty(token, ladder[token])
}
