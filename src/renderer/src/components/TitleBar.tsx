import { Icon } from '../icons/Icon'
import { useI18n } from '../i18n'
import type { ConnState } from '../state/store'

export type Theme = 'dark' | 'light'

interface Props {
  theme: Theme
  onToggleTheme: () => void
  onToggleRail: () => void
  /** 左栏是否被钉住（不自动收回） */
  railPinned?: boolean
  /** 左栏当前是否可见（钉住或鼠标悬停） */
  railOpen?: boolean
  onSettings: () => void
  /** 当前会话标题 */
  subtitle?: string
  conn: ConnState
  cwd?: string
  onPickCwd: () => void
}

/**
 * 标题栏。
 *
 * 它同时是 Electron 的原生标题栏（frame:false + electron.css 里的拖拽区），
 * 所以那三个圆点不是装饰 —— 它们就是 关闭 / 最小化 / 最大化。
 *
 * ⚠️ 与原设计稿的差异：中间原来写的是「记忆已同步 · 桌面 · 笔记本 · 手机」，
 * 那是设计稿的虚构状态。接上真 pi 之后这里改成**连接状态 + 工作目录** ——
 * 真实的、用户需要一直看得见的两件事。跨设备同步没有实现，就不该显示。
 */
export function TitleBar({
  theme,
  onToggleTheme,
  onToggleRail,
  railPinned,
  railOpen,
  onSettings,
  subtitle,
  conn,
  cwd,
  onPickCwd
}: Props) {
  const { t, toggleLang } = useI18n()
  const win = window.yan.win

  const dotCls = conn === 'ready' ? 'dot ok' : conn === 'starting' ? 'dot warn' : 'dot err'
  const connText =
    conn === 'ready'
      ? t('conn.ready')
      : conn === 'starting'
        ? t('conn.starting')
        : conn === 'error'
          ? t('conn.error')
          : t('conn.down')

  return (
    <header className="titlebar">
      <div className="tb-left">
        <div className="tb-dots">
          <button className="tb-dot r" title={t('tb.close')} onClick={() => win.close()} />
          <button className="tb-dot y" title={t('tb.minimize')} onClick={() => win.minimize()} />
          <button className="tb-dot g" title={t('tb.maximize')} onClick={() => win.maximize()} />
        </div>
        <span className="tb-name">砚</span>
        {subtitle ? (
          <span className="tb-badge tb-session" title={subtitle}>
            {subtitle}
          </span>
        ) : null}
        <button
          className={`btn icon ${railPinned ? 'on' : ''}`}
          title={railPinned ? t('tb.railUnpin') : t('tb.rail')}
          onClick={onToggleRail}
          data-testid="rail-toggle"
          data-pinned={railPinned ? '1' : '0'}
          data-open={railOpen ? '1' : '0'}
        >
          <Icon name="sidebar-left" />
        </button>
      </div>

      <div className="tb-sync">
        <span className={dotCls} />
        <span>{connText}</span>
        <span className="devs">·</span>
        <button className="tb-cwd" title={t('tb.cwd')} onClick={onPickCwd}>
          {cwd ?? '—'}
        </button>
      </div>

      <div className="tb-right">
        <button className="btn" title={t('tb.lang')} onClick={toggleLang}>
          中文 / EN
        </button>
        <button className="btn icon" title={t('tb.theme')} onClick={onToggleTheme}>
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
        </button>
        <button className="btn icon" title={t('tb.settings')} onClick={onSettings}>
          <Icon name="settings" />
        </button>
      </div>
    </header>
  )
}
