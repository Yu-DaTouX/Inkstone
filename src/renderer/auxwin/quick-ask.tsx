import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import './apply-theme'
import '../src/design/index.css'
import { Button, ListBoxItem, Select, TextArea } from '../src/ui'
import {
  auxBridge,
  type AuxPush,
  type AuxTarget,
  type QuickAskResult,
  type QuickAskStateView,
  type QuickAskSubmit
} from './aux-bridge'
import { auxDict, errorWord } from './aux-i18n'
import './auxwin.css'

function QuickAskApp(): ReactElement {
  const bridge = auxBridge()
  const [view, setView] = useState<QuickAskStateView | null>(null)
  const [prompt, setPrompt] = useState('')
  const [target, setTarget] = useState<AuxTarget>('new')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [modelKey, setModelKey] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<QuickAskResult | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const focusInput = useCallback(() => {
    wrapRef.current?.querySelector('textarea')?.focus()
  }, [])

  useEffect(() => {
    if (!bridge) return
    const loadState = (): void => {
      void bridge.quickAsk.state().then((next) => {
        setView(next)
        setTarget((cur) => (cur === 'current' && !next.currentSession ? next.defaultTarget : cur))
        setProjectId(next.defaultProjectId)
        setModelKey(next.defaultModelId)
      })
    }
    loadState()
    const off = bridge.onPush((msg: AuxPush) => {
      if (msg.ch !== 'quick-ask') return
      if (msg.payload.kind === 'show') {
        setSubmitting(false)
        setError(null)
        loadState()
        requestAnimationFrame(focusInput)
      } else if (msg.payload.kind === 'submitting') {
        setSubmitting(true)
      } else if (msg.payload.kind === 'result') {
        setSubmitting(false)
        if (!msg.payload.result.ok) setError(msg.payload.result)
      }
    })
    requestAnimationFrame(focusInput)
    return off
  }, [bridge, focusInput])

  const locale = view?.locale ?? 'zh-CN'
  const dict = useMemo(() => auxDict(locale), [locale])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') bridge?.quickAsk.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bridge])

  const projectOptions = useMemo(
    () => [{ id: '', name: dict.useDefault, path: '' }, ...(view?.projects ?? [])],
    [dict.useDefault, view?.projects]
  )
  const modelOptions = useMemo(
    () => [{ key: '', id: '', label: dict.useDefault, provider: '' }, ...(view?.models ?? [])],
    [dict.useDefault, view?.models]
  )

  const submit = useCallback(
    async (expand: boolean) => {
      if (!bridge || submitting) return
      const text = prompt.trim()
      if (!text) {
        setError({ ok: false, code: 'empty' })
        return
      }
      setSubmitting(true)
      setError(null)
      const payload: QuickAskSubmit = {
        prompt: text,
        target,
        projectId: target === 'new' ? projectId : null,
        model: selectedModel ? { provider: selectedModel.provider, id: selectedModel.id } : null,
        expand
      }
      const result = await bridge.quickAsk.submit(payload)
      if (!result.ok) {
        setSubmitting(false)
        setError(result)
      }
    },
    [bridge, modelKey, projectId, prompt, submitting, target, view?.models]
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        bridge?.quickAsk.close()
        return
      }
      if (event.key !== 'Enter') return
      if (event.nativeEvent.isComposing) return
      if (event.shiftKey) return
      event.preventDefault()
      void submit(event.ctrlKey || event.metaKey)
    },
    [bridge, submit]
  )

  const currentLabel = view?.currentSession?.title ?? view?.currentSession?.sessionId ?? dict.noCurrent
  const selectedModel = view?.models.find((model) => model.key === modelKey) ?? null

  return (
    <div className="aux aux--quick" ref={wrapRef} onKeyDown={onKeyDown}>
      <div className="aux-ask__head">
        <span className="aux-ask__title">{dict.quickAskTitle}</span>
        <div className="aux-ask__targets" role="group" aria-label={dict.quickAskTitle}>
          <Button
            size="sm"
            variant={target === 'new' ? 'primary' : 'secondary'}
            onPress={() => setTarget('new')}
          >
            {dict.targetNew}
          </Button>
          <Button
            size="sm"
            variant={target === 'current' ? 'primary' : 'secondary'}
            isDisabled={!view?.currentSession}
            onPress={() => setTarget('current')}
          >
            {dict.targetCurrent}
          </Button>
        </div>
      </div>

      <TextArea
        aria-label={dict.quickAskTitle}
        className="aux-ask__field"
        textAreaClassName="aux-ask__input"
        placeholder={dict.placeholder}
        rows={2}
        value={prompt}
        onChange={setPrompt}
      />

      <div className="aux-ask__foot">
        <div className="aux-ask__pickers">
          {target === 'current' ? (
            <span className="aux-ask__current" title={currentLabel}>
              {currentLabel}
            </span>
          ) : (
            <Select
              aria-label={dict.project}
              className="aux-ask__pick"
              selectedKey={projectId ?? ''}
              onSelectionChange={(key) => setProjectId(!key || key === '' ? null : String(key))}
            >
              {projectOptions.map((item) => (
                <ListBoxItem key={item.id} id={item.id}>
                  {item.name}
                </ListBoxItem>
              ))}
            </Select>
          )}
          <Select
            aria-label={dict.model}
            className="aux-ask__pick"
            selectedKey={modelKey ?? ''}
            onSelectionChange={(key) => setModelKey(!key || key === '' ? null : String(key))}
          >
            {modelOptions.map((item) => (
              <ListBoxItem key={item.key} id={item.key} textValue={item.label}>
                {item.label}
              </ListBoxItem>
            ))}
          </Select>
        </div>
        <div className="aux-ask__actions">
          <Button variant="secondary" size="sm" isDisabled={submitting} onPress={() => void submit(true)}>
            {dict.expand}
          </Button>
          <Button variant="primary" size="sm" isPending={submitting} onPress={() => void submit(false)}>
            {dict.send}
          </Button>
        </div>
      </div>

      <div className="aux-ask__status" role="status" aria-live="polite">
        {error ? <span className="aux-ask__error">{errorWord(locale, error.code)}</span> : <span className="aux-ask__hint">{dict.hint}</span>}
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QuickAskApp />
    </StrictMode>
  )
}
