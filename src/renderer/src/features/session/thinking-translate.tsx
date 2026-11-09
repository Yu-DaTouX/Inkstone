import { useEffect, useRef, useState, type JSX } from 'react'
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
  const [phase, setPhase] = useState<Phase>(() => (finished.has(text) ? 'done' : 'idle'))
  const [translated, setTranslated] = useState<string | null>(() => finished.get(text) ?? null)
  const [showing, setShowing] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const current = useRef(text)
  current.current = text

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const known = finished.get(text) ?? null
    setTranslated(known)
    setPhase(known === null ? 'idle' : 'done')
    setShowing(false)
    setError('')
  }, [text])

  const request = (): void => {
    if (phase === 'loading') return
    const known = finished.get(text)
    if (known !== undefined) {
      setTranslated(known)
      setPhase('done')
      setShowing(true)
      return
    }
    const asked = text
    setPhase('loading')
    setError('')
    void window.yan.translateText(asked).then((result) => {
      if (!alive.current || current.current !== asked) return
      if (result.ok) {
        finished.delete(asked)
        finished.set(asked, result.text)
        for (const key of [...finished.keys()].slice(0, Math.max(0, finished.size - FINISHED_MAX))) finished.delete(key)
        setTranslated(result.text)
        setPhase('done')
        setShowing(true)
      } else {
        setError(result.error)
        setPhase('failed')
      }
    }).catch((reason: unknown) => {
      if (!alive.current || current.current !== asked) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('failed')
    })
  }

  const toggle = (): void => {
    if (phase === 'done') setShowing((value) => !value)
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
