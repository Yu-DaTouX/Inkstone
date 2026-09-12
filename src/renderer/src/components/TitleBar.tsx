import { Icon } from '../icons/Icon'
import { useI18n } from '../i18n'
import type { ConnState } from '../state/store'

export type Theme = 'dark' | 'light'

interface Props {
  /** 左栏（侧边栏）开关 —— 在标题栏最左上（对齐 Codex） */
  onToggleRail: () => void
  railOpen?: boolean
  /** 右栏（工具栏）开关 —— 在窗口控制按钮左侧 */
  onToggleRightPanel: () => void
  rightPanelOpen?: boolean
  conn: ConnState
  cwd?: string
  onPickCwd: () => void
  onSettings?: () => void
  /** 窗口是否置顶 */
  alwaysOnTop?: boolean
  onToggleAlwaysOnTop?: () => void
  maximized?: boolean
}

/**
 * 标题栏 —— Win11 风格。
 *
 * 布局（从左到右）：
 *   [侧栏开关] [砚] ······ [连接 · 工作目录] ······ [置顶] [工具栏开关] [— □ ✕]
 *
 * ── 面板开关为什么在标题栏两端（用户要求，参考 Codex 截图）──
 * 这两个开关的位置**与面板收放无关**：收起后它们仍在原处，
 * 所以不存在「收起后开关跟着消失 / 移位」的问题。
 *
 * 曾经把开关搬进面板内部（“开关贴着它控制的东西”），
 * 但那样收起后面板跟着塌陷，就必须给收起态**保留一条宽度**
 * （之前是 38px）来放那个按钮 —— 那条被保留下来的宽度让
 * 中栏变窄/变宽，连带把导航轨的位置算错（用户报的错位）。
 * 开关回到标题栏后，收起就是真的 0 宽，那条保留下来的宽度也就不用存在了。
 *
 * ── 为什么右侧只剩这几个 ──
 * 「中/EN」与「主题」在设置面板的「外观」tab 里有完整切换器，
 * 标题栏再放一份是重复入口。设置齿轮在左栏底部。
 *
 * 拖拽区由 electron.css 的 -webkit-app-region: drag 负责，
 * 所有按钮显式 no-drag。
 */
export function TitleBar({
  onToggleRail,
  railOpen,
  onToggleRightPanel,
  rightPanelOpen,
  conn,
  cwd,
  onPickCwd,
  alwaysOnTop,
  onToggleAlwaysOnTop,
  maximized
}: Props) {
  const { t } = useI18n()
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
        {/*
         * 侧栏开关：标题栏**最左上角**（对齐 Codex 的位置）。
         * 它不随侧栏收放而移动/消失 —— 这是它与「放进面板内部」的关键区别。
         */}
        <button
          className={`tb-icon ${railOpen ? 'on' : ''}`}
          title={railOpen ? t('rail.collapse') : t('rail.expand')}
          onClick={onToggleRail}
          data-testid="rail-toggle"
          data-open={railOpen ? '1' : '0'}
          aria-expanded={railOpen}
        >
          <Icon name="sidebar-left" size={14} />
        </button>
        <span className="tb-name">砚</span>
        {/*
         * 会话名胶囊**已删**（用户要求）。
         * 理由：会话标题已经在**中栏顶部**常驻（SessionHeader），
         * 而且那边显示的是完整标题（不截断、能悬停看全）。
         * 一个信息只在一个地方出现。
         */}
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
        {/*
         * 置顶开关。
         *
         * 面板开关搬走后就只剩它一个内容按钮（更靠右、更靠近窗口控制），
         * 与「齿轮在左栏底部」那种“入口贴着功能”的布局一致。
         */}
        <button
          className={`tb-icon tb-pin ${alwaysOnTop ? 'on' : ''}`}
          title={alwaysOnTop ? t('tb.unpin') : t('tb.pin')}
          onClick={onToggleAlwaysOnTop}
          aria-pressed={!!alwaysOnTop}
          data-testid="win-pin"
          data-on={alwaysOnTop ? '1' : '0'}
        >
          <Icon name="pin" size={14} />
        </button>

        {/* 工具栏开关：紧邻窗口控制按钮（与左上的侧栏开关形成两端对称） */}
        <button
          className={`tb-icon ${rightPanelOpen ? 'on' : ''}`}
          title={rightPanelOpen ? t('rp.hide') : t('rp.show')}
          onClick={onToggleRightPanel}
          data-testid="rightpanel-toggle"
          data-open={rightPanelOpen ? '1' : '0'}
          aria-expanded={rightPanelOpen}
        >
          <Icon name="sidebar-right" size={14} />
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
