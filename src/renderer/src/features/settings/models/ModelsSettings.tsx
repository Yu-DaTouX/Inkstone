import { useEffect, useState, type ReactElement } from 'react'
import type { AuthProviderInfo, OAuthLoginEvent } from '../../../../../shared/ipc'
import { modelErrorText } from '../../../../../shared/model-errors'
import { useI18n, useT, type MessageKey } from '../../../i18n'
import { useStore } from '../../../state/store'
import { refreshModelsAfterRestart } from '../../../state/refresh-models'
import {
  Badge,
  Button,
  CollapsibleChevron,
  ConfirmDialog,
  EmptyState,
  Kbd,
  Notice,
  Spinner,
  TextField,
  TooltipText,
  type BadgeTone
} from '../../../ui'
import { canRemoveCredential, credentialFromEnv, entryState, type ServiceState } from './models-model'
import { SettingsGroup, SettingsReveal } from '../root/controls'
import { settingsText } from '../settings-text'
import { PiThinkingLevelsGroup } from '../general/PiNativeSettings'
import { ClaudeCodeBridgeRow } from './ClaudeCodeBridgeRow'
import { ApiKeyList } from './ApiKeyList'
import { SubscriptionAccountList } from './SubscriptionAccountList'
import { supportsOAuthAccounts, type OAuthAccountPools, type OAuthAccountView } from '../../../../../shared/oauth-accounts'
import type { CodexAccountView } from '../../../../../shared/account-quota'
import type { ApiKeyPools, ApiKeyView } from '../../../../../shared/api-keys'
import { CustomEndpointSettings } from './CustomEndpointSettings'
import { ModelVisibilityGroup } from './ModelVisibilityGroup'
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
  if (state === 'ready') return 'ok'
  return 'neutral'
}

const ORPHAN_LOGIN = /已有.*登录.*进行/

async function retryAfterOrphan<T extends { ok: boolean; error?: string }>(start: () => Promise<T>): Promise<T> {
  let result = await start()
  for (let attempt = 0; attempt < 20 && !result.ok && ORPHAN_LOGIN.test(result.error ?? ''); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    result = await start()
  }
  return result
}

export function ModelsSettings(): ReactElement {
  const t = useT()
  const text = useModelsText()
  const labels = settingsText(useI18n().lang)
  const authProviders = useStore((s) => s.authProviders)
  const loadAuthProviders = useStore((s) => s.loadAuthProviders)

  const [fileInfo, setFileInfo] = useState<{ path: string; exists: boolean; count: number } | null>(null)
  const [checking, setChecking] = useState(false)

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [labelDraft, setLabelDraft] = useState('')
  const [pools, setPools] = useState<ApiKeyPools>({})
  const [codexAccounts, setCodexAccounts] = useState<CodexAccountView[]>([])
  const [oauthAccounts, setOAuthAccounts] = useState<OAuthAccountPools>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'fail' | 'info'; text: string } | null>(null)
  const [oauth, setOauth] = useState<{ provider: string; events: OAuthLoginEvent[] } | null>(null)
  const [codexLogging, setCodexLogging] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<AuthProviderInfo | null>(null)
  const [showAllKeys, setShowAllKeys] = useState(false)
  const [showPath, setShowPath] = useState(false)

  const loadPools = async (): Promise<void> => {
    const next = await window.yan.apiKeys().catch(() => null)
    if (next) setPools(next)
  }

  const loadAccounts = async (): Promise<void> => {
    try {
      const [codex, others] = await Promise.all([window.yan.codexAccounts(), window.yan.oauthAccounts()])
      setCodexAccounts(codex)
      setOAuthAccounts(others)
    } catch (error) {
      setMsg({ kind: 'fail', text: readable(error) })
    }
  }

  useEffect(() => {
    if (useStore.getState().authProviders.length === 0) void loadAuthProviders()
    void loadPools()
    void loadAccounts()
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
    await loadPools()
    await loadAccounts()
  }

  const authIdOf = (p: AuthProviderInfo): string => p.authKey || p.id

  const recheck = async (): Promise<void> => {
    setChecking(true)
    setMsg(null)
    try {
      const list = await window.yan.authProviders(true)
      useStore.setState({ authProviders: Array.isArray(list) ? list : [] })
      await refreshFileInfo()
      await loadAccounts()
      await loadPools()
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
      const info = authProviders.find((p) => p.id === editing)
      const r = await window.yan.addApiKey(info ? authIdOf(info) : editing, draft, labelDraft.trim() || undefined)
      if (r.ok) {
        setMsg({ kind: 'ok', text: t('auth.saved') })
        refreshModelsAfterRestart()
        setEditing(null)
        setDraft('')
        setLabelDraft('')
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

  const keyListDone = async (r: { ok: boolean; error?: string }, switched?: ApiKeyView): Promise<void> => {
    if (!r.ok) {
      setMsg({ kind: 'fail', text: r.error ?? t('auth.saveFailed') })
      return
    }
    if (switched) {
      setMsg({ kind: 'ok', text: text('keySwitched').replace('{label}', switched.label) })
    } else {
      setMsg(null)
    }
    refreshModelsAfterRestart()
    await refreshAfterWrite()
  }

  const actOnAccount = async (provider: string, account: OAuthAccountView, action: 'switch' | 'remove' | 'rename', label?: string): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      let r: { ok: boolean; error?: string }
      if (action === 'rename') r = await window.yan.oauthAccountRename(provider, account.key, label ?? '')
      else if (action === 'switch') r = provider === 'openai-codex'
        ? await window.yan.codexAccountSwitch(account.key)
        : await window.yan.oauthAccountSwitch(provider, account.key)
      else r = provider === 'openai-codex'
        ? await window.yan.codexAccountRemove(account.key)
        : await window.yan.oauthAccountRemove(provider, account.key)
      if (r.ok) {
        setMsg({ kind: 'ok', text: action === 'switch'
          ? text('keySwitched').replace('{label}', account.label || account.email || provider)
          : t('auth.cleared') })
        refreshModelsAfterRestart()
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
        let r = await window.yan.codexLogin()
        if (!r.ok && ORPHAN_LOGIN.test(r.error ?? '')) {
          await window.yan.codexLoginCancel()
          r = await retryAfterOrphan(() => window.yan.codexLogin())
        }
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
      let r = await window.yan.oauthLogin(info.id)
      if (!r.ok && !r.cancelled && ORPHAN_LOGIN.test(r.error ?? '')) {
        await window.yan.oauthLoginCancel('')
        r = await retryAfterOrphan(() => window.yan.oauthLogin(info.id))
      }
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

  const accountsOf = (p: AuthProviderInfo): OAuthAccountView[] => {
    if (p.id === 'openai-codex') return codexAccounts
    const provider = authIdOf(p)
    return supportsOAuthAccounts(provider) ? oauthAccounts[provider] ?? [] : []
  }

  const loginInProgress = (p: AuthProviderInfo): boolean =>
    p.id === 'openai-codex' ? codexLogging : oauth?.provider === p.id

  const serviceRow = (p: AuthProviderInfo): ReactElement => {
    const state = entryState(p)
    const isKey = p.kind !== 'subscription'
    const acceptsKey = isKey || p.id === 'anthropic'
    const accounts = accountsOf(p)
    const editingThis = editing === p.id
    const fromEnv = credentialFromEnv(p)
    const activeOauth = oauth?.provider === p.id
    return (
      <div className="ms-service" key={p.id} data-testid={`ms-service-${p.id}`}>
        <div className="ms-service-main">
          <span className="ms-service-head">
            <span className="ms-service-name">{providerName(p)}</span>
            {state === 'ready' ? <Badge tone={stateTone(state)}>{stateLabel(state)}</Badge> : null}
          </span>
          {providerHint(p) ? <p className="ms-service-hint">{providerHint(p)}</p> : null}
          {p.envVar ? <p className="ms-service-env">{t('auth.orEnv')} <code>{p.envVar}</code></p> : null}
          {fromEnv ? <Notice tone="info" compact role="note" className="ms-env-notice">{text('envActive')}</Notice> : null}
          {p.envShadowed ? <p className="ms-service-env">{text('envShadowed')}</p> : null}
        </div>

        <div className="ms-service-actions">
          {editingThis ? (
            <div className="ms-key-edit">
              {acceptsKey ? (
                <TextField
                  className="ms-key-edit-label"
                  aria-label={text('keyLabelPlaceholder')}
                  value={labelDraft}
                  onChange={setLabelDraft}
                  placeholder={text('keyLabelPlaceholder')}
                  maxLength={40}
                  isDisabled={busy}
                />
              ) : null}
              <TextField
                className="ms-key-edit-input"
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
                variant="primary"
                isDisabled={busy || !draft.trim()}
                onPress={() => void saveKey()}
              >
                {t('auth.save')}
              </Button>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => {
                  setEditing(null)
                  setDraft('')
                  setLabelDraft('')
                }}
              >
                {t('ui.cancel')}
              </Button>
            </div>
          ) : (
            <>
              {state === 'ready' && canRemoveCredential(p) ? (
                <Button
                  variant="secondary"
                  isDisabled={busy || codexLogging || !!oauth}
                  data-testid={`ms-remove-${p.id}`}
                  onPress={() => setPendingRemove(p)}
                >
                  {t('auth.signOut')}
                </Button>
              ) : null}
              {acceptsKey && state !== 'unknown' ? (
                <Button
                  variant="secondary"
                  isDisabled={busy || codexLogging || !!oauth}
                  data-testid={`ms-set-${p.id}`}
                  onPress={() => {
                    setEditing(p.id)
                    setDraft('')
                    setLabelDraft('')
                    setMsg(null)
                  }}
                >
                  {text('addKey')}
                </Button>
              ) : null}
              {!isKey && (state === 'loginable' || (p.inAppLogin && state === 'ready')) ? (
                loginInProgress(p) ? (
                  <Button
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
                    variant="secondary"
                    isDisabled={busy || codexLogging || !!oauth}
                    data-testid={`ms-login-${p.id}`}
                    onPress={() => void startLogin(p)}
                  >
                    {state === 'ready' || accounts.length > 0 ? text('addAccount') : t('auth.loginInApp')}
                  </Button>
                )
              ) : null}
              {!isKey && state === 'missing' ? (
                <TooltipText className="ms-cli" tooltip={t('auth.cmdTip')}>
                  <Kbd>pi</Kbd>
                  <span aria-hidden>→</span>
                  <Kbd>/login</Kbd>
                </TooltipText>
              ) : null}
            </>
          )}
        </div>

        {!isKey && accounts.length > 0 ? (
          <SubscriptionAccountList
            provider={p.id === 'openai-codex' ? 'codex' : p.id}
            name={providerName(p)}
            accounts={accounts}
            disabled={busy || codexLogging || !!oauth || !!pendingRemove}
            onSwitch={(account) => void actOnAccount(p.id, account, 'switch')}
            onRemove={(account) => void actOnAccount(p.id, account, 'remove')}
            onRename={p.id === 'openai-codex' ? undefined : (account, label) => void actOnAccount(p.id, account, 'rename', label)}
          />
        ) : null}
        {acceptsKey && (pools[authIdOf(p)]?.length ?? 0) > 0 ? (
          <ApiKeyList provider={authIdOf(p)} keys={pools[authIdOf(p)] ?? []} disabled={busy || editingThis || codexLogging || !!oauth || !!pendingRemove} onDone={keyListDone} />
        ) : null}
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
    <section className="settings-section ms-page" aria-label={text('title')}>
      {msg ? (
        <Notice tone={msg.kind} className="ms-msg">
          {msg.text}
        </Notice>
      ) : null}

      <SettingsGroup
        title={text('title')}
        description={
          <>
            <span className="settings-row__line">{t('auth.summary', { ready: readyCount, total: authProviders.length })}</span>
            <span className="ms-safety settings-row__line" data-testid="ms-file-info">
              <span className="ms-safety-lead">{t('auth.safety')}</span>
              {fileInfo ? (
                <span className="ms-file">
                  <span className="ms-file-sep" aria-hidden="true">{' \u00b7 '}</span>
                  <Button
                    variant="plain"
                    size="micro"
                    className="ms-file-link"
                    tooltip={<span className="ms-file-tip">{fileInfo.path}</span>}
                    aria-expanded={showPath}
                    data-testid="ms-file-link"
                    onPress={() => setShowPath((v) => !v)}
                  >
                    {text('credentialFile')}
                  </Button>
                  <span className="ms-file-count">
                    {' · '}
                    {fileInfo.exists ? t(fileInfo.count === 1 ? 'auth.entry' : 'auth.entries', { n: fileInfo.count }) : t('auth.noFile')}
                  </span>
                </span>
              ) : null}
            </span>
            {fileInfo && showPath ? (
              <span className="ms-file-path settings-row__line" data-testid="ms-file-path">{fileInfo.path}</span>
            ) : null}
          </>
        }
        actions={
          <Button
            variant="secondary"
            isDisabled={checking}
            data-testid="ms-recheck"
            data-setting-id="models-recheck"
            onPress={() => void recheck()}
          >
            {checking ? <Spinner label={t('auth.checking')} /> : null}
            {checking ? t('auth.checking') : t('auth.recheck')}
          </Button>
        }
        testId="ms-services"
        plain
      >
        {authProviders.length === 0 ? <EmptyState size="sm" align="start" inset="none" title={text('noAuthInfo')} /> : null}
      </SettingsGroup>

      {subscriptions.length > 0 ? (
        <SettingsGroup title={t('auth.subs')} settingId="models-subscriptions" className="ms-group" plain>
          <div className="settings-rows ms-rows">{subscriptions.map(serviceRow)}</div>
        </SettingsGroup>
      ) : null}

      {keys.length > 0 ? (
        <SettingsGroup title={t('auth.keys')} settingId="models-api-keys" className="ms-group" plain>
          <div className="settings-rows ms-rows">
            {readyKeys.map(serviceRow)}
            {otherKeys.length > 0 ? (
              <>
                <SettingsReveal open={showAllKeys}>{otherKeys.map(serviceRow)}</SettingsReveal>
                <div className="ms-rows-foot">
                  <Button
                    variant="ghost"
                    aria-expanded={showAllKeys}
                    icon={<CollapsibleChevron expanded={showAllKeys} />}
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
        </SettingsGroup>
      ) : null}

      <CustomEndpointSettings />

      <ModelVisibilityGroup />

      <SettingsGroup title={labels.groupModelsIntegrations} className="ms-group" plain>
        <div className="settings-rows ms-rows">
          <div data-setting-id="models-claude-code">
            <ClaudeCodeBridgeRow />
          </div>
        </div>
      </SettingsGroup>

      <PiThinkingLevelsGroup />

      {pendingRemove ? (
        <ConfirmDialog
          overlayClassName="settings-confirm-overlay"
          isOpen
          onOpenChange={(open) => {
            if (!open) setPendingRemove(null)
          }}
          title={text('removeTitle')}
          description={
            accountsOf(pendingRemove).length > 0
              ? text('removeBodyAccounts').replace('{n}', String(accountsOf(pendingRemove).length)).replace('{keys}', String(pools[authIdOf(pendingRemove)]?.length ?? 0))
              : (pools[authIdOf(pendingRemove)]?.length ?? 0) >= 2
                ? text('removeBodyMany').replace('{n}', String(pools[authIdOf(pendingRemove)]?.length ?? 0))
                : text('removeBody')
          }
          tone="danger"
          cancelLabel={t('ui.cancel')}
          confirmLabel={text('removeConfirm')}
          confirmTestId="ms-remove-confirm"
          isConfirmDisabled={busy}
          closeOnConfirm={false}
          onConfirm={() => void confirmRemove(pendingRemove)}
        >
          <p className="settings-confirm-target">{providerName(pendingRemove)}</p>
        </ConfirmDialog>
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
          <Button variant="secondary" onPress={() => copy(device.userCode)}>
            {t('auth.copyCode')}
          </Button>
          {device.url ? (
            <Button variant="primary" onPress={() => void window.yan.browser.openExternal(device.url)}>
              {t('auth.openVerify')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {authUrl && !device ? (
        <div className="ms-oauth-row">
          <span>{t('auth.browserOpened')}</span>
          <Button variant="secondary" onPress={() => void window.yan.browser.openExternal(authUrl.url)}>
            {t('auth.openAgain')}
          </Button>
          <Button variant="secondary" onPress={() => copy(authUrl.url)}>
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
                <Button key={o.id} variant="secondary" onPress={() => reply(o.id)}>
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
              <Button variant="secondary" type="submit">
                {t('auth.submit')}
              </Button>
            </form>
          )}
        </div>
      ) : null}
    </div>
  )
}
