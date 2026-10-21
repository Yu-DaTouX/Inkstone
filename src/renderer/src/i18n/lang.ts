export const LANGS = ['zh-CN', 'en-US'] as const

export type Lang = (typeof LANGS)[number]

const STORAGE_KEY = 'yan.lang'

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value)
}

export function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isLang(v) ? v : null
  } catch {
    return null
  }
}

export function writeStoredLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
  }
}

let activeLang: Lang = readStoredLang() ?? 'zh-CN'

export function currentLang(): Lang {
  return activeLang
}

export function rememberLang(lang: Lang): void {
  activeLang = lang
}
