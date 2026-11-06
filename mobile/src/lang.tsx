import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { setUiLang } from '../../src/shared/ui-lang'
import { readUiPrefs, writeUiPrefs } from './device'

export type LangChoice = 'system' | 'zh-CN' | 'en-US'

function systemLang(): 'zh-CN' | 'en-US' {
  try { return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh-CN' : 'en-US' } catch { return 'zh-CN' }
}

function applyChoice(choice: LangChoice): void {
  setUiLang(choice === 'system' ? systemLang() : choice)
}

applyChoice('system')

interface LangState { choice: LangChoice; setChoice(choice: LangChoice): void }

const Ctx = createContext<LangState>({ choice: 'system', setChoice: () => undefined })

export const useLang = () => useContext(Ctx)

export function LangProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<LangChoice>('system')
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void readUiPrefs().then((prefs) => {
      const saved: LangChoice = prefs.lang === 'zh-CN' || prefs.lang === 'en-US' ? prefs.lang : 'system'
      applyChoice(saved)
      setChoiceState(saved)
    }).catch(() => undefined).finally(() => setReady(true))
  }, [])
  const setChoice = useCallback((next: LangChoice) => {
    applyChoice(next)
    setChoiceState(next)
    void writeUiPrefs({ lang: next }).catch(() => undefined)
  }, [])
  const value = useMemo(() => ({ choice, setChoice }), [choice, setChoice])
  if (!ready) return null
  return <Ctx.Provider value={value}><Fragment key={choice}>{children}</Fragment></Ctx.Provider>
}
