import { ClaudeSubscriptionSection } from './ClaudeSubscriptionSection'
import { useEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { refreshModelsAfterRestart } from '../../state/refresh-models'
import { useStore } from '../../state/store'
import type { AuthProviderInfo, OAuthLoginEvent } from '../../../../shared/ipc'
import { CustomProviderForm } from './CustomProviderForm'
import { Button, Disclosure, Input, SettingGroup, SettingRow, Spinner } from '../ui'
import { SettingsSections } from './SettingsSections'

export function AuthTab() {
  const t = useT()
  const providerName = (p: AuthProviderInfo): string => {
    const names: Record<string, MessageKey> = { anthropic: 'auth.anthropicMetered', xai: 'auth.name.xai', 'zai-coding-cn': 'auth.name.zai', 'minimax-cn': 'auth.name.minimax', 'qwen-token-plan-cn': 'auth.name.qwen', 'xai-api': 'auth.name.xaiApi', 'openrouter-key': 'auth.name.openrouterApi', 'volcengine-ark': 'auth.name.ark' }
    return names[p.id] ? t(names[p.id]) : p.name
  }
  const providerHint = (p: AuthProviderInfo): string => {
    const hints: Record<string, MessageKey> = { 'openai-codex': 'auth.hint.codex', anthropic: 'auth.hint.anthropic', 'github-copilot': 'auth.hint.copilot', openrouter: 'auth.hint.openrouter', commandcode: 'auth.hint.commandcode', 'xai-api': 'auth.hint.xaiApi' }
    return hints[p.id] ? t(hints[p.id]) : ''
  }
  const [list, setList] = useState<AuthProviderInfo[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [info, setInfo] = useState<{ path: string; exists: boolean; count: number } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [oauth, setOauth] = useState<{ provider: string; events: OAuthLoginEvent[] } | null>(null)
  const [codexCount, setCodexCount] = useState(0)
  const alive = useRef(true)
  const loadGeneration = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; loadGeneration.current++ } }, [])

  useEffect(
    () =>
      window.yan.onOAuthEvent((ev) =>
        setOauth((cur) => (cur && cur.provider === ev.provider ? { ...cur, events: [...cur.events, ev] } : cur))
      ),
    []
  )

  const loginSubscription = async (provider: string): Promise<void> => {
    if (!alive.current) return
    setOauth({ provider, events: [] })
    setMsg(null)
    try {
      const r = await window.yan.oauthLogin(provider)
      if (!alive.current) return
      if (r.ok) {
        setMsg({ kind: 'ok', text: t('auth.loginOkGeneric') })
        await load(false)
        await load(true)
      } else if (!r.cancelled) {
        setMsg({ kind: 'err', text: r.error ?? t('auth.loginFail') })
      }
    } catch (error) {
      if (alive.current) setMsg({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
    } finally {
      if (alive.current) setOauth(null)
    }
  }

  const load = async (deep: boolean): Promise<void> => {
    const generation = ++loadGeneration.current
    if (deep && alive.current) setChecking(true)
    try {
      const [providers, fileInfo, codexAccounts] = await Promise.all([
        window.yan.authProviders(deep),
        window.yan.authFileInfo(),
        window.yan.codexAccounts().catch(() => [])
      ])
      if (!alive.current || generation !== loadGeneration.current) return
      setList(providers)
      setInfo(fileInfo)
      setCodexCount(codexAccounts.length)
      setMsg((current) => current?.kind === 'err' ? null : current)
    } catch (error) {
      if (alive.current && generation === loadGeneration.current) setMsg({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
    } finally {
      if (alive.current && generation === loadGeneration.current) setChecking(false)
    }
  }

  useEffect(() => {
    void load(false)
  }, [])

  const save = async (): Promise<void> => {
    if (!editing || !draft.trim()) return
    setBusy(true)
    try {
    const r = await window.yan.setApiKey(editing, draft)
    if (r.ok) {
      setMsg({ kind: 'ok', text: t('auth.saved') })
      refreshModelsAfterRestart()
      setEditing(null)
      setDraft('')
      await load(false)
    } else {
      setMsg({ kind: 'err', text: r.error ?? t('auth.saveFailed') })
    }
    } catch (error) {
      setMsg({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
    } finally { setBusy(false) }
  }

  const signOut = async (id: string): Promise<void> => {
    setBusy(true)
    try {
    const r = await window.yan.clearAuth(id)
    if (r.ok) {
      setMsg({ kind: 'ok', text: t('auth.cleared') })
      refreshModelsAfterRestart()
      await load(false)
    } else setMsg({ kind: 'err', text: r.error ?? t('auth.saveFailed') })
    } catch (error) {
      setMsg({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
    } finally { setBusy(false) }
  }

  const loginCodex = async (): Promise<void> => {
    if (!alive.current) return
    setLoggingIn(true)
    setMsg(null)
    try {
      const r = await window.yan.codexLogin()
      if (!alive.current) return
      if (r.ok) {
        setMsg({ kind: 'ok', text: t('auth.loginOk') })
        await load(false)
        await load(true)
      } else {
        setMsg({ kind: 'err', text: r.error ?? t('auth.loginFail') })
      }
    } catch (error) {
      if (alive.current) setMsg({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
    } finally {
      if (alive.current) setLoggingIn(false)
    }
  }

  const subs = (list ?? []).filter((x) => x.kind === 'subscription')
  const keys = (list ?? []).filter((x) => x.kind === 'api_key')
  const readyCount = (list ?? []).filter((x) => x.status === 'ready').length
  const keysReady = keys.filter((x) => x.status === 'ready' || editing === x.id)
  const keysOther = keys.filter((x) => x.status !== 'ready' && editing !== x.id)

  const keyRow = (p: AuthProviderInfo): React.ReactNode => (
    <div className="auth-row" key={p.id} data-testid={`auth-row-${p.id}`}>
      <div className="auth-row-main">
        <div className="auth-row-name">
          <span className={`auth-dot ${p.status}`} />
          {providerName(p)}
        </div>
        {p.envVar ? <div className="auth-row-hint">{t('auth.orEnv')} <code>{p.envVar}</code></div> : null}
      </div>

      {editing === p.id ? (
        <div className="auth-edit">
          <input
            className="ui-input auth-input"
            type="password"
            autoFocus
            value={draft}
            placeholder={t('auth.pasteKey')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void save()
              }
              if (e.key === 'Escape') setEditing(null)
            }}
            data-testid={`auth-input-${p.id}`}
          />
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy || !draft.trim()}>
            {t('auth.save')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
            {t('ui.cancel')}
          </Button>
        </div>
      ) : (
        <div className="auth-actions">
          {p.status === 'ready' ? (
            <Button size="sm" variant="ghost" onClick={() => void signOut(p.authKey || p.id)} disabled={busy}>
              {t('auth.signOut')}
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => {
              setEditing(p.id)
              setDraft('')
              setMsg(null)
            }}
            data-testid={`auth-set-${p.id}`}
          >
            {p.status === 'ready' ? t('auth.replace') : t('auth.setKey')}
          </Button>
        </div>
      )}
    </div>
  )

  return (
    <>
      <div className="ui-rows auth-page">
        <SettingRow name={t('auth.summary', { ready: readyCount, total: (list ?? []).length })} desc={t('auth.safety')}>
          <Button size="sm" onClick={() => void load(true)} disabled={checking} data-testid="auth-recheck">
            {checking ? <Spinner mute /> : null}
            <span>{checking ? t('auth.checking') : t('auth.recheck')}</span>
          </Button>
        </SettingRow>

        {msg ? (
          <div className={`auth-msg ${msg.kind}`} data-testid="auth-msg">
            {msg.text}
          </div>
        ) : null}
      </div>

      <SettingsSections sections={[
        { id: 'subscriptions', label: t('auth.subs'), content: <>
      <SettingGroup>
        <ClaudeSubscriptionSection />
        <div className="ui-rows">
          {subs.map((p) => (
            <div className="auth-row" key={p.id} data-testid={`auth-row-${p.id}`}>
              <div className="auth-row-main">
                <div className="auth-row-name">
                  <span className={`auth-dot ${p.status}`} />
                  {providerName(p)}
                </div>
                {providerHint(p) ? <div className="auth-row-hint">{providerHint(p)}</div> : null}
              </div>

              {p.status === 'ready' && p.id === 'openai-codex' ? (
                <div className="auth-actions">
                  {loggingIn ? (
                    <>
                      <span className="auth-waiting" data-testid="auth-login-waiting">
                        <Spinner mute />
                        <span>{t('auth.loginWaiting')}</span>
                      </span>
                      <Button size="sm" variant="ghost" data-testid="auth-login-cancel" onClick={() => void window.yan.codexLoginCancel()}>
                        {t('ui.cancel')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" data-testid="auth-add-account" disabled={busy || !!oauth} onClick={() => void loginCodex()}>
                        {t('auth.addAccount')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void signOut(p.id)} disabled={busy || !!oauth}>
                        {t('auth.signOut')}
                      </Button>
                    </>
                  )}
                </div>
              ) : p.status === 'ready' ? (
                <Button size="sm" variant="ghost" onClick={() => void signOut(p.id)} disabled={busy || loggingIn || !!oauth}>
                  {t('auth.signOut')}
                </Button>
              ) : p.inAppLogin && p.id !== 'openai-codex' ? (
                <div className="auth-actions">
                  {oauth?.provider === p.id ? (
                    <Button size="sm" variant="ghost" data-testid="auth-login-cancel" onClick={() => void window.yan.oauthLoginCancel(p.id)}>
                      {t('ui.cancel')}
                    </Button>
                  ) : (
                    <Button size="sm" data-testid={`auth-login-${p.id}`} disabled={busy || loggingIn || !!oauth} onClick={() => void loginSubscription(p.id)}>
                      {t('auth.loginInApp')}
                    </Button>
                  )}
                </div>
              ) : p.inAppLogin ? (
                <div className="auth-actions">
                  {loggingIn ? (
                    <>
                      <span className="auth-waiting" data-testid="auth-login-waiting">
                        <Spinner mute />
                        <span>{t('auth.loginWaiting')}</span>
                      </span>
                      <Button size="sm" variant="ghost" data-testid="auth-login-cancel" onClick={() => void window.yan.codexLoginCancel()}>
                        {t('ui.cancel')}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" data-testid={`auth-login-${p.id}`} disabled={busy || !!oauth} onClick={() => void loginCodex()}>
                      {t('auth.loginInApp')}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="auth-cmd" title={t('auth.cmdTip')}>
                  <code>pi</code>
                  <span className="auth-cmd-then">→</span>
                  <code>/login</code>
                </div>
              )}
              {oauth?.provider === p.id ? <SubscriptionLoginPanel provider={p.id} events={oauth.events} /> : null}
              {p.id === 'openai-codex' && codexCount > 1 ? (
                <div className="auth-row-hint" data-testid="auth-codex-accounts">
                  {t('acct.savedCount', { n: codexCount })}{' '}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      useStore.getState().closeSettings()
                      window.dispatchEvent(new CustomEvent('inkstone-workspace-launch', { detail: 'accounts' }))
                    }}
                  >
                    {t('acct.manage')}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </SettingGroup>
        </> },
        { id: 'api-keys', label: t('auth.keys'), content: <>
      {keys.length > 0 ? (
      <SettingGroup>
        <div className="ui-rows">
          {keysReady.map(keyRow)}
          {keysOther.length > 0 ? (
            <Disclosure title={keysReady.length ? t('auth.moreProviders', { n: keysOther.length }) : t('auth.allProviders', { n: keysOther.length })} testId="auth-more-keys">
              <div className="ui-rows">{keysOther.map(keyRow)}</div>
            </Disclosure>
          ) : null}
        </div>
      </SettingGroup>
      ) : null}


        </> },
        { id: 'custom-api', label: t('customApi.title'), content: <CustomProviderForm /> }
      ]} />

      <SettingGroup>
        {info ? (
          <Disclosure title={t('auth.fileHint')}>
            <div className="set-diag">
              <div className="set-diag-line">
                <span className="set-diag-k">{t('set.piPath')}</span>
                <span className="set-diag-v set-path" title={info.path}>{info.path}</span>
              </div>
              <div className="set-diag-line">
                <span className="set-diag-k">{t('auth.entriesLabel')}</span>
                <span className="set-diag-v">{info.exists ? t('auth.entries', { n: info.count }) : t('auth.noFile')}</span>
              </div>
            </div>
          </Disclosure>
        ) : null}
      </SettingGroup>
    </>
  )
}

function SubscriptionLoginPanel({ provider, events }: { provider: string; events: OAuthLoginEvent[] }) {
  const t = useT()
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
  const reply = (value: string): void => {
    if (!prompt) return
    setSent((cur) => [...cur, prompt.promptId])
    setAnswer('')
    void window.yan.oauthLoginAnswer(provider, prompt.promptId, value)
  }
  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => undefined)
  }
  return (
    <div className="auth-login-panel" data-testid={`auth-login-panel-${provider}`}>
      <div className="auth-login-status">
        <Spinner mute />
        <span>{progress?.message || (device ? t('auth.deviceWaiting') : t('auth.loginWaiting'))}</span>
      </div>
      {device ? (
        <div className="auth-login-device">
          <span className="auth-login-code" data-testid="auth-device-code">{device.userCode}</span>
          <Button size="sm" onClick={() => copy(device.userCode)}>{t('auth.copyCode')}</Button>
          {device.url ? (
            <Button size="sm" variant="primary" onClick={() => void window.yan.browser.openExternal(device.url)}>
              {t('auth.openVerify')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {authUrl && !device ? (
        <div className="auth-login-url">
          <span>{t('auth.browserOpened')}</span>
          <Button size="sm" variant="ghost" onClick={() => void window.yan.browser.openExternal(authUrl.url)}>
            {t('auth.openAgain')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => copy(authUrl.url)}>{t('auth.copyLink')}</Button>
        </div>
      ) : null}
      {prompt ? (
        <div className="auth-login-prompt">
          <div>{prompt.message}</div>
          {prompt.kind === 'select' && prompt.options?.length ? (
            <div className="auth-login-options">
              {prompt.options.map((o) => (
                <Button key={o.id} size="sm" onClick={() => reply(o.id)}>{o.label}</Button>
              ))}
            </div>
          ) : (
            <form
              className="auth-login-form"
              onSubmit={(e) => {
                e.preventDefault()
                reply(answer)
              }}
            >
              <Input value={answer} placeholder={prompt.placeholder} onChange={(e) => setAnswer(e.target.value)} autoFocus />
              <Button size="sm" type="submit">{t('auth.submit')}</Button>
            </form>
          )}
          {prompt.kind === 'manual_code' ? <div className="auth-row-hint">{t('auth.manualCodeHint')}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
