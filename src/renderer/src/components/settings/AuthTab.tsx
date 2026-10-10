import { ClaudeSubscriptionSection } from './ClaudeSubscriptionSection'
import { useEffect, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { refreshModelsAfterRestart } from '../../state/refresh-models'
import { useStore } from '../../state/store'
import type { AuthProviderInfo, OAuthLoginEvent } from '../../../../shared/ipc'
import { CustomProviderForm } from './CustomProviderForm'
import { Button, Disclosure, Input, SettingGroup, SettingRow, Spinner } from '../ui'

/**
 * 「接入」设置页 —— 模型凭证管理。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两条路（pi 的实际机制，读 docs/providers.md + 验证过）
 * ══════════════════════════════════════════════════════════════════
 * **① API key**：填在下面，写进 `~/.pi/agent/auth.json`。
 *    解析顺序是 `auth.json` 优先于环境变量。
 *
 * **② 订阅制**（ChatGPT Plus/Pro、Claude Pro/Max、GitHub Copilot、
 *    xAI、OpenRouter、Radius）：走 OAuth，token 也落在 auth.json。
 *    pi 的 RPC 里没有 login 命令，所以登录在宿主里跑：
 *    ChatGPT 走 src/main/oauth.ts；Claude Pro/Max、Copilot、xAI、OpenRouter
 *    由 src/main/oauth-providers.ts 加载随包 pi 自己的登录模块。
 *    过程中要用户做的事（浏览器授权、输入验证码、粘贴回调地址、填企业域名）
 *    显示在该行下面的登录面板里。登录模块缺失（换了外部 pi）时才退回 `pi → /login`。
 *    这一步只做一次，之后 token 自动续期。
 */
export function AuthTab() {
  const t = useT()
  const providerName = (p: AuthProviderInfo): string => {
    const names: Record<string, MessageKey> = { anthropic: 'auth.anthropicMetered', xai: 'auth.name.xai', 'zai-coding-cn': 'auth.name.zai', 'minimax-cn': 'auth.name.minimax', 'qwen-token-plan-cn': 'auth.name.qwen', 'xai-api': 'auth.name.xaiApi', 'openrouter-key': 'auth.name.openrouterApi' }
    return names[p.id] ? t(names[p.id]) : p.name
  }
  const providerHint = (p: AuthProviderInfo): string => {
    const hints: Record<string, MessageKey> = { 'openai-codex': 'auth.hint.codex', anthropic: 'auth.hint.anthropic', 'github-copilot': 'auth.hint.copilot', openrouter: 'auth.hint.openrouter', commandcode: 'auth.hint.commandcode', 'xai-api': 'auth.hint.xaiApi' }
    return hints[p.id] ? t(hints[p.id]) : p.hint
  }
  const [list, setList] = useState<AuthProviderInfo[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [info, setInfo] = useState<{ path: string; exists: boolean; count: number } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  /** 应用内 OAuth 进行中（要等用户在浏览器里点完，可能几十秒）。 */
  const [loggingIn, setLoggingIn] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** 其余订阅的应用内登录：哪一家在登、过程中收到的提示 */
  const [oauth, setOauth] = useState<{ provider: string; events: OAuthLoginEvent[] } | null>(null)
  /** 砚保存的 ChatGPT 账号数；多于一个时提示去「账号额度」切换 */
  const [codexCount, setCodexCount] = useState(0)

  useEffect(
    () =>
      window.yan.onOAuthEvent((ev) =>
        setOauth((cur) => (cur && cur.provider === ev.provider ? { ...cur, events: [...cur.events, ev] } : cur))
      ),
    []
  )

  const loginSubscription = async (provider: string): Promise<void> => {
    setOauth({ provider, events: [] })
    setMsg(null)
    try {
      const r = await window.yan.oauthLogin(provider)
      if (r.ok) {
        setMsg({ kind: 'ok', text: t('auth.loginOkGeneric') })
        await load(false)
        await load(true)
      } else if (!r.cancelled) {
        setMsg({ kind: 'err', text: r.error ?? t('auth.loginFail') })
      }
    } finally {
      setOauth(null)
    }
  }

  const load = async (deep: boolean): Promise<void> => {
    if (deep) setChecking(true)
    try {
      const [providers, fileInfo, codexAccounts] = await Promise.all([
        window.yan.authProviders(deep),
        window.yan.authFileInfo(),
        window.yan.codexAccounts().catch(() => [])
      ])
      setList(providers)
      setInfo(fileInfo)
      setCodexCount(codexAccounts.length)
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void load(false)
  }, [])

  const save = async (): Promise<void> => {
    if (!editing || !draft.trim()) return
    setBusy(true)
    const r = await window.yan.setApiKey(editing, draft)
    setBusy(false)
    if (r.ok) {
      setMsg({ kind: 'ok', text: t('auth.saved') })
      refreshModelsAfterRestart()
      setEditing(null)
      setDraft('')
      await load(false)
    } else {
      setMsg({ kind: 'err', text: r.error ?? t('auth.saveFailed') })
    }
  }

  const signOut = async (id: string): Promise<void> => {
    setBusy(true)
    const r = await window.yan.clearAuth(id)
    setBusy(false)
    if (r.ok) {
      setMsg({ kind: 'ok', text: t('auth.cleared') })
      refreshModelsAfterRestart()
      await load(false)
    }
  }

  /**
   * 应用内登录 ChatGPT 订阅（Codex）。
   *
   * 为什么能这么做：这一家的 OAuth 参数（client_id / 端点 / 回调节点）可以从
   * 内置 pi 的实现里逐字对齐抄出来，所以桌面端自己就能把流程跑完 ——
   * 不再要求用户去终端跑 `pi → /login`。
   *
   * 这个 await 会**一直等到用户在浏览器里点完**（可能几十秒），所以期间要把
   * 状态显示出来，并给一个取消按钮。
   */
  const loginCodex = async (): Promise<void> => {
    setLoggingIn(true)
    setMsg(null)
    try {
      const r = await window.yan.codexLogin()
      if (r.ok) {
        setMsg({ kind: 'ok', text: t('auth.loginOk') })
        await load(false)
        /* 深查一次：让状态以 pi 自己的判断为准（它会顺手刷新 token） */
        await load(true)
      } else {
        setMsg({ kind: 'err', text: r.error ?? t('auth.loginFail') })
      }
    } finally {
      setLoggingIn(false)
    }
  }

  const subs = (list ?? []).filter((x) => x.kind === 'subscription')
  const keys = (list ?? []).filter((x) => x.kind === 'api_key')
  const readyCount = (list ?? []).filter((x) => x.status === 'ready').length
  /* 已配置的 Key 常显；其余服务商折叠 —— 二十个空行会把真正用到的那几个淹掉 */
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
        {/* 顶部：就绪数 + 重新检测（深查一次，以 pi 自己的判断为准） */}
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

      {/* 插件订阅与按量登录路径明确区分；登录由各 Provider 的协议处理。 */}
      <SettingGroup title={t('auth.subs')}>
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
                      {/* 再登录一个账号：主进程先把当前账号收进列表，之后在「账号额度」里切换 */}
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
      {keys.length > 0 ? (
      <SettingGroup title={t('auth.keys')}>
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


      {/* 自定义 API 服务（真源是 pi 的 models.json） */}
      <SettingGroup title={t('customApi.title')}>
        <CustomProviderForm />
      </SettingGroup>

      {/* 按活动分配模型：低频配置，收在页尾 */}
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

/**
 * 订阅登录进行中：把登录模块要用户做的事摆出来。
 *   · 验证码（Copilot / xAI）：大号显示 + 复制 + 打开验证页
 *   · 授权地址（Claude / OpenRouter）：已自动用浏览器打开；打不开时可再次打开或复制
 *   · 提问：粘贴回调地址、企业域名（文本），或在几个选项里选一个
 * 只显示最新的一条进度；已回答或被登录模块撤回的提问不再显示。
 */
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
