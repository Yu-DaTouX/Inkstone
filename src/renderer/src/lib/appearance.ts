/**
 * 字体与字号：写到根元素的令牌上（--font-* / --fs-* / --w-body），模块 CSS 不需要知道用户设置。
 * 缺省值不写，删掉覆盖即回到 tokens.css。
 */
import {
  FONT_BODY_DEFAULT,
  FONT_BODY_MAX,
  FONT_BODY_MIN,
  FONT_UI_DEFAULT,
  FONT_UI_MAX,
  FONT_UI_MIN,
  fontCodeStack,
  fontUiStack,
  sanitizeFontSize
} from '../../../shared/appearance'

export interface TypographySettings {
  fontUi?: string
  fontUiCustom?: string
  fontCode?: string
  fontCodeCustom?: string
  fontSizeBody?: number
  fontSizeUi?: number
}

/** 应用后广播：终端等读计算值的组件据此重新取字体与配色 */
export const APPEARANCE_EVENT = 'yan:appearance'

const FONT_TOKENS = ['--font-sans', '--font-ui', '--font-body', '--font-code'] as const
const SIZE_TOKENS = ['--fs-xs', '--fs-sm', '--fs-code', '--fs-base', '--fs-body', '--fs-lg', '--fs-h3', '--fs-h2', '--fs-stat', '--w-body'] as const

function tokens(s: TypographySettings): Record<string, string> {
  const out: Record<string, string> = {}
  const ui = fontUiStack(s.fontUi, s.fontUiCustom)
  const code = fontCodeStack(s.fontCode, s.fontCodeCustom)
  const defaultUi = fontUiStack(undefined, undefined)
  if (ui !== defaultUi) {
    out['--font-sans'] = ui
    out['--font-ui'] = ui
    out['--font-body'] = ui
  }
  if (code !== defaultUi) out['--font-code'] = code
  const body = sanitizeFontSize(s.fontSizeBody, FONT_BODY_MIN, FONT_BODY_MAX, FONT_BODY_DEFAULT)
  if (body) {
    out['--fs-body'] = `${body}px`
    out['--fs-lg'] = `${body}px`
    out['--fs-h3'] = `${body + 2}px`
    out['--fs-h2'] = `${body + 5}px`
    out['--fs-stat'] = `${body + 7}px`
    /* 正文列 = 48 个正文字宽（15px 时 720，与 tokens.css 一致） */
    out['--w-body'] = `${body * 48}px`
  }
  const uiSize = sanitizeFontSize(s.fontSizeUi, FONT_UI_MIN, FONT_UI_MAX, FONT_UI_DEFAULT)
  if (uiSize) {
    out['--fs-xs'] = `${uiSize - 2}px`
    out['--fs-sm'] = `${uiSize - 1}px`
    out['--fs-code'] = `${uiSize - 0.5}px`
    out['--fs-base'] = `${uiSize}px`
  }
  return out
}

let appliedKey: string | null = null

/** 同值跳过：设置对象任何字段变化都会触发调用 */
export function applyTypography(root: HTMLElement, s: TypographySettings): boolean {
  const next = tokens(s)
  const key = JSON.stringify(next)
  if (key === appliedKey) return false
  appliedKey = key
  for (const token of [...FONT_TOKENS, ...SIZE_TOKENS]) {
    if (next[token]) root.style.setProperty(token, next[token])
    else root.style.removeProperty(token)
  }
  return true
}

/**
 * 本机字体名（Local Font Access）：只在用户点开候选时调用；不支持或被拒绝时返回空表，
 * 调用方照常允许手动输入。结果按家族名去重，缓存一次。
 */
let localFonts: Promise<string[]> | null = null
export function listLocalFonts(): Promise<string[]> {
  if (localFonts) return localFonts
  const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts
  if (typeof query !== 'function') return Promise.resolve([])
  localFonts = query
    .call(window)
    .then((fonts) => [...new Set(fonts.map((f) => f.family).filter(Boolean))].sort((a, b) => a.localeCompare(b)))
    .catch(() => {
      localFonts = null
      return []
    })
  return localFonts
}
