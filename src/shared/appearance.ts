export type FontUiPreset = 'maple' | 'sans' | 'serif' | 'custom'
export type FontCodePreset = 'maple' | 'mono' | 'custom'

export const FONT_UI_PRESETS: readonly FontUiPreset[] = ['maple', 'sans', 'serif', 'custom']
export const FONT_CODE_PRESETS: readonly FontCodePreset[] = ['maple', 'mono', 'custom']

const MAPLE = "'Maple Mono CN', ui-monospace, Consolas, monospace"
const SANS = "'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Segoe UI', system-ui, sans-serif"
const SERIF = "'Source Han Serif SC', 'Noto Serif CJK SC', 'Noto Serif SC', 'Songti SC', SimSun, Georgia, 'Times New Roman', serif"
const MONO = "ui-monospace, 'Cascadia Mono', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace"

export const FONT_STACKS = { maple: MAPLE, sans: SANS, serif: SERIF, mono: MONO } as const

export const FONT_UI_MIN = 11
export const FONT_UI_MAX = 16
export const FONT_UI_DEFAULT = 13

export const STREAM_WIDTH_MIN = 480
export const STREAM_WIDTH_MAX = 1440

export function sanitizeStreamWidth(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(Math.min(STREAM_WIDTH_MAX, Math.max(STREAM_WIDTH_MIN, value)))
}

export function sanitizeFontName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim().replace(/\s+/g, ' ')
  return /^[\p{L}\p{N} ._-]{1,64}$/u.test(name) ? name : undefined
}

export function sanitizeFontUiPreset(value: unknown): Exclude<FontUiPreset, 'sans'> | undefined {
  return value === 'maple' || value === 'serif' || value === 'custom' ? value : undefined
}

export function sanitizeFontCodePreset(value: unknown): Exclude<FontCodePreset, 'mono'> | undefined {
  return value === 'maple' || value === 'custom' ? value : undefined
}

export function sanitizeFontSize(value: unknown, min: number, max: number, fallback: number): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  const v = Math.round(Math.min(max, Math.max(min, n)))
  return v === fallback ? undefined : v
}

export type UiDensity = 'compact' | 'comfortable'

export const UI_DENSITIES: readonly UiDensity[] = ['compact', 'comfortable']

const LEGACY_COMFORTABLE_FONT_SIZE = 14

export function resolveUiDensity(density: unknown, legacyFontSize?: unknown): UiDensity {
  if (density === 'comfortable') return 'comfortable'
  const size = typeof legacyFontSize === 'number' ? legacyFontSize : Number(legacyFontSize)
  return Number.isFinite(size) && size >= LEGACY_COMFORTABLE_FONT_SIZE ? 'comfortable' : 'compact'
}
