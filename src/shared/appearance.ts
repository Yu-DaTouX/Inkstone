/**
 * 外观个性化：字体与字号的取值范围、预设与清洗（主进程落盘与渲染端应用共用）。
 *
 * 字体只收「预设 id」或一个字体名；字体名经过白名单字符清洗后由渲染端加引号、
 * 接在所选系列的回退栈后面，不会把任意 CSS 写进 font-family。
 */

export type FontUiPreset = 'maple' | 'sans' | 'serif' | 'custom'
export type FontCodePreset = 'maple' | 'mono' | 'custom'

export const FONT_UI_PRESETS: readonly FontUiPreset[] = ['maple', 'sans', 'serif', 'custom']
export const FONT_CODE_PRESETS: readonly FontCodePreset[] = ['maple', 'mono', 'custom']

const MAPLE = "'Maple Mono CN', ui-monospace, Consolas, monospace"
/** 各平台系统字体：Windows / macOS / Linux 依次排列，取第一个装了的 */
const SANS = "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', sans-serif"
const SERIF = "'Source Han Serif SC', 'Noto Serif CJK SC', 'Noto Serif SC', 'Songti SC', SimSun, Georgia, 'Times New Roman', serif"
const MONO = "ui-monospace, 'Cascadia Mono', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace"

export const FONT_STACKS = { maple: MAPLE, sans: SANS, serif: SERIF, mono: MONO } as const

/** 正文字号（px）；缺省 15 */
export const FONT_BODY_MIN = 12
export const FONT_BODY_MAX = 22
export const FONT_BODY_DEFAULT = 15
/** 界面字号（px）；缺省 13 */
export const FONT_UI_MIN = 11
export const FONT_UI_MAX = 16
export const FONT_UI_DEFAULT = 13

/** 字体名：字母（含汉字）、数字、空格、点、连字符、下划线，最长 64 */
export function sanitizeFontName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim().replace(/\s+/g, ' ')
  return /^[\p{L}\p{N} ._-]{1,64}$/u.test(name) ? name : undefined
}

export function sanitizeFontUiPreset(value: unknown): Exclude<FontUiPreset, 'maple'> | undefined {
  return value === 'sans' || value === 'serif' || value === 'custom' ? value : undefined
}

export function sanitizeFontCodePreset(value: unknown): Exclude<FontCodePreset, 'maple'> | undefined {
  return value === 'mono' || value === 'custom' ? value : undefined
}

/** 字号：取整并夹进区间；等于缺省值时返回 undefined，磁盘上不留这个键 */
export function sanitizeFontSize(value: unknown, min: number, max: number, fallback: number): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  const v = Math.round(Math.min(max, Math.max(min, n)))
  return v === fallback ? undefined : v
}

/** 界面 / 正文字体栈；自定义字体名不可用时回到缺省 */
export function fontUiStack(preset: string | undefined, custom: string | undefined): string {
  if (preset === 'sans') return SANS
  if (preset === 'serif') return SERIF
  if (preset === 'custom') {
    const name = sanitizeFontName(custom)
    return name ? `"${name}", ${MAPLE}` : MAPLE
  }
  return MAPLE
}

/** 代码与终端字体栈：自定义字体名后接等宽回退 */
export function fontCodeStack(preset: string | undefined, custom: string | undefined): string {
  if (preset === 'mono') return MONO
  if (preset === 'custom') {
    const name = sanitizeFontName(custom)
    return name ? `"${name}", ${MAPLE}` : MAPLE
  }
  return MAPLE
}
