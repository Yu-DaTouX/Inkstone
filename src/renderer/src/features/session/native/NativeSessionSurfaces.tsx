import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { AlertCircle, ArrowLeft, RotateCw } from 'lucide-react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import { viewIdentityOf } from '../../../state/view-identity'
import { Badge, Button, Checkbox, CheckboxGroup, Dialog, Modal, ModalOverlay, Spinner } from '../../../ui'
import type { NativeSessionHostRequest } from '../../../../../shared/native-session-host'
import {
  isNativeSurfaceMode,
  isScopeDirty,
  loadEntries,
  loadScopedModels,
  loadTrust,
  nativeSurfaceText,
  saveScopedModels,
  saveTrust,
  scopeSaveIds,
  type EntriesView,
  type NativeSurfaceMode,
  type NativeSurfaceText,
  type NativeSurfaceTransport,
  type ScopedModelOption,
  type ScopedModelsView,
  type TrustView
} from './native-surfaces-model'
import './native-surfaces.css'

function surfaceStatus({
  text,
  error,
  onRetry,
  testId
}: {
  text: NativeSurfaceText
  error?: string
  onRetry?: () => void
  testId: string
}): JSX.Element {
  if (error !== undefined) {
    return (
      <div className="native-surface__status" data-testid={testId}>
        <AlertCircle size={16} aria-hidden="true" className="native-surface__status-icon" />
        <p className="native-surface__status-title">{text.loadFailed}</p>
        {error ? <p className="native-surface__status-detail">{error}</p> : null}
        {onRetry ? (
          <Button size="sm" onPress={onRetry} data-testid={`${testId}-retry`}>
            {text.retry}
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="native-surface__status" data-testid={testId}>
      <Spinner label={text.loading} />
      <span>{text.loading}</span>
    </div>
  )
}

export interface ScopeModelsViewProps {
  text: NativeSurfaceText
  models: ScopedModelOption[]
  scopeIsAll: boolean
  selected: ReadonlySet<string>
  dirty: boolean
  busy: boolean
  error: string
  notice: string
  onChange: (keys: string[]) => void
  onSelectAll: () => void
  onClear: () => void
  onSave: () => void
  onShowEntries?: () => void
}

export function ScopeModelsView({
  text,
  models,
  scopeIsAll,
  selected,
  dirty,
  busy,
  error,
  notice,
  onChange,
  onSelectAll,
  onClear,
  onSave,
  onShowEntries
}: ScopeModelsViewProps): JSX.Element {
  const t = text.scope
  return (
    <div className="native-surface" data-testid="native-scope-view">
      <p className="native-surface__lead">{t.lead}</p>
      <div className="native-surface__meta" data-testid="native-scope-count">
        {t.count(selected.size)}
      </div>
      {scopeIsAll ? (
        <p className="native-surface__note" data-testid="native-scope-all">
          {t.all}
        </p>
      ) : null}
      {models.length ? (
        <CheckboxGroup aria-label={t.label} value={[...selected]} onChange={onChange} className="native-scope__group">
          <div className="native-scope__list" data-testid="native-scope-list">
            {models.map((model) => (
              <div
                className="native-scope__row"
                key={model.key}
                data-testid={`native-scope-row-${model.key}`}
                data-in-scope={model.inScope ? '1' : undefined}
              >
                <Checkbox value={model.key}>
                  <span className="native-scope__name">{model.name}</span>
                  <span className="native-scope__provider">{model.provider}</span>
                  {model.current ? <Badge tone="run">{t.current}</Badge> : null}
                </Checkbox>
              </div>
            ))}
          </div>
        </CheckboxGroup>
      ) : (
        <div className="native-surface__empty" data-testid="native-scope-empty">
          {t.empty}
        </div>
      )}
      <div className="native-surface__foot">
        <Button size="sm" variant="ghost" onPress={onSelectAll} data-testid="native-scope-select-all">
          {t.selectAll}
        </Button>
        <Button size="sm" variant="ghost" onPress={onClear} data-testid="native-scope-clear">
          {t.clear}
        </Button>
        <span className="native-surface__spacer" />
        {error ? (
          <span className="native-surface__note native-surface__note--err" data-testid="native-scope-error" role="status">
            {error}
          </span>
        ) : notice ? (
          <span className="native-surface__note native-surface__note--ok" data-testid="native-scope-notice" role="status">
            {notice}
          </span>
        ) : null}
        <Button size="sm" variant="primary" isDisabled={busy || !dirty} onPress={onSave} data-testid="native-scope-save">
          {busy ? t.saving : t.save}
        </Button>
        {onShowEntries ? (
          <Button size="sm" variant="ghost" onPress={onShowEntries} data-testid="native-scope-entries">
            {text.viewEntries}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

type LoadState<T> = { phase: 'loading' } | { phase: 'error'; error: string } | ({ phase: 'ready' } & T)

export interface ScopeModelsSurfaceProps {
  transport: NativeSurfaceTransport
  sessionId: string
  text: NativeSurfaceText
  currentModel?: { provider: string; id: string } | null
  onSaved?: () => void
  onShowEntries?: () => void
}

export function ScopeModelsSurface({
  transport,
  sessionId,
  text,
  currentModel,
  onSaved,
  onShowEntries
}: ScopeModelsSurfaceProps): JSX.Element {
  const [state, setState] = useState<LoadState<{ view: ScopedModelsView }>>({ phase: 'loading' })
  const [baseline, setBaseline] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [draft, setDraft] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const runRef = useRef(0)
  const aliveRef = useRef(true)
  const currentProvider = currentModel?.provider
  const currentId = currentModel?.id

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      runRef.current += 1
    }
  }, [])

  useEffect(() => {
    const run = ++runRef.current
    setState({ phase: 'loading' })
    setError('')
    setNotice('')
    setBusy(false)
    if (!sessionId) {
      setState({ phase: 'error', error: text.loadFailed })
      return
    }
    const current = currentProvider && currentId ? { provider: currentProvider, id: currentId } : null
    void loadScopedModels(transport, sessionId, text.loadFailed, current).then((result) => {
      if (!aliveRef.current || run !== runRef.current) return
      if (!result.ok) {
        setState({ phase: 'error', error: result.error })
        return
      }
      const keys = new Set(result.view.models.filter((model) => model.inScope).map((model) => model.key))
      setState({ phase: 'ready', view: result.view })
      setBaseline(keys)
      setDraft(new Set(keys))
    })
  }, [transport, sessionId, reloadToken, text.loadFailed, currentProvider, currentId])

  const retry = useCallback((): void => {
    setReloadToken((value) => value + 1)
  }, [])

  const save = useCallback(async (): Promise<void> => {
    if (state.phase !== 'ready' || busy || !isScopeDirty(draft, baseline)) return
    const models = state.view.models
    const modelIds = scopeSaveIds(draft, models)
    const run = runRef.current
    setBusy(true)
    setError('')
    setNotice('')
    const result = await saveScopedModels(transport, sessionId, modelIds, text.actionFailed)
    if (!aliveRef.current || run !== runRef.current) return
    setBusy(false)
    if (!result.ok) {
      if (!result.cancelled) setError(result.error)
      return
    }
    const applied = models.map((model) => ({ ...model, inScope: draft.has(model.key) }))
    setState({ phase: 'ready', view: { models: applied, scopeIsAll: scopeSaveIds(draft, models).length === 0 } })
    setBaseline(new Set(draft))
    setNotice(result.requiresReload ? text.requiresReload : text.scope.saved)
    onSaved?.()
  }, [state, busy, draft, baseline, transport, sessionId, text.actionFailed, text.requiresReload, text.scope.saved, onSaved])

  if (state.phase !== 'ready') {
    return surfaceStatus({
      text,
      error: state.phase === 'error' ? state.error : undefined,
      onRetry: state.phase === 'error' ? retry : undefined,
      testId: state.phase === 'error' ? 'native-surface-error' : 'native-surface-loading'
    })
  }

  return (
    <ScopeModelsView
      text={text}
      models={state.view.models}
      scopeIsAll={state.view.scopeIsAll}
      selected={draft}
      dirty={isScopeDirty(draft, baseline)}
      busy={busy}
      error={error}
      notice={notice}
      onChange={(keys) => {
        setDraft(new Set(keys))
        setNotice('')
      }}
      onSelectAll={() => {
        setDraft(new Set(state.view.models.map((model) => model.key)))
        setNotice('')
      }}
      onClear={() => {
        setDraft(new Set())
        setNotice('')
      }}
      onSave={() => void save()}
      onShowEntries={onShowEntries}
    />
  )
}

export interface TrustPanelProps {
  text: NativeSurfaceText
  view: TrustView
  busy: boolean
  error: string
  notice: string
  onToggle: () => void
  onShowEntries?: () => void
}

export function TrustPanel({ text, view, busy, error, notice, onToggle, onShowEntries }: TrustPanelProps): JSX.Element {
  const t = text.trust
  return (
    <div className="native-surface" data-testid="native-trust-view">
      <p className="native-surface__lead">{t.lead}</p>
      <dl className="native-trust__fields">
        <div className="native-trust__field">
          <dt className="native-trust__name">{t.cwd}</dt>
          <dd className="native-trust__value">
            <code className="native-trust__path" title={view.cwd}>
              {view.cwd || '—'}
            </code>
          </dd>
        </div>
        <div className="native-trust__field">
          <dt className="native-trust__name">{t.state}</dt>
          <dd className="native-trust__value">
            <span data-testid="native-trust-state">
              <Badge tone={view.trusted ? 'run' : 'stall'}>{view.trusted ? t.trusted : t.untrusted}</Badge>
            </span>
          </dd>
        </div>
        {view.entry ? (
          <div className="native-trust__field">
            <dt className="native-trust__name">{t.entry}</dt>
            <dd className="native-trust__value">
              <code className="native-trust__path" title={view.entry}>
                {view.entry}
              </code>
            </dd>
          </div>
        ) : null}
      </dl>
      {!view.requiresTrust ? (
        <p className="native-surface__note" data-testid="native-trust-notrequired">
          {t.notRequired}
        </p>
      ) : null}
      <p className="native-surface__risk" data-testid="native-trust-risk">
        {t.risk}
      </p>
      <div className="native-surface__foot">
        <span className="native-surface__spacer" />
        {error ? (
          <span className="native-surface__note native-surface__note--err" data-testid="native-trust-error" role="status">
            {error}
          </span>
        ) : notice ? (
          <span className="native-surface__note native-surface__note--ok" data-testid="native-trust-notice" role="status">
            {notice}
          </span>
        ) : null}
        <Button
          size="sm"
          variant={view.trusted ? 'danger' : 'primary'}
          isDisabled={busy}
          onPress={onToggle}
          data-testid="native-trust-save"
        >
          {view.trusted ? t.revoke : t.save}
        </Button>
        {onShowEntries ? (
          <Button size="sm" variant="ghost" onPress={onShowEntries} data-testid="native-trust-entries">
            {text.viewEntries}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export interface TrustSurfaceProps {
  transport: NativeSurfaceTransport
  sessionId: string
  text: NativeSurfaceText
  onSaved?: () => void
  onShowEntries?: () => void
}

export function TrustSurface({ transport, sessionId, text, onSaved, onShowEntries }: TrustSurfaceProps): JSX.Element {
  const [state, setState] = useState<LoadState<{ view: TrustView }>>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const runRef = useRef(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      runRef.current += 1
    }
  }, [])

  useEffect(() => {
    const run = ++runRef.current
    setState({ phase: 'loading' })
    setError('')
    setNotice('')
    setBusy(false)
    if (!sessionId) {
      setState({ phase: 'error', error: text.loadFailed })
      return
    }
    void loadTrust(transport, sessionId, text.loadFailed).then((result) => {
      if (!aliveRef.current || run !== runRef.current) return
      if (!result.ok) {
        setState({ phase: 'error', error: result.error })
        return
      }
      setState({ phase: 'ready', view: result.view })
    })
  }, [transport, sessionId, reloadToken, text.loadFailed])

  const retry = useCallback((): void => {
    setReloadToken((value) => value + 1)
  }, [])

  const toggle = useCallback(async (): Promise<void> => {
    if (state.phase !== 'ready' || busy) return
    const next = !state.view.trusted
    const run = runRef.current
    setBusy(true)
    setError('')
    setNotice('')
    const result = await saveTrust(transport, sessionId, next, text.actionFailed)
    if (!aliveRef.current || run !== runRef.current) return
    setBusy(false)
    if (!result.ok) {
      if (!result.cancelled) setError(result.error)
      return
    }
    setState({ phase: 'ready', view: { ...state.view, trusted: next } })
    setNotice(result.requiresReload ? text.requiresReload : next ? text.trust.saved : text.trust.revoked)
    onSaved?.()
  }, [state, busy, transport, sessionId, text.actionFailed, text.requiresReload, text.trust.saved, text.trust.revoked, onSaved])

  if (state.phase !== 'ready') {
    return surfaceStatus({
      text,
      error: state.phase === 'error' ? state.error : undefined,
      onRetry: state.phase === 'error' ? retry : undefined,
      testId: state.phase === 'error' ? 'native-surface-error' : 'native-surface-loading'
    })
  }

  return (
    <TrustPanel
      text={text}
      view={state.view}
      busy={busy}
      error={error}
      notice={notice}
      onToggle={() => void toggle()}
      onShowEntries={onShowEntries}
    />
  )
}

export interface EntriesPanelProps {
  text: NativeSurfaceText
  view: EntriesView
  busy: boolean
  error: string
  onRefresh: () => void
  onBack?: () => void
}

export function EntriesPanel({ text, view, busy, error, onRefresh, onBack }: EntriesPanelProps): JSX.Element {
  const t = text.entries
  return (
    <div className="native-surface" data-testid="native-entries-view">
      <p className="native-surface__lead">{t.lead}</p>
      <div className="native-surface__meta" data-testid="native-entries-count">
        {t.count(view.shown, view.total)}
      </div>
      {view.rows.length ? (
        <ol className="native-entries__list" data-testid="native-entries-list">
          {view.rows.map((row) => (
            <li className="native-entries__row" key={row.id} data-kind={row.kind} data-testid={`native-entries-row-${row.id}`}>
              <span className="native-entries__kind">{text.kind[row.kind]}</span>
              <span className="native-entries__text" title={row.entryType}>
                {row.preview || row.entryType}
              </span>
              <code className="native-entries__mono native-entries__id" title={row.id}>
                {row.id}
              </code>
              <code className="native-entries__mono native-entries__parent" title={row.parentId ?? t.noParent}>
                {row.parentId ?? t.noParent}
              </code>
            </li>
          ))}
        </ol>
      ) : (
        <div className="native-surface__empty" data-testid="native-entries-empty">
          {t.empty}
        </div>
      )}
      {view.truncated ? (
        <p className="native-surface__note" data-testid="native-entries-limit">
          {t.limit(view.shown, view.total)}
        </p>
      ) : null}
      <div className="native-surface__foot">
        {onBack ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowLeft size={13} aria-hidden="true" />}
            onPress={onBack}
            data-testid="native-entries-back"
          >
            {text.back}
          </Button>
        ) : null}
        <span className="native-surface__spacer" />
        {error ? (
          <span className="native-surface__note native-surface__note--err" data-testid="native-entries-error" role="status">
            {error}
          </span>
        ) : null}
        <Button
          size="sm"
          icon={<RotateCw size={13} aria-hidden="true" />}
          isDisabled={busy}
          onPress={onRefresh}
          data-testid="native-entries-refresh"
        >
          {t.refresh}
        </Button>
      </div>
    </div>
  )
}

export interface EntriesSurfaceProps {
  transport: NativeSurfaceTransport
  sessionId: string
  text: NativeSurfaceText
  onBack?: () => void
}

export function EntriesSurface({ transport, sessionId, text, onBack }: EntriesSurfaceProps): JSX.Element {
  const [state, setState] = useState<LoadState<{ view: EntriesView }>>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const runRef = useRef(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      runRef.current += 1
    }
  }, [])

  useEffect(() => {
    const run = ++runRef.current
    setError('')
    if (!sessionId) {
      setBusy(false)
      setState({ phase: 'error', error: text.loadFailed })
      return
    }
    void loadEntries(transport, sessionId, text.loadFailed).then((result) => {
      if (!aliveRef.current || run !== runRef.current) return
      setBusy(false)
      if (!result.ok) {
        setError(result.error)
        setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'error', error: result.error }))
        return
      }
      setState({ phase: 'ready', view: result.view })
    })
  }, [transport, sessionId, reloadToken, text.loadFailed])

  const retry = useCallback((): void => {
    setState({ phase: 'loading' })
    setReloadToken((value) => value + 1)
  }, [])

  const refresh = useCallback((): void => {
    if (busy) return
    setBusy(true)
    setReloadToken((value) => value + 1)
  }, [busy])

  if (state.phase !== 'ready') {
    return surfaceStatus({
      text,
      error: state.phase === 'error' ? state.error : undefined,
      onRetry: state.phase === 'error' ? retry : undefined,
      testId: state.phase === 'error' ? 'native-surface-error' : 'native-surface-loading'
    })
  }

  return <EntriesPanel text={text} view={state.view} busy={busy} error={error} onRefresh={refresh} onBack={onBack} />
}

export interface NativeSessionSurfacesProps {
  transport?: NativeSurfaceTransport
}

function nativeSurfaceDialog({
  title,
  closeLabel,
  testId,
  onClose,
  children
}: {
  title: string
  closeLabel: string
  testId: string
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <ModalOverlay
      isDismissable
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Modal className="native-surface-modal">
        <Dialog title={title} closeLabel={closeLabel} data-testid={testId} className="native-surface-dialog">
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

export function NativeSessionSurfaces({ transport }: NativeSessionSurfacesProps): JSX.Element | null {
  const { lang } = useI18n()
  const text = useMemo(() => nativeSurfaceText(lang), [lang])
  const panel = useStore((state) => state.nativeSessionPanel)
  const close = useStore((state) => state.closeNativeSessionPanel)
  const currentModel = useStore((state) => state.session?.model ?? null)
  const peekedSessionId = useStore((state) => state.peekedSessionId)
  const peekedPath = useStore((state) => state.peekedPath)
  const session = useStore((state) => state.session)
  const [showEntries, setShowEntries] = useState(false)
  const bridge = useMemo<NativeSurfaceTransport>(
    () => transport ?? { request: (request: NativeSessionHostRequest) => window.yan.nativeSession(request) },
    [transport]
  )

  const panelKey = panel ? `${panel.mode}:${panel.sessionId}` : ''
  useEffect(() => {
    setShowEntries(false)
  }, [panelKey])

  useEffect(() => {
    if (!panel) return
    const identity = viewIdentityOf({
      peekedSessionId,
      peekedPath,
      session: session
        ? {
            sessionId: session.sessionId,
            sessionFile: session.sessionFile,
            conversationId: session.conversationId,
            conversationFile: session.conversationFile
          }
        : null
    })
    if (identity.sessionId !== panel.sessionId) close()
  }, [panel, peekedSessionId, peekedPath, session, close])

  const onSaved = useCallback((): void => {
    void useStore.getState().refreshSessions()
  }, [])

  if (!panel) return null
  if (panel.mode === 'tree') return null

  if (!isNativeSurfaceMode(panel.mode)) {
    const unknown = String(panel.mode)
    return nativeSurfaceDialog({
      title: text.unknownTitle,
      closeLabel: text.close,
      testId: 'native-surface-unknown',
      onClose: close,
      children: (
        <>
          <p className="native-surface__unknown" data-testid="native-surface-unknown-detail">
            {text.unknownMode(unknown)}
          </p>
          <div className="native-surface__foot">
            <span className="native-surface__spacer" />
            <Button size="sm" variant="primary" onPress={close}>
              {text.close}
            </Button>
          </div>
        </>
      )
    })
  }

  const mode: NativeSurfaceMode = showEntries ? 'entries' : panel.mode
  const title = text.title[mode]
  return nativeSurfaceDialog({
    title,
    closeLabel: text.close,
    testId: `native-surface-${mode}`,
    onClose: close,
    children: (
      <div className="native-surface__body" data-owner={panel.sessionId}>
        {mode === 'scoped-models' ? (
          <ScopeModelsSurface
            transport={bridge}
            sessionId={panel.sessionId}
            text={text}
            currentModel={currentModel}
            onSaved={onSaved}
            onShowEntries={panel.mode === 'scoped-models' ? () => setShowEntries(true) : undefined}
          />
        ) : mode === 'trust' ? (
          <TrustSurface
            transport={bridge}
            sessionId={panel.sessionId}
            text={text}
            onSaved={onSaved}
            onShowEntries={panel.mode === 'trust' ? () => setShowEntries(true) : undefined}
          />
        ) : (
          <EntriesSurface
            transport={bridge}
            sessionId={panel.sessionId}
            text={text}
            onBack={panel.mode === 'entries' ? undefined : () => setShowEntries(false)}
          />
        )}
      </div>
    )
  })
}

export function NativeSessionEntriesPanel({
  transport,
  sessionId
}: {
  transport?: NativeSurfaceTransport
  sessionId: string
}): JSX.Element {
  const { lang } = useI18n()
  const text = useMemo(() => nativeSurfaceText(lang), [lang])
  const bridge = useMemo<NativeSurfaceTransport>(
    () => transport ?? { request: (request: NativeSessionHostRequest) => window.yan.nativeSession(request) },
    [transport]
  )
  return <EntriesSurface transport={bridge} sessionId={sessionId} text={text} />
}
