import { Icon } from '../icons/Icon'
import { useI18n } from '../i18n'
import type { ConnState } from '../state/store'

export type Theme = 'dark' | 'light'

interface Props {
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
 *   [砚] ······ [连接 · 工作目录] ······ [置顶] [— □ ✕]
 *
 * ── 面板开关已从标题栏移除（用户要求，附图）──
 * 左栏/右栏的开关现在在**各自面板的头部**：
 *   · 左栏 → `.rail-top` 里的砚字旁边（点了就收起）
 *   · 右栏 → `.rp-top` 里的「工具栏」标题右侧（原本就有）
 * 为什么这样更对：开关贴着它控制的东西。原先两个按钮都在标题栏，
 * 而标题栏是**窗口**的控件区（拖动/最大化/关闭），不是面板的；
 * 用户看截图后指出这一点。
 *
 * ── 为什么右侧只剩置顶 + 窗口控制（用户要求精简）──
 * 「中/EN」与「主题」已从标题栏移除：设置面板的「外观」tab 里**本来就有**
 * 这两项的完整切换器（带说明文字），标题栏再放一份是重复的两个入口。
 * 「设置齿轮」也移除了 —— 左栏底部（`rail-settings`）已经是入口。
 *
 * 置顶留下是因为它是真正需要「一眼看到当前状态」的东西：
 * 开着的时候窗口会挡住一切，藏进设置里反而容易忘记自己开过。
 *
 * 拖拽区由 electron.css 的 -webkit-app-region: drag 负责，
 * 所有按钮显式 no-drag。
 */
export function TitleBar({
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
        <span className="tb-name">砚</span>
        {/*
         * 会话名胶囊**已删**（用户要求）。
         *
         * 理由：会话标题已经在**中栏顶部**常驻（SessionHeader），
         * 而且那边显示的是完整标题（不截断、能悬停看全）。
         * 标题栏里再放一份短版是重复信息，还占着左边最宝贵的位置。
         * 这与之前删掉「中/EN · 主题 · 设置齿轮」是同一条原则：
         * 一个信息只在一个地方出现。
         *
         * 左栏开关也已搬走（到左栏自己的头部）—— 见文件头注释。
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
