import { useEffect, useRef, useState, type JSX } from 'react'
import { resolveTranslateTarget } from '../../../../shared/translate'
import { useStore } from '../../state/store'
import { Button, Spinner } from '../../ui'
import { useSessionText } from './text'

type Phase = 'idle' | 'loading' | 'done' | 'failed'

const finished = new Map<string, string>()
const FINISHED_MAX = 200

export interface ThinkingTranslation {
  phase: Phase
  showing: boolean
  translated: string | null
  error: string
  request: () => void
  toggle: () => void
}

export function useThinkingTranslation(text: string): ThinkingTranslation {
  const settingsKey = useStore((s) => JSON.stringify([
    s.settings?.translateService ?? 'bing',
    resolveTranslateTarget(s.settings?.translateTarget, s.settings?.lang ?? 'zh-CN'),
    s.settings?.translateModel ?? ''
  ]))
  const key = JSON.stringify([settingsKey, text])
  const known = finished.get(key) ?? null
  const initial = { key, phase: known === null ? 'idle' as const : 'done' as const, translated: known, showing: false, error: '' }
  const [state, setState] = useState<Omit<ThinkingTranslation, 'request' | 'toggle'> & { key: string }>(initial)
  const current = useRef({ key })
  if (current.current.key !== key) current.current = { key }
  if (state.key !== key) setState(initial)

  useEffect(() => () => {
    current.current = { key: current.current.key }
  }, [])

  const { phase, translated, showing, error } = state.key === key ? state : initial

  const request = (): void => {
    if (phase === 'loading') return
    const known = finished.get(key)
    if (known !== undefined) {
      setState({ key, translated: known, phase: 'done', showing: true, error: '' })
      return
    }
    const asked = current.current
    setState({ ...initial, phase: 'loading' })
    void window.yan.translateText(text).then((result) => {
      if (current.current !== asked) return
      if (result.ok) {
        finished.delete(key)
        finished.set(key, result.text)
        for (const old of [...finished.keys()].slice(0, Math.max(0, finished.size - FINISHED_MAX))) finished.delete(old)
        setState({ key, translated: result.text, phase: 'done', showing: true, error: '' })
      } else {
        setState({ ...initial, error: result.error, phase: 'failed' })
      }
    }).catch((reason: unknown) => {
      if (current.current !== asked) return
      setState({ ...initial, error: reason instanceof Error ? reason.message : String(reason), phase: 'failed' })
    })
  }

  const toggle = (): void => {
    if (phase === 'done') setState((value) => ({ ...value, showing: !value.showing }))
    else request()
  }

  return { phase, showing: showing && translated !== null, translated, error, request, toggle }
}

export function TranslateButton({ state }: { state: ThinkingTranslation }): JSX.Element {
  const tt = useSessionText()
  const label = state.phase === 'loading' ? tt('translating') : state.showing ? tt('translateShowOriginal') : state.phase === 'failed' ? tt('translateRetry') : tt('translate')
  const glyph = state.showing ? tt('translateOriginalGlyph') : tt('translateGlyph')
  return (
    <span className="v3-think-translate" data-phase={state.phase} data-showing={state.showing || undefined}>
      <Button
        variant="ghost"
        size="micro"
        className="v3-think-translate-btn"
        aria-label={label}
        aria-pressed={state.showing}
        isDisabled={state.phase === 'loading'}
        onPress={state.toggle}
        data-testid="v3-thinking-translate"
      >
        {state.phase === 'loading' ? <Spinner label={tt('translating')} /> : glyph}
      </Button>
      {state.phase === 'failed' ? <span className="v3-think-translate-error" role="status" data-testid="v3-thinking-translate-error" title={state.error}>{state.error}</span> : null}
    </span>
  )
}
