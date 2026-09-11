import { Icon } from '../icons/Icon'
import { useI18n } from '../i18n'
import type { ConnState } from '../state/store'

export type Theme = 'dark' | 'light'

interface Props {
  theme: Theme
  onToggleTheme: () => void
  onToggleRail: () => void
  onSettings: () => void
  /** 当前会话标题 */
  subtitle?: string
  conn: ConnState
  cwd?: string
  onPickCwd: () => void
  /** 左栏是否被钉住 */
  railPinned?: boolean
  railOpen?: boolean
  maximized?: boolean
}

/**
 * 标题栏 —— Win11 风格。
 *
 * 与 mac 风格的区别（用户要求改）：
 *   · 窗口按钮**移到最右**，是 46×32 的方形区域（不是左侧三个圆点）
 *   · 悬停时「关闭」变红，「最小化/最大化」变中性灰
 *   · 左栏开关按钮放到**最左上角**（原来是品牌名后面）
 *   · 最大化时按钮显示"还原"图标
 *
 * 拖拽区仍由 electron.css 的 -webkit-app-region: drag 负责，
 * 所有按钮显式 no-drag。
 */
export function TitleBar({
  theme,
  onToggleTheme,
  onToggleRail,
  onSettings,
  subtitle,
  conn,
  cwd,
  onPickCwd,
  railPinned,
  railOpen,
  maximized
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
        {/* 左栏开关放最左上角（Win11 里左上角本来就是"侧栏"位置） */}
        <button
          className={`tb-icon ${railPinned ? 'on' : ''}`}
          title={railPinned ? t('tb.railUnpin') : t('tb.rail')}
          onClick={onToggleRail}
          data-testid="rail-toggle"
          data-pinned={railPinned ? '1' : '0'}
          data-open={railOpen ? '1' : '0'}
        >
          <Icon name="sidebar-left" size={14} />
        </button>

        <span className="tb-name">砚</span>
        {subtitle ? (
          <span className="tb-badge tb-session" title={subtitle}>
            {subtitle}
          </span>
        ) : null}
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
        <button className="tb-icon" title={t('tb.lang')} onClick={toggleLang}>
          中/EN
        </button>
        <button className="tb-icon" title={t('tb.theme')} onClick={onToggleTheme}>
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={14} />
        </button>
        <button className="tb-icon" title={t('tb.settings')} onClick={onSettings}>
          <Icon name="settings" size={14} />
        </button>

        {/* ---- Win11 窗口控制：46×32 方形，紧贴右上角 ---- */}
        <div className="wctrl">
          <button
            className="wbtn min"
            title={t('tb.minimize')}
            onClick={() => win.minimize()}
            data-testid="win-min"
          >
            {/* 最小化：一条横线 */}
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>

          <button
            className="wbtn max"
            title={maximized ? t('tb.restore') : t('tb.maximize')}
            onClick={() => win.maximize()}
            data-testid="win-max"
          >
            {maximized ? (
              /* 还原：两个错开的方框 */
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M2.5 2.5h6v6h-6z" fill="none" stroke="currentColor" strokeWidth="1" />
                <path d="M1.5 1.5h6" fill="none" stroke="currentColor" strokeWidth="1" />
                <path d="M1.5 1.5v6" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            ) : (
              /* 最大化：一个方框 */
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
          </button>

          <button
            className="wbtn close"
            title={t('tb.close')}
            onClick={() => win.close()}
            data-testid="win-close"
          >
            {/* 关闭：X */}
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}
