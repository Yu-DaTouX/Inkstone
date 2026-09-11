import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons/Icon'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { prefersReducedMotion, usePresence } from '../lib/usePresence'
import { MemorySections } from './MemoryPanel'

export type SettingsTab = 'memory' | 'appearance' | 'status' | 'about'

/**
 * 设置面板。
 *
 * 为什么把「记忆」从常驻右栏搬进来：记忆是**偶尔翻看**的东西，
 * 占着 328px 常驻不值得 —— 撤掉后消息流宽了，记忆也没丢，
 * 只是从「一直在那」变成「需要时打开」。
 *
 * 而「状态」（模型 / 上下文用量 / 花费）是**边聊边看**的，
 * 所以它同时以紧凑形式留在输入区（见 ContextBar），不只是躺在这里。
 */
export function Settings({
  open,
  tab,
  onClose,
  onTabChange
}: {
  open: boolean
  tab: SettingsTab
  onClose: () => void
  onTabChange: (t: SettingsTab) => void
}) {
  const t = useT()
  const { lang, setLang } = useI18n()
  const scrim = useRef<HTMLDivElement>(null)
  // 退场：面板体量大，进度比其他浮层长一点
  const presence = usePresence(open, prefersReducedMotion() ? 1 : 110)

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!presence.mounted) return null

  const tabs: { id: SettingsTab; label: string; icon: string }[] = [
    { id: 'memory', label: t('set.memory'), icon: 'layers' },
    { id: 'appearance', label: t('set.appearance'), icon: 'moon' },
    { id: 'status', label: t('set.status'), icon: 'activity' },
    { id: 'about', label: t('set.about'), icon: 'shield-check' }
  ]

  return (
    <div
      className={`settings-scrim ${presence.closing ? 'closing' : ''}`}
      ref={scrim}
      onMouseDown={(e) => {
        if (e.target === scrim.current) onClose()
      }}
    >
      <div
        className={`settings ${presence.closing ? 'closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('set.title')}
      >
        {/* 左：导航 */}
        <nav className="settings-nav">
          <div className="settings-nav-title">{t('set.title')}</div>
          {tabs.map((x, i) => (
            <button
              key={x.id}
              className={`settings-tab ${tab === x.id ? 'sel' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              onClick={() => onTabChange(x.id)}
            >
              <Icon name={x.icon as never} size={12} />
              <span>{x.label}</span>
            </button>
          ))}
          <span className="spacer" />
          <button className="settings-tab" onClick={onClose}>
            <Icon name="chevron-right" size={12} className="chev-flip" />
            <span>{t('set.close')}</span>
          </button>
        </nav>

        {/* 右：内容。key 跟着 tab 走 —— 切 tab 时新节点会重演一次淡入 */}
        <div className="settings-body" key={tab}>
          {tab === 'memory' ? (
            <MemorySections />
          ) : tab === 'appearance' ? (
            <AppearanceTab lang={lang} setLang={setLang} />
          ) : tab === 'status' ? (
            <StatusTab />
          ) : (
            <AboutTab />
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- 外观 */

function AppearanceTab({ lang, setLang }: { lang: string; setLang: (l: 'zh-CN' | 'en-US') => void }) {
  const t = useT()
  const theme = useStore((s) => s.settings?.theme) ?? 'dark'
  const setTheme = useThemeSetter()
  const onTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  )
  return (
    <div className="set-group">
      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.theme')}</div>
          <div className="set-desc">{t('set.themeDesc')}</div>
        </div>
        <div className="set-ctl seg">
          {(['dark', 'light'] as const).map((x) => (
            <button
              key={x}
              className={`seg-btn ${theme === x ? 'sel' : ''}`}
              onClick={() => setTheme(x)}
            >
              <Icon name={x === 'dark' ? 'moon' : 'sun'} size={12} />
              <span>{x === 'dark' ? t('set.dark') : t('set.light')}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.lang')}</div>
          <div className="set-desc">{t('set.langDesc')}</div>
        </div>
        <div className="set-ctl seg">
          {(['zh-CN', 'en-US'] as const).map((x) => (
            <button
              key={x}
              className={`seg-btn ${lang === x ? 'sel' : ''}`}
              onClick={() => setLang(x)}
            >
              {x === 'zh-CN' ? '中文' : 'English'}
            </button>
          ))}
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.alwaysOnTop')}</div>
          <div className="set-desc">{t('set.alwaysOnTopDesc')}</div>
        </div>
        <div className="set-ctl">
          {/* 与标题栏那个置顶按钮是同一个状态（store.alwaysOnTop），
              两处都能切，显示以主进程推的真实值为准 */}
          <button
            className={`seg-btn ${onTop ? 'sel' : ''}`}
            onClick={() => void toggleAlwaysOnTop()}
            data-testid="set-always-on-top"
            data-on={onTop ? '1' : '0'}
          >
            <Icon name="pin" size={12} />
            <span>{onTop ? t('set.on') : t('set.off')}</span>
          </button>
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.reduceMotion')}</div>
          <div className="set-desc">{t('set.reduceMotionDesc')}</div>
        </div>
        <div className="set-ctl">
          <span className="set-static">{reduced ? t('set.on') : t('set.off')}</span>
        </div>
      </div>
    </div>
  )
}

/** 主题存在 App 的 state + 主进程设置里；这里通过事件让 App 处理 */
function useThemeSetter(): (t: 'dark' | 'light') => void {
  return (next) => {
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('yan.theme', next)
    } catch {
      /* 忽略 */
    }
    void window.yan.patchSettings({ theme: next })
    // 让 App 的 state 跟上（它监听 localStorage 不可靠，直接派事件）
    window.dispatchEvent(new CustomEvent('yan:theme', { detail: next }))
  }
}

/* ------------------------------------------------------------- 状态 */

function StatusTab() {
  const t = useT()
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const models = useStore((s) => s.models)
  const thinkingLevels = useStore((s) => s.thinkingLevels)
  const setModel = useStore((s) => s.setModel)
  const setThinking = useStore((s) => s.setThinking)
  const compact = useStore((s) => s.compact)
  const setAutoCompaction = useStore((s) => s.setAutoCompaction)
  const setAutoRetry = useStore((s) => s.setAutoRetry)

  const byProvider = new Map<string, typeof models>()
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? []
    list.push(m)
    byProvider.set(m.provider, list)
  }

  const cu = stats?.contextUsage
  const used = cu?.tokens ?? 0
  const win = cu?.contextWindow ?? session?.model?.contextWindow ?? 0
  const pct = cu?.percent ?? (used && win ? (used / win) * 100 : 0)
  const busy = !!session?.isStreaming || !!session?.isCompacting
  const nf = new Intl.NumberFormat('en-US')

  return (
    <div className="set-group">
      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('mem.model')}</div>
          <div className="set-desc">{t('set.modelDesc')}</div>
        </div>
        <div className="set-ctl">
          <select
            className="pick"
            value={session?.model ? `${session.model.provider}|${session.model.id}` : ''}
            disabled={busy || models.length === 0}
            onChange={(e) => {
              const [provider, id] = e.target.value.split('|')
              if (provider && id) void setModel(provider, id)
            }}
          >
            {models.length === 0 ? <option value="">{t('status.noModels')}</option> : null}
            {[...byProvider.entries()].map(([provider, list]) => (
              <optgroup key={provider} label={provider}>
                {list.map((m) => (
                  <option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>
                    {m.name}
                    {m.reasoning ? ' · reasoning' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('mem.thinking')}</div>
          <div className="set-desc">{t('set.thinkingDesc')}</div>
        </div>
        <div className="set-ctl">
          <select
            className="pick"
            value={session?.thinkingLevel ?? 'off'}
            disabled={busy || thinkingLevels.length === 0}
            onChange={(e) => void setThinking(e.target.value)}
          >
            {(thinkingLevels.length ? thinkingLevels : ['off']).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="set-row col">
        <div className="set-label">
          <div className="set-name">{t('status.context')}</div>
          <div className="set-desc">
            {nf.format(used)} / {win ? nf.format(win) : '—'} · {win ? pct.toFixed(1) : '—'}%
          </div>
        </div>
        <div className="meter">
          <i style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <div className="usage-line">
          <span>
            <b>{t('status.tools')}</b> {stats?.toolCalls ?? 0}
          </span>
          <span>
            <b>{t('mem.cost')}</b> ${(stats?.cost ?? 0).toFixed(3)}
          </span>
          <span>
            <b>{t('status.rounds')}</b> {stats?.userMessages ?? 0}
          </span>
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('status.compact')}</div>
          <div className="set-desc">{t('set.compactDesc')}</div>
        </div>
        <div className="set-ctl">
          <button className="btn" onClick={() => void compact()} disabled={busy}>
            <Icon
              name={session?.isCompacting ? 'refresh' : 'layers'}
              size={12}
              className={session?.isCompacting ? 'spin' : undefined}
            />
            <span>{session?.isCompacting ? t('status.compacting') : t('status.compact')}</span>
          </button>
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('status.autoCompact')}</div>
          <div className="set-desc">{t('status.autoCompactHint')}</div>
        </div>
        <div className="set-ctl">
          <Toggle on={session?.autoCompactionEnabled ?? true} onChange={(v) => void setAutoCompaction(v)} />
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('status.autoRetry')}</div>
          <div className="set-desc">{t('status.autoRetryHint')}</div>
        </div>
        <div className="set-ctl">
          <Toggle on={autoRetryHeld.value} onChange={(v) => {
            autoRetryHeld.value = v
            void setAutoRetry(v)
          }} />
        </div>
      </div>
    </div>
  )
}

/** pi 的 get_state 不返回 autoRetry 状态，只能客户端自己记 */
const autoRetryHeld = { value: true }

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`switch-pill ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="switch-knob" />
    </button>
  )
}

/* ------------------------------------------------------------- 关于 */

function AboutTab() {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const session = useStore((s) => s.session)
  const conn = useStore((s) => s.conn)
  const logs = useStore((s) => s.logs)
  const changeCwd = useStore((s) => s.changeCwd)
  const [probe, setProbe] = useState<{ cmd: string; args: string[]; error?: string } | null>(null)

  useEffect(() => {
    void window.yan.probePi().then((p) => setProbe({ cmd: p.cmd, args: p.args, error: p.error }))
  }, [])

  const pickCwd = async (): Promise<void> => {
    const p = await window.yan.pickCwd()
    if (p) await changeCwd(p)
  }

  return (
    <div className="set-group">
      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('tb.cwd')}</div>
          <div className="set-desc set-path" title={settings?.cwd}>
            {settings?.cwd ?? '—'}
          </div>
        </div>
        <div className="set-ctl">
          <button className="btn" onClick={() => void pickCwd()}>
            {t('set.change')}
          </button>
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.conn')}</div>
          <div className="set-desc">
            {conn === 'ready' ? t('conn.ready') : conn === 'starting' ? t('conn.starting') : t('conn.down')}
          </div>
        </div>
      </div>

      <div className="set-row col">
        <div className="set-label">
          <div className="set-name">{t('set.piBin')}</div>
          <div className="set-desc set-path" title={probe ? [probe.cmd, ...probe.args].join(' ') : ''}>
            {probe ? [probe.cmd, ...probe.args].join(' ') : '—'}
          </div>
        </div>
        {probe?.error ? <div className="set-warn">{probe.error}</div> : null}
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('status.session')}</div>
          <div className="set-desc set-path">{session?.sessionId ?? '—'}</div>
        </div>
      </div>

      {logs.length > 0 ? (
        <div className="set-row col">
          <div className="set-label">
            <div className="set-name">{t('log.title')}</div>
            <div className="set-desc">{t('set.logsDesc', { n: logs.length })}</div>
          </div>
          <pre className="set-logs">{logs.slice(-20).join('\n')}</pre>
        </div>
      ) : null}
    </div>
  )
}
