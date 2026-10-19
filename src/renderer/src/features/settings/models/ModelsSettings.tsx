import { useEffect, useState, type ReactElement } from 'react'
import { ChevronDown } from 'lucide-react'
import type { AuthProviderInfo, OAuthLoginEvent } from '../../../../../shared/ipc'
import { modelErrorText } from '../../../../../shared/model-errors'
import { useT, type MessageKey } from '../../../i18n'
import { useStore } from '../../../state/store'
import { refreshModelsAfterRestart } from '../../../state/refresh-models'
import {
  Badge,
  Button,
  Dialog,
  Modal,
  ModalOverlay,
  Notice,
  Spinner,
  TextField,
  type BadgeTone
} from '../../../ui'
import { canRemoveCredential, credentialFromEnv, entryState, type ServiceState } from './models-model'
import { SettingsMore, SettingsReveal } from '../root/controls'
import { PiThinkingLevelsGroup } from '../general/PiNativeSettings'
import { OpenCodeProxyRow } from '../capabilities/OpenCodeProxyRow'
import { ConfirmProvider } from '../capabilities/confirm'
import { ClaudeCodeBridgeRow } from './ClaudeCodeBridgeRow'
import { CustomEndpointSettings } from './CustomEndpointSettings'
import { useModelsText } from './models-text'
import '../capabilities/capabilities.css'
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

const EMPTY: never[] = []

function stateTone(state: ServiceState): BadgeTone {
  if (state === 'ready') return 'run'
  if (state === 'loginable') return 'accent'
  return 'neutral'
}

export function ModelsSettings(): ReactElement {
  const t = useT()
  const text = useModelsText()
  const authProviders = useStore((s) => s.authProviders)
  const loadAuthProviders = useStore((s) => s.loadAuthProviders)

  const [fileInfo, setFileInfo] = useState<{ path: string; exists: boolean; count: number } | null>(null)
  const [checking, setChecking] = useState(false)

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'fail' | 'info'; text: string } | null>(null)
  const [oauth, setOauth] = useState<{ provider: string; events: OAuthLoginEvent[] } | null>(null)
  const [codexLogging, setCodexLogging] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<AuthProviderInfo | null>(null)
  const [showAllKeys, setShowAllKeys] = useState(false)

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
      setMsg({ kind: 'fail', text: readable(error) })
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
        setMsg({ kind: 'fail', text: r.error ?? t('auth.saveFailed') })
      }
    } catch (error) {
      setMsg({ kind: 'fail', text: readable(error) })
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
        setMsg({ kind: 'fail', text: r.error ?? t('auth.saveFailed') })
      }
    } catch (error) {
      setMsg({ kind: 'fail', text: readable(error) })
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
          setMsg({ kind: 'fail', text: r.error ?? t('auth.loginFail') })
        }
      } catch (error) {
        setMsg({ kind: 'fail', text: readable(error) })
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
        setMsg({ kind: 'fail', text: r.error ?? t('auth.loginFail') })
      }
    } catch (error) {
      setMsg({ kind: 'fail', text: readable(error) })
    } finally {
      setOauth(null)
    }
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
                aria-label={providerName(p)}
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
                variant="secondary"
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
                  variant="secondary"
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
                  variant="secondary"
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
                    variant="secondary"
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
                    variant="secondary"
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
      {msg ? (
        <Notice tone={msg.kind} className="ms-msg">
          {msg.text}
        </Notice>
      ) : null}

      <div className="ms-services" data-testid="ms-services">
        <div className="ms-toolbar">
          <div className="ms-toolbar-info">
            <span className="ms-summary">{t('auth.summary', { ready: readyCount, total: authProviders.length })}</span>
            <span className="ms-safety" data-testid="ms-file-info">
              {t('auth.safety')}
              {fileInfo ? (
                <span className="ms-file">
                  <code className="ms-file-path" title={fileInfo.path}>{fileInfo.path}</code>
                  <span className="ms-file-count">
                    {' · '}
                    {fileInfo.exists ? t('auth.entries', { n: fileInfo.count }) : t('auth.noFile')}
                  </span>
                </span>
              ) : null}
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={checking}
            data-testid="ms-recheck"
            data-setting-id="models-recheck"
            onPress={() => void recheck()}
          >
            {checking ? <Spinner label={t('auth.checking')} /> : null}
            {checking ? t('auth.checking') : t('auth.recheck')}
          </Button>
        </div>

        {authProviders.length === 0 ? <p className="ms-note">{text('noAuthInfo')}</p> : null}

        {subscriptions.length > 0 ? (
          <section className="ms-group" aria-label={t('auth.subs')} data-setting-id="models-subscriptions">
            <h3 className="ms-group-title">{t('auth.subs')}</h3>
            <div className="settings-rows ms-rows">{subscriptions.map(serviceRow)}</div>
          </section>
        ) : null}

        {keys.length > 0 ? (
          <section className="ms-group" aria-label={t('auth.keys')} data-setting-id="models-api-keys">
            <h3 className="ms-group-title">{t('auth.keys')}</h3>
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
                      icon={<ChevronDown size={14} className="ms-rows-foot__chevron" aria-hidden />}
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
          </section>
        ) : null}
      </div>

      <SettingsMore>
        <CustomEndpointSettings />
        <section className="ms-group" aria-label={t('cc.title')} data-setting-id="models-claude-code">
          <div className="settings-rows ms-rows">
            <ClaudeCodeBridgeRow />
          </div>
        </section>
        <section className="ms-group" aria-label={text('openCodeProxy')} data-setting-id="models-opencode-proxy">
          <ConfirmProvider>
            <OpenCodeProxyRow />
          </ConfirmProvider>
        </section>
        <div className="ms-group">
          <PiThinkingLevelsGroup />
        </div>
      </SettingsMore>

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
          <Button size="sm" variant="secondary" onPress={() => copy(device.userCode)}>
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
          <Button size="sm" variant="secondary" onPress={() => void window.yan.browser.openExternal(authUrl.url)}>
            {t('auth.openAgain')}
          </Button>
          <Button size="sm" variant="secondary" onPress={() => copy(authUrl.url)}>
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
                <Button key={o.id} size="sm" variant="secondary" onPress={() => reply(o.id)}>
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
              <Button size="sm" variant="secondary" type="submit">
                {t('auth.submit')}
              </Button>
            </form>
          )}
        </div>
      ) : null}
    </div>
  )
}
