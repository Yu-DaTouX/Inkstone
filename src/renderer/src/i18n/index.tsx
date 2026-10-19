import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import zhCN from './zh-CN.json'
import enUS from './en-US.json'

export const LANGS = ['zh-CN', 'en-US'] as const
export type Lang = (typeof LANGS)[number]

export type MessageKey = keyof typeof zhCN

const catalogs: Record<Lang, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS satisfies Record<MessageKey, string>
}

export type TVars = Record<string, string | number>
export type TFunc = (key: MessageKey, vars?: TVars) => string

export function translate(lang: Lang, key: MessageKey, vars?: TVars): string {
  const raw = catalogs[lang]?.[key] ?? catalogs['en-US']?.[key]
  let s: string = raw
  if (s === undefined) {
    console.warn('[i18n] missing key:', key)
    return key
  }
  if (vars) {
    for (const [n, v] of Object.entries(vars)) s = s.split(`{${n}}`).join(String(v))
  }
  return s
}

interface I18nValue {
  lang: Lang
  setLang: (l: Lang) => void
  toggleLang: () => void
  t: TFunc
}

const I18nContext = createContext<I18nValue | null>(null)

const STORAGE_KEY = 'yan.lang'

function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v && (LANGS as readonly string[]).includes(v) ? (v as Lang) : null
  } catch {
    return null
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang() ?? 'zh-CN')

  useEffect(() => {
    document.documentElement.lang = lang
    try {
      localStorage.setItem(STORAGE_KEY, lang)
    } catch {
    }
  }, [lang])

  const t = useCallback<TFunc>((key, vars) => translate(lang, key, vars), [lang])
  const setLang = useCallback((l: Lang) => setLangState(l), [])
  const toggleLang = useCallback(
    () => setLangState((cur) => (cur === 'zh-CN' ? 'en-US' : 'zh-CN')),
    []
  )

  const value = useMemo<I18nValue>(
    () => ({ lang, setLang, toggleLang, t }),
    [lang, setLang, toggleLang, t]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n 必须在 <I18nProvider> 内使用')
  return ctx
}

export function useT(): TFunc {
  return useI18n().t
}

const fallbackT: TFunc = (key, vars) => translate('zh-CN', key, vars)

export function useOptionalT(): TFunc {
  return useContext(I18nContext)?.t ?? fallbackT
}
