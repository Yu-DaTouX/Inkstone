export type UiLang = 'zh-CN' | 'en-US'

let active: UiLang = 'zh-CN'

export function setUiLang(lang: string | undefined): void {
  active = lang === 'en-US' ? 'en-US' : 'zh-CN'
}

export function uiLang(): UiLang {
  return active
}

export function pick(zh: string, en: string): string {
  return active === 'en-US' ? en : zh
}
