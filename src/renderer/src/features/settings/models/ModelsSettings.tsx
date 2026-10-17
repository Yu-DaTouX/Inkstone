import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Star } from 'lucide-react'
import type { AuthProviderInfo, CapabilityStatus, OAuthLoginEvent } from '../../../../../shared/ipc'
import { modelErrorText } from '../../../../../shared/model-errors'
import { useT, type MessageKey } from '../../../i18n'
import { useStore } from '../../../state/store'
import { refreshModelsAfterRestart } from '../../../state/refresh-models'
import {
  Badge,
  Button,
  Dialog,
  ListBoxItem,
  Modal,
  ModalOverlay,
  SearchField,
  SegmentedControl,
  Select,
  Spinner,
  TextField,
  type BadgeTone
} from '../../../ui'
import {
  buildCatalogRows,
  canRemoveCredential,
  catalogProviders,
  credentialFromEnv,
  entryState,
  shortWindow,
  toggleFavorite,
  thinkingView,
  type CatalogModel,
  type ServiceState
} from './models-model'
import { SettingsReveal } from '../root/controls'
import { ClaudeCodeBridgeRow } from './ClaudeCodeBridgeRow'
import { CustomEndpointSettings } from './CustomEndpointSettings'
import { useModelsText, type ModelsTextKey } from './models-text'
import './models-settings.css'

const PROVIDER_NAME: Record<string, MessageKey> = {
  anthropic: 'auth.anthropicMetered',
  xai: 'auth.name.xai',
  'zai-coding-cn': 'auth.name.zai',
  'minimax-cn': 'auth.name.minimax',
  'qwen-token-plan-cn': 'auth.name.qwen',
  'xai-api': 'auth.name.xaiApi',
  'openrouter-key': 'auth.name.openrouterApi',
  'volcengine-ark': 'auth.name.ark'
}

const PROVIDER_HINT: Record<string, MessageKey> = {
  'openai-codex': 'auth.hint.codex',
  anthropic: 'auth.hint.anthropic',
  'github-copilot': 'auth.hint.copilot',
  openrouter: 'auth.hint.openrouter',
  commandcode: 'auth.hint.commandcode',
  'xai-api': 'auth.hint.xaiApi'
}

const LEVEL_LABEL: Record<string, MessageKey> = {
  off: 'think.off',
  minimal: 'think.minimal',
  low: 'think.low',
  medium: 'think.medium',
  high: 'think.high',
  xhigh: 'think.xhigh',
  max: 'think.max'
}

const EMPTY: never[] = []

function stateTone(state: ServiceState): BadgeTone {
  if (state === 'ready') return 'run'
  if (state === 'loginable') return 'accent'
  return 'neutral'
}

export function ModelsSettings(): ReactElement {
  const t = useT()
  const text = useModelsText()
  const models = useStore((s) => s.models)
  const thinkingLevels = useStore((s) => s.thinkingLevels)
  const authProviders = useStore((s) => s.authProviders)
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const loadAuthProviders = useStore((s) => s.loadAuthProviders)
  const setModel = useStore((s) => s.setModel)
  const patchSettings = useStore((s) => s.patchSettings)

  const [tab, setTab] = useState<'services' | 'catalog'>('services')
  const [fileInfo, setFileInfo] = useState<{ path: string; exists: boolean; count: number } | null>(null)
  const [checking, setChecking] = useState(false)

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [oauth, setOauth] = useState<{ provider: string; events: OAuthLoginEvent[] } | null>(null)
  const [codexLogging, setCodexLogging] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<AuthProviderInfo | null>(null)
  const [showAllKeys, setShowAllKeys] = useState(false)

  const [query, setQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [pendingModel, setPendingModel] = useState<string | null>(null)

  useEffect(() => {
    if (useStore.getState().authProviders.length === 0) void loadAuthProviders()
    void window.yan
      .authFileInfo()
      .then(setFileInfo)
      .catch(() => undefined)
  }, [loadAuthProviders])

  useEffect(
    () =>
      window.yan.onOAuthEvent((ev) =>
        setOauth((cur) => (cur && cur.provider === ev.provider ? { ...cur, events: [...cur.events, ev] } : cur))
      ),
    []
  )

  const readable = (error: unknown): string =>
    modelErrorText(error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')

  const refreshFileInfo = async (): Promise<void> => {
    const fi = await window.yan.authFileInfo().catch(() => null)
    if (fi) setFileInfo(fi)
  }

  const refreshAfterWrite = async (): Promise<void> => {
    await loadAuthProviders()
    await refreshFileInfo()
  }

  const recheck = async (): Promise<void> => {
    setChecking(true)
    setMsg(null)
    try {
      const list = await window.yan.authProviders(true)
      useStore.setState({ authProviders: Array.isArray(list) ? list : [] })
      await refreshFileInfo()
    } catch (error) {
      setMsg({ kind: 'err', text: readable(error) })
    } finally {
      setChecking(false)
    }
  }

  const saveKey = async (): Promise<void> => {
    if (!editing || !draft.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.yan.setApiKey(editing, draft)
      if (r.ok) {
        setMsg({ kind: 'ok', text: t('auth.saved') })
        refreshModelsAfterRestart()
        setEditing(null)
        setDraft('')
        await refreshAfterWrite()
      } else {
        setMsg({ kind: 'err', text: r.error ?? t('auth.saveFailed') })
      }
    } catch (error) {
      setMsg({ kind: 'err', text: readable(error) })
    } finally {
      setBusy(false)
    }
  }

  const confirmRemove = async (info: AuthProviderInfo): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.yan.clearAuth(info.authKey || info.id)
      if (r.ok) {
        setMsg({ kind: 'ok', text: t('auth.cleared') })
        refreshModelsAfterRestart()
        await refreshAfterWrite()
      } else {
        setMsg({ kind: 'err', text: r.error ?? t('auth.saveFailed') })
      }
    } catch (error) {
      setMsg({ kind: 'err', text: readable(error) })
    } finally {
      setBusy(false)
      setPendingRemove(null)
    }
  }

  const startLogin = async (info: AuthProviderInfo): Promise<void> => {
    setMsg(null)
    if (info.id === 'openai-codex') {
      setCodexLogging(true)
      try {
        const r = await window.yan.codexLogin()
        if (r.ok) {
          setMsg({ kind: 'ok', text: t('auth.loginOk') })
          refreshModelsAfterRestart()
          await refreshAfterWrite()
        } else {
          setMsg({ kind: 'err', text: r.error ?? t('auth.loginFail') })
        }
      } catch (error) {
        setMsg({ kind: 'err', text: readable(error) })
      } finally {
        setCodexLogging(false)
      }
      return
    }
    setOauth({ provider: info.id, events: [] })
    try {
      const r = await window.yan.oauthLogin(info.id)
      if (r.ok) {
        setMsg({ kind: 'ok', text: t('auth.loginOkGeneric') })
        refreshModelsAfterRestart()
        await refreshAfterWrite()
      } else if (!r.cancelled) {
        setMsg({ kind: 'err', text: r.error ?? t('auth.loginFail') })
      }
    } catch (error) {
      setMsg({ kind: 'err', text: readable(error) })
    } finally {
      setOauth(null)
    }
  }

  const replaceFavorite = async (model: CatalogModel): Promise<void> => {
    const saved = useStore.getState().settings?.modelFavorites ?? []
    setMsg(null)
    try {
      await patchSettings({ modelFavorites: toggleFavorite(saved, model) })
    } catch (error) {
      setMsg({ kind: 'err', text: readable(error) })
    }
  }

  const applyModel = async (model: CatalogModel): Promise<void> => {
    if (pendingModel) return
    const before = useStore.getState()
    setPendingModel(model.key)
    setMsg(null)
    try {
      const res = await setModel(model.provider, model.id)
      const now = useStore.getState()
      const moved =
        (!!before.activeRunnerId && !!now.activeRunnerId && now.activeRunnerId !== before.activeRunnerId) ||
        (!!before.session?.sessionId && !!now.session?.sessionId && now.session.sessionId !== before.session.sessionId)
      if (moved) {
        setMsg({ kind: 'info', text: text('viewChanged') })
        return
      }
      if (!res.ok) setMsg({ kind: 'err', text: res.error ?? t('models.selectFailed') })
    } catch (error) {
      setMsg({ kind: 'err', text: readable(error) })
    } finally {
      setPendingModel(null)
    }
  }

  const favorites = settings?.modelFavorites ?? EMPTY
  const providerOrder = settings?.modelProviderOrder ?? EMPTY
  const providers = useMemo(
    () => catalogProviders({ models, favorites, providerOrder }),
    [models, favorites, providerOrder]
  )
  const rows = useMemo(
    () =>
      buildCatalogRows({
        models,
        favorites,
        query,
        provider: providerFilter,
        favoriteOnly,
        providerOrder
      }),
    [models, favorites, query, providerFilter, favoriteOnly, providerOrder]
  )

  const currentKey = session?.model ? `${session.model.provider}/${session.model.id}` : ''
  const sessionBusy = !!session?.isStreaming || !!session?.isCompacting || !!session?.isAgentRunning
  const needsAuth = (provider: string): boolean => {
    if (authProviders.length === 0) return false
    const info = authProviders.find(
      (p) => p.id === provider || (p.authKey !== '' && p.authKey === provider)
    )
    return !!info && entryState(info) !== 'ready'
  }

  const providerName = (p: AuthProviderInfo): string => (PROVIDER_NAME[p.id] ? t(PROVIDER_NAME[p.id]) : p.name)
  const providerHint = (p: AuthProviderInfo): string => (PROVIDER_HINT[p.id] ? t(PROVIDER_HINT[p.id]) : '')
  const stateLabel = (state: ServiceState): string => {
    if (state === 'ready') return t('auth.ready')
    if (state === 'loginable') return text('stateLoginable')
    if (state === 'missing') return t('picker.needsAuth')
    return text('stateUnknown')
  }

  const keys = authProviders.filter((p) => p.kind !== 'subscription')
  const subscriptions = authProviders.filter((p) => p.kind === 'subscription')
  const readyKeys = keys.filter((p) => p.status === 'ready')
  const otherKeys = keys.filter((p) => p.status !== 'ready')
  const readyCount = authProviders.filter((p) => p.status === 'ready').length

  const loginInProgress = (p: AuthProviderInfo): boolean =>
    p.id === 'openai-codex' ? codexLogging : oauth?.provider === p.id

  const serviceRow = (p: AuthProviderInfo): ReactElement => {
    const state = entryState(p)
    const isKey = p.kind !== 'subscription'
    const editingThis = editing === p.id
    const fromEnv = credentialFromEnv(p)
    const activeOauth = oauth?.provider === p.id
    return (
      <div className="ms-service" key={p.id} data-testid={`ms-service-${p.id}`}>
        <div className="ms-service-main">
          <span className="ms-service-head">
            <span className="ms-service-name">{providerName(p)}</span>
            <Badge tone={stateTone(state)}>{stateLabel(state)}</Badge>
          </span>
          {providerHint(p) ? <p className="ms-service-hint">{providerHint(p)}</p> : null}
          {p.envVar ? <p className="ms-service-env">{t('auth.orEnv')} <code>{p.envVar}</code></p> : null}
          {fromEnv ? <p className="ms-service-warn">{text('envLocked')}</p> : null}
        </div>

        <div className="ms-service-actions">
          {editingThis ? (
            <div className="ms-key-edit">
              <TextField
                label={t('auth.pasteKey')}
                type="password"
                autoComplete="off"
                value={draft}
                onChange={setDraft}
                placeholder={t('auth.pasteKey')}
                isDisabled={busy}
                autoFocus
              />
              <Button
                size="sm"
                variant="primary"
                isDisabled={busy || !draft.trim()}
                onPress={() => void saveKey()}
              >
                {t('auth.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={busy}
                onPress={() => {
                  setEditing(null)
                  setDraft('')
                }}
              >
                {t('ui.cancel')}
              </Button>
            </div>
          ) : (
            <>
              {state === 'ready' && canRemoveCredential(p) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy}
                  data-testid={`ms-remove-${p.id}`}
                  onPress={() => setPendingRemove(p)}
                >
                  {t('auth.signOut')}
                </Button>
              ) : null}
              {isKey && state !== 'unknown' ? (
                <Button
                  size="sm"
                  isDisabled={busy}
                  data-testid={`ms-set-${p.id}`}
                  onPress={() => {
                    setEditing(p.id)
                    setDraft('')
                    setMsg(null)
                  }}
                >
                  {state === 'ready' ? t('auth.replace') : t('auth.setKey')}
                </Button>
              ) : null}
              {!isKey && state === 'loginable' ? (
                loginInProgress(p) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`ms-login-cancel-${p.id}`}
                    onPress={() => {
                      if (p.id === 'openai-codex') void window.yan.codexLoginCancel()
                      else void window.yan.oauthLoginCancel(p.id)
                    }}
                  >
                    {t('ui.cancel')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    isDisabled={busy || codexLogging || !!oauth}
                    data-testid={`ms-login-${p.id}`}
                    onPress={() => void startLogin(p)}
                  >
                    {t('auth.loginInApp')}
                  </Button>
                )
              ) : null}
              {!isKey && state === 'missing' ? (
                <span className="ms-cli" title={t('auth.cmdTip')}>
                  <code>pi</code>
                  <span aria-hidden>→</span>
                  <code>/login</code>
                </span>
              ) : null}
            </>
          )}
        </div>

        {activeOauth ? <OAuthPanel provider={p.id} events={oauth?.events ?? EMPTY} t={t} /> : null}
        {p.id === 'openai-codex' && codexLogging ? (
          <p className="ms-service-warn" data-testid="ms-codex-waiting">
            <Spinner label={t('auth.loginWaiting')} /> {t('auth.loginWaiting')}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <section className="ms-page" aria-label={text('title')}>
      <header className="ms-head">
        <SegmentedControl
          className="ms-tabs"
          label={text('title')}
          value={tab}
          options={[
            { value: 'services', label: text('tabServices'), testId: 'ms-tab-services' },
            { value: 'catalog', label: text('tabCatalog'), testId: 'ms-tab-catalog' }
          ]}
          onChange={setTab}
        />
      </header>

      {msg ? (
        <p className={`ms-msg ms-msg--${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>
          {msg.text}
        </p>
      ) : null}

      {tab === 'services' ? (
        <div className="ms-services" data-testid="ms-services">
          <div className="ms-toolbar">
            <div className="ms-toolbar-info">
              <span className="ms-summary">{t('auth.summary', { ready: readyCount, total: authProviders.length })}</span>
              <span className="ms-safety">{t('auth.safety')}</span>
            </div>
            <Button size="sm" isDisabled={checking} data-testid="ms-recheck" onPress={() => void recheck()}>
              {checking ? <Spinner label={t('auth.checking')} /> : null}
              {checking ? t('auth.checking') : t('auth.recheck')}
            </Button>
          </div>

          {authProviders.length === 0 ? <p className="settings-section__lede">{text('noAuthInfo')}</p> : null}

          <section className="ms-group" aria-label={t('auth.subs')}>
            <h3 className="ms-group-title">{t('auth.subs')}</h3>
            <p className="ms-note">{text('loginPanelNote')}</p>
            <div className="settings-rows ms-rows">
              {subscriptions.map(serviceRow)}
              <ClaudeCodeBridgeRow />
            </div>
          </section>

          <section className="ms-group" aria-label={t('auth.keys')}>
            <h3 className="ms-group-title">{t('auth.keys')}</h3>
            {keys.length > 0 ? (
              <div className="settings-rows ms-rows">
                {readyKeys.map(serviceRow)}
                {otherKeys.length > 0 ? (
                  <>
                    <SettingsReveal open={showAllKeys}>{otherKeys.map(serviceRow)}</SettingsReveal>
                    <div className="ms-rows-foot">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={showAllKeys}
                        data-testid="ms-toggle-keys"
                        onPress={() => setShowAllKeys((v) => !v)}
                      >
                        {showAllKeys
                          ? text('hideAllKeys')
                          : text('showAllKeys').replace('{n}', String(otherKeys.length))}
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </section>

          <CustomEndpointSettings />
          {fileInfo ? (
            <p className="ms-fileinfo" data-testid="ms-file-info">
              {t('auth.fileHint')}：<code title={fileInfo.path}>{fileInfo.path}</code>
              {' · '}
              {fileInfo.exists ? t('auth.entries', { n: fileInfo.count }) : t('auth.noFile')}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="ms-catalog" data-testid="ms-catalog">
          <ThinkingPanel
            modelName={session?.model?.name ?? ''}
            level={session?.thinkingLevel ?? 'off'}
            levels={thinkingLevels}
            status={session?.thinkingLevelsStatus}
            text={text}
            t={t}
          />

          <div className="ms-toolbar">
            <SearchField
              className="ms-search"
              aria-label={t('picker.searchModel')}
              placeholder={t('picker.searchModel')}
              value={query}
              onChange={setQuery}
            />
            <Button
              size="sm"
              variant={favoriteOnly ? 'primary' : 'ghost'}
              aria-pressed={favoriteOnly}
              data-testid="ms-favorites-only"
              onPress={() => setFavoriteOnly((v) => !v)}
            >
              <Star size={13} fill={favoriteOnly ? 'currentColor' : 'none'} aria-hidden /> {t('models.favorites')}
            </Button>
            <Select
              className="ms-filter"
              aria-label={t('models.provider')}
              placeholder={t('models.allProviders')}
              selectedKey={providerFilter}
              isDisabled={favoriteOnly}
              onSelectionChange={(key) => setProviderFilter(String(key ?? ''))}
            >
              <ListBoxItem id="">{t('models.allProviders')}</ListBoxItem>
              {providers.map((p) => (
                <ListBoxItem key={p} id={p}>
                  {p}
                </ListBoxItem>
              ))}
            </Select>
            <span className="ms-count">{rows.length}</span>
          </div>

          {sessionBusy ? <p className="ms-note" role="note">{text('busyNote')}</p> : null}

          {rows.length === 0 ? (
            <p className="ms-empty" data-testid="ms-empty">
              {favoriteOnly ? t('models.noFavorites') : models.length ? t('picker.noMatch') : t('picker.noModels')}
            </p>
          ) : (
            <div className="ms-list" role="list">
              {rows.map((row) => {
                const isCurrent = !!currentKey && row.key === currentKey
                const context =
                  row.contextWindow > 0 && row.contextWindowStatus !== 'unknown'
                    ? shortWindow(row.contextWindow)
                    : ''
                const showProvider = favoriteOnly || !providerFilter
                const reasoningLabel =
                  row.reasoningStatus === 'known'
                    ? text('reasoningKnown')
                    : row.reasoningStatus === 'unsupported'
                      ? text('reasoningUnsupported')
                      : text('reasoningUnknown')
                return (
                  <div
                    className="ms-model"
                    role="listitem"
                    key={row.key}
                    data-current={isCurrent ? '1' : '0'}
                    data-available={row.available ? '1' : '0'}
                    data-testid={`ms-model-${row.id}`}
                  >
                    <div className="ms-model-main">
                      <div className="ms-model-name" title={`${row.name}\n${row.provider} / ${row.id}`}>
                        {row.name}
                      </div>
                      <div className="ms-model-meta">
                        {showProvider ? <span>{row.provider}</span> : null}
                        {context ? <span>{context}</span> : null}
                        {row.input.includes('image') && row.inputStatus !== 'unknown' ? (
                          <span>{t('picker.image')}</span>
                        ) : null}
                        <span className={`ms-reason ms-reason--${row.reasoningStatus}`}>{reasoningLabel}</span>
                        {!row.available ? (
                          <span className="ms-warn">{t('models.unavailable')}</span>
                        ) : needsAuth(row.provider) ? (
                          <span className="ms-warn">{t('picker.needsAuth')}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="ms-model-actions">
                      {isCurrent ? (
                        <Badge tone="run">{text('current')}</Badge>
                      ) : (
                        <Button
                          size="sm"
                          isDisabled={!row.available || !!pendingModel || sessionBusy}
                          data-testid={`ms-use-${row.id}`}
                          onPress={() => void applyModel(row)}
                        >
                          {pendingModel === row.key ? text('switching') : text('useAction')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-pressed={row.starred}
                        aria-label={t(row.starred ? 'models.unfavorite' : 'models.favorite', { name: row.name })}
                        data-testid={`ms-favorite-${row.id}`}
                        onPress={() => void replaceFavorite(row)}
                      >
                        <Star size={14} fill={row.starred ? 'currentColor' : 'none'} aria-hidden />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {pendingRemove ? (
        <ModalOverlay
          className="ms-overlay"
          isOpen
          isDismissable
          onOpenChange={(open) => {
            if (!open) setPendingRemove(null)
          }}
        >
          <Modal className="ms-modal">
            <Dialog title={text('removeTitle')} closeLabel={t('ui.cancel')}>
              <p className="ms-confirm-body">{text('removeBody')}</p>
              <p className="ms-confirm-target">{providerName(pendingRemove)}</p>
              <div className="ms-confirm-actions">
                <Button variant="secondary" size="sm" onPress={() => setPendingRemove(null)}>
                  {t('ui.cancel')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  data-testid="ms-remove-confirm"
                  isDisabled={busy}
                  onPress={() => void confirmRemove(pendingRemove)}
                >
                  {text('removeConfirm')}
                </Button>
              </div>
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}
    </section>
  )
}

function OAuthPanel({
  provider,
  events,
  t
}: {
  provider: string
  events: readonly OAuthLoginEvent[]
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}): ReactElement {
  const [answer, setAnswer] = useState('')
  const [sent, setSent] = useState<number[]>([])
  const closed = new Set<number>(sent)
  for (const e of events) if (e.type === 'prompt_closed') closed.add(e.promptId)
  const latest = <K extends OAuthLoginEvent['type']>(type: K): Extract<OAuthLoginEvent, { type: K }> | undefined =>
    [...events].reverse().find((e) => e.type === type) as Extract<OAuthLoginEvent, { type: K }> | undefined
  const authUrl = latest('auth_url')
  const device = latest('device_code')
  const progress = latest('progress')
  const prompt = [...events]
    .reverse()
    .find((e): e is Extract<OAuthLoginEvent, { type: 'prompt' }> => e.type === 'prompt' && !closed.has(e.promptId))
  const copy = (value: string): void => {
    void navigator.clipboard?.writeText(value).catch(() => undefined)
  }
  const reply = (value: string): void => {
    if (!prompt) return
    setSent((cur) => [...cur, prompt.promptId])
    setAnswer('')
    void window.yan.oauthLoginAnswer(provider, prompt.promptId, value)
  }
  return (
    <div className="ms-oauth" data-testid={`ms-oauth-panel-${provider}`}>
      <div className="ms-oauth-status">
        <Spinner label={t('auth.loginWaiting')} />
        <span>{progress?.message || (device ? t('auth.deviceWaiting') : t('auth.loginWaiting'))}</span>
      </div>
      {device ? (
        <div className="ms-oauth-row">
          <code className="ms-oauth-code" data-testid="ms-device-code">
            {device.userCode}
          </code>
          <Button size="sm" onPress={() => copy(device.userCode)}>
            {t('auth.copyCode')}
          </Button>
          {device.url ? (
            <Button size="sm" variant="primary" onPress={() => void window.yan.browser.openExternal(device.url)}>
              {t('auth.openVerify')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {authUrl && !device ? (
        <div className="ms-oauth-row">
          <span>{t('auth.browserOpened')}</span>
          <Button size="sm" variant="ghost" onPress={() => void window.yan.browser.openExternal(authUrl.url)}>
            {t('auth.openAgain')}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => copy(authUrl.url)}>
            {t('auth.copyLink')}
          </Button>
        </div>
      ) : null}
      {prompt ? (
        <div className="ms-oauth-prompt">
          <p>{prompt.message}</p>
          {prompt.kind === 'select' && prompt.options?.length ? (
            <div className="ms-oauth-row">
              {prompt.options.map((o) => (
                <Button key={o.id} size="sm" onPress={() => reply(o.id)}>
                  {o.label}
                </Button>
              ))}
            </div>
          ) : (
            <form
              className="ms-oauth-row"
              onSubmit={(e) => {
                e.preventDefault()
                reply(answer)
              }}
            >
              <TextField
                aria-label={prompt.message}
                placeholder={prompt.placeholder}
                value={answer}
                onChange={setAnswer}
                autoFocus
              />
              <Button size="sm" type="submit">
                {t('auth.submit')}
              </Button>
            </form>
          )}
        </div>
      ) : null}
    </div>
  )
}

function ThinkingPanel({
  modelName,
  level,
  levels,
  status,
  text,
  t
}: {
  modelName: string
  level: string
  levels: readonly string[]
  status: CapabilityStatus | undefined
  text: (key: ModelsTextKey) => string
  t: (key: MessageKey) => string
}): ReactElement {
  const view = thinkingView(levels, status)
  return (
    <div className="ms-thinking" data-testid="ms-thinking">
      <div className="ms-thinking-head">
        <span className="ms-thinking-title">{text('thinkingTitle')}</span>
        {modelName ? <span className="ms-thinking-model">{modelName}</span> : null}
      </div>
      {view.kind === 'levels' ? (
        <div className="ms-levels" role="radiogroup" aria-label={text('thinkingTitle')}>
          {view.values.map((l) => (
            <span key={l} className="ms-level" data-active={l === level ? '1' : '0'}>
              {LEVEL_LABEL[l] ? t(LEVEL_LABEL[l]) : l}
            </span>
          ))}
        </div>
      ) : (
        <p className="ms-thinking-note" data-testid="ms-thinking-note">
          {view.kind === 'unsupported'
            ? t('picker.thinkUnsupported')
            : view.kind === 'no-levels'
              ? t('picker.thinkNotDeclared')
              : modelName
                ? t('picker.thinkUnknown')
                : text('thinkingNoSession')}
        </p>
      )}
      <p className="ms-thinking-source">{text('thinkingSource')}</p>
    </div>
  )
}
