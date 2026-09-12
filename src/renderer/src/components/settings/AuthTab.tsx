import { useEffect, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import type { AuthProviderInfo } from '../../../../shared/ipc'

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
 *    xAI、OpenRouter、Radius）：走 OAuth，token 也落在 auth.json，
 *    但**流程只能由 pi 的交互式 `/login` 发起** ——
 *    RPC 模式没有 login 命令（查过 docs/rpc.md 的 47 个命令，确认没有）。
 *    所以这里**不假装能代劳**：给出命令，让用户在自己终端里跑一次。
 *    这一步只做一次，之后 token 自动续期。
 *
 * ── 为什么不做成「一键弹出终端自动跑」 ──
 * 各平台的终端启动方式差别太大（Windows Terminal / conhost / macOS Terminal
 * / Linux 各种 emulator），而且 OAuth 要用户在浏览器里点授权、
 * 回调地址还得能回连 localhost。自动化的失败模式比手动多。
 * 诚实地给一条命令，比一个时灵时不灵的按钮好。
 */
export function AuthTab() {
  const t = useT()
  const [list, setList] = useState<AuthProviderInfo[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [info, setInfo] = useState<{ path: string; exists: boolean; count: number } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = async (deep: boolean): Promise<void> => {
    if (deep) setChecking(true)
    try {
      const [providers, fileInfo] = await Promise.all([
        window.yan.authProviders(deep),
        window.yan.authFileInfo()
      ])
      setList(providers)
      setInfo(fileInfo)
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
      setEditing(null)
      setDraft('')
      await load(false)
    } else {
      setMsg({ kind: 'err', text: r.error ?? '保存失败' })
    }
  }

  const signOut = async (id: string): Promise<void> => {
    setBusy(true)
    const r = await window.yan.clearAuth(id)
    setBusy(false)
    if (r.ok) {
      setMsg({ kind: 'ok', text: t('auth.cleared') })
      await load(false)
    }
  }

  const subs = (list ?? []).filter((x) => x.kind === 'subscription')
  const keys = (list ?? []).filter((x) => x.kind === 'api_key')
  const readyCount = (list ?? []).filter((x) => x.status === 'ready').length

  return (
    <div className="set-group auth-tab">
      {/* ---- 顶部：状态摘要 ---- */}
      <div className="auth-head">
        <div className="set-label">
          <div className="set-name">{t('auth.title')}</div>
          <div className="set-desc">
            {t('auth.summary', { ready: readyCount, total: (list ?? []).length })}
          </div>
        </div>
        <button className="seg-btn" onClick={() => void load(true)} disabled={checking} data-testid="auth-recheck">
          <Icon name="refresh" size={12} className={checking ? 'spin' : ''} />
          <span>{checking ? t('auth.checking') : t('auth.recheck')}</span>
        </button>
      </div>

      {info ? (
        <div className="auth-path" title={info.path}>
          <Icon name="folder" size={12} />
          <span className="auth-path-label">{t('auth.fileHint')}</span>
          <code>{info.path}</code>
          <span className="auth-path-count">
            {info.exists ? t('auth.entries', { n: info.count }) : t('auth.noFile')}
          </span>
        </div>
      ) : null}

      {msg ? (
        <div className={`auth-msg ${msg.kind}`} data-testid="auth-msg">
          {msg.text}
        </div>
      ) : null}

      {/* ---- 订阅制 ---- */}
      <div className="auth-sec-head">
        <Icon name="shield-check" size={12} />
        <span>{t('auth.subs')}</span>
        <span className="spacer" />
        <span className="auth-sec-note">{t('auth.subsNote')}</span>
      </div>

      {subs.map((p) => (
        <div className="auth-row" key={p.id} data-testid={`auth-row-${p.id}`}>
          <div className="auth-row-main">
            <div className="auth-row-name">
              <span className={`auth-dot ${p.status}`} />
              {p.name}
            </div>
            {p.hint ? <div className="auth-row-hint">{p.hint}</div> : null}
          </div>

          {p.status === 'ready' ? (
            <button className="seg-btn" onClick={() => void signOut(p.id)} disabled={busy}>
              {t('auth.signOut')}
            </button>
          ) : (
            <div className="auth-cmd" title={t('auth.cmdTip')}>
              <code>pi</code>
              <span className="auth-cmd-then">→</span>
              <code>/login</code>
            </div>
          )}
        </div>
      ))}

      {/* ---- API key ---- */}
      <div className="auth-sec-head">
        <Icon name="tag" size={12} />
        <span>{t('auth.keys')}</span>
        <span className="spacer" />
        <span className="auth-sec-note">{t('auth.keysNote')}</span>
      </div>

      {keys.map((p) => (
        <div className="auth-row" key={p.id} data-testid={`auth-row-${p.id}`}>
          <div className="auth-row-main">
            <div className="auth-row-name">
              <span className={`auth-dot ${p.status}`} />
              {p.name}
              {p.status === 'ready' ? <span className="auth-badge">{t('auth.ready')}</span> : null}
            </div>
            {p.envVar ? (
              <div className="auth-row-hint">
                {t('auth.orEnv')} <code>{p.envVar}</code>
              </div>
            ) : null}
          </div>

          {editing === p.id ? (
            <div className="auth-edit">
              <input
                className="auth-input"
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
              <button className="seg-btn sel" onClick={() => void save()} disabled={busy || !draft.trim()}>
                {t('auth.save')}
              </button>
              <button className="seg-btn" onClick={() => setEditing(null)}>
                {t('ui.cancel')}
              </button>
            </div>
          ) : (
            <div className="auth-actions">
              <button
                className="seg-btn"
                onClick={() => {
                  setEditing(p.id)
                  setDraft('')
                  setMsg(null)
                }}
                data-testid={`auth-set-${p.id}`}
              >
                {p.status === 'ready' ? t('auth.replace') : t('auth.setKey')}
              </button>
              {p.status === 'ready' ? (
                <button className="seg-btn" onClick={() => void signOut(p.authKey || p.id)} disabled={busy}>
                  {t('auth.signOut')}
                </button>
              ) : null}
            </div>
          )}
        </div>
      ))}

      <div className="auth-foot">
        <Icon name="alert-circle" size={12} />
        <span>{t('auth.safety')}</span>
      </div>
    </div>
  )
}
