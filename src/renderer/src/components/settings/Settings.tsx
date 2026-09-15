import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useI18n, useT, type TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { STREAM_MAX, STREAM_MIN, clampStreamWidth } from '../../../../shared/ipc'
import type { SoundEvent, SoundSettings } from '../../../../shared/ipc'
import { previewSound } from '../../lib/sound'
import { prefersReducedMotion, usePresence } from '../../lib/usePresence'
import { AuthTab } from './AuthTab'

export type SettingsTab = 'auth' | 'appearance' | 'sound' | 'status' | 'about'

/**
 * 设置面板。
 *
 * 五个 tab：模型接入 / 外观 / 声音提示 / 状态 / 关于。
 *
 * 「状态」（模型 / 上下文用量 / 花费）是**边聊边看**的，
 * 所以它同时以紧凑形式留在输入区（见 ContextBar），不只是躺在这里。
 */
export function Settings({
  open,
  tab,
  onClose,
  onTabChange,
  onShowOnboarding
}: {
  open: boolean
  tab: SettingsTab
  onClose: () => void
  onTabChange: (t: SettingsTab) => void
  /**
   * 「重新查看首次引导」（N20）。
   *
   * 为什么放在设置里：引导只在首次启动且检测到问题时自动弹，
   * 用户跳过（或当时环境已就绪）之后就再也找不到那页检查清单。
   * 这里给一个可发现的入口，同时让探针能在**不重置首次启动标记**
   * 的前提下真实渲染引导层（先前只能靠伪造 localStorage）。
   */
  onShowOnboarding: () => void
}) {
  const t = useT()
  const { lang, setLang } = useI18n()
  const scrim = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // 退场：面板体量大，进度比其他浮层长一点
  const presence = usePresence(open, prefersReducedMotion() ? 1 : 110)

  /*
   * 模态层：Esc 关闭（仅顶层）+ 告知主进程暂停全局快捷键。
   *
   * ⚠️ Esc 以前是这里自己监听的 —— 两个弹窗叠加时两个都会响应，
   *    一次 Esc 关掉两层。交给 useModalLayer 后只有最上层生效。
   */
  const { isTop } = useModalLayer(open, onClose)
  /*
   * 焦点圈定只在**最上层**生效。
   *
   * ⚠️ 两层模态同时在时（首次引导 + 设置、设置 + 扩展确认框），
   *    两个 trap 都监听 document 的 Tab —— 下层那个会把焦点
   *    从上层拽回来。用 isTop 串起来才是「栈」的语义。
   *
   * ⚠️ 第一个参数传 presence.mounted 而不是 open：open 变 true 的那一帧
   *    DOM 还没渲染（面板要等 mounted 才挂），effect 里 ref 会是 null，
   *    整个陷阱（含初始焦点）静默失效。
   */
  useFocusTrap(panel, presence.mounted, isTop)

  if (!presence.mounted) return null

  const tabs: { id: SettingsTab; label: string; icon: string }[] = [
    { id: 'auth', label: t('set.auth'), icon: 'tag' },
    { id: 'appearance', label: t('set.appearance'), icon: 'moon' },
    { id: 'sound', label: t('set.sound'), icon: 'sparkles' },
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
        ref={panel}
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
          {tab === 'auth' ? (
            <AuthTab />
          ) : tab === 'appearance' ? (
            <AppearanceTab lang={lang} setLang={setLang} />
          ) : tab === 'sound' ? (
            <SoundTab />
          ) : tab === 'status' ? (
            <StatusTab />
          ) : (
            <AboutTab onShowOnboarding={onShowOnboarding} />
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- 外观 */

/**
 * 界面缩放档位。0 = 自动（按屏幕缩放算，见 main/zoom.ts）。
 *
 * 为什么用固定档位而不是滑块：档位可逆、可记住、能用快捷键走到底，
 * 而滑块每次停的位置都是个新的浮点数。
 */
const SCALE_OPTS = [
  { v: 0, key: 'set.uiScaleAuto' },
  { v: 0.9, key: 'set.uiScaleTight' },
  { v: 1, key: 'set.uiScaleNormal' },
  { v: 1.25, key: 'set.uiScaleWide' },
  { v: 1.5, key: 'set.uiScaleHuge' }
] as const

/**
 * 发送键档位。
 *
 * `auto` 是默认值，也就是**改动前的行为**（短输入框 Enter 发送，
 * 长文模式 Enter 换行）—— 不把默认改成别的，是因为那会静悄悄
 * 改变所有人的按键习惯。见 AppSettings.sendKey 的注释。
 */
const SEND_KEY_OPTS = [
  { v: 'auto', key: 'set.sendKeyAuto' },
  { v: 'enter', key: 'set.sendKeyEnter' },
  { v: 'ctrlEnter', key: 'set.sendKeyCtrl' }
] as const

/**
 * 界面密度（方案 A1）。
 *
 * 三档只改间距与行高，**不改字号** —— 中文字体在 12.5px 上是像素
 * 对齐的，缩放字号会让字变糊。standard 档与改动前完全一致。
 */
const DENSITY_OPTS = [
  { v: 'compact', key: 'set.densityCompact' },
  { v: 'standard', key: 'set.densityStandard' },
  { v: 'comfortable', key: 'set.densityComfortable' }
] as const

function AppearanceTab({ lang, setLang }: { lang: string; setLang: (l: 'zh-CN' | 'en-US') => void }) {
  const t = useT()
  const theme = useStore((s) => s.settings?.theme) ?? 'dark'
  const setTheme = useThemeSetter()
  /** 工具详情默认展开（用户要求加的开关） */
  const toolDetail = useStore((s) => s.settings?.toolDetail === true)
  const patchSettings = useStore((s) => s.patchSettings)
  const onTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const uiScale = useStore((s) => s.settings?.uiScale) ?? 0
  const setUiScale = useStore((s) => s.setUiScale)
  const sendKey = useStore((s) => s.settings?.sendKey) ?? 'auto'
  /** 界面密度（方案 A1） */
  const density = useStore((s) => s.settings?.density) ?? 'standard'
  const zoom = useStore((s) => s.zoom)
  /** 对话内容列宽度（0 = 用设计默认值） */
  const streamWidth = useStore((s) => s.settings?.streamWidth) ?? 0
  /**
   * 滑块拖动中的本地值。
   *
   * 为什么需要：拖动时只改 CSS 变量、松手才落盘（与面板拖拽同一套，
   * 避免每帧写文件）。但 range 是**受控**输入，如果 value 一直绑在
   * settings.streamWidth 上，拖动时 React 会把 thumb 拉回旧值 ——
   * 手感是「拖不动」。所以拖动期间用 draft，落盘后 settings 变化再清掉。
   */
  const [draft, setDraft] = useState<number | null>(null)
  const shownWidth = draft ?? (streamWidth || 900)
  useEffect(() => setDraft(null), [streamWidth])
  const [reduced] = useState(
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
          <div className="set-name">{t('set.uiScale')}</div>
          <div className="set-desc">{t('set.uiScaleDesc')}</div>
          {zoom ? (
            <div className="set-desc set-num">
              {t('set.uiScaleNow', {
                sf: Math.round(zoom.scaleFactor * 100),
                auto: zoom.autoScale.toFixed(2),
                now: zoom.effective.toFixed(2)
              })}
            </div>
          ) : null}
        </div>
        <div className="set-ctl seg seg-scale" data-testid="set-ui-scale">
          {SCALE_OPTS.map((o) => (
            <button
              key={o.v}
              className={`seg-btn ${uiScale === o.v ? 'sel' : ''}`}
              data-scale={o.v}
              onClick={() => void setUiScale(o.v)}
            >
              {o.v === 0 && zoom
                ? t('set.uiScaleAutoVal', { v: zoom.autoScale.toFixed(2) })
                : t(o.key)}
            </button>
          ))}
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.density')}</div>
          <div className="set-desc">{t('set.densityDesc')}</div>
        </div>
        <div className="set-ctl seg" data-testid="set-density">
          {DENSITY_OPTS.map((o) => (
            <button
              key={o.v}
              className={`seg-btn ${density === o.v ? 'sel' : ''}`}
              data-density={o.v}
              data-on={density === o.v ? '1' : '0'}
              onClick={() => void patchSettings({ density: o.v })}
            >
              {t(o.key)}
            </button>
          ))}
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.sendKey')}</div>
          <div className="set-desc">{t('set.sendKeyDesc')}</div>
        </div>
        <div className="set-ctl seg" data-testid="set-send-key">
          {SEND_KEY_OPTS.map((o) => (
            <button
              key={o.v}
              className={`seg-btn ${sendKey === o.v ? 'sel' : ''}`}
              data-send-key={o.v}
              onClick={() => void patchSettings({ sendKey: o.v })}
            >
              {t(o.key)}
            </button>
          ))}
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.streamWidth')}</div>
          <div className="set-desc">{t('set.streamWidthDesc')}</div>
          <div className="set-desc set-num" data-testid="set-stream-width-now">
            {streamWidth > 0 ? t('set.streamWidthNow', { n: shownWidth }) : t('set.streamWidthDefault')}
          </div>
        </div>
        <div className="set-ctl stream-width-ctl" data-testid="set-stream-width">
          {/*
           * 滑块而不是预设档位：宽度是个连续量，用户心里往往有个具体值
           * （“我想让代码块一行放下 100 个字符”）。拖动时实时改 CSS 变量
           * （只写 documentElement，不走 IPC），松手才落盘 —— 与面板拖拽同一套。
           */}
          <input
            className="range"
            type="range"
            min={STREAM_MIN}
            max={STREAM_MAX}
            step={20}
            value={shownWidth}
            aria-label={t('set.streamWidth')}
            onChange={(e) => {
              const v = Number(e.target.value)
              setDraft(v)
              document.documentElement.style.setProperty('--w-stream', `${v}px`)
            }}
            onPointerUp={(e) => {
              const v = clampStreamWidth(Number((e.target as HTMLInputElement).value))
              void patchSettings({ streamWidth: v })
            }}
            onKeyUp={(e) => {
              const v = clampStreamWidth(Number((e.target as HTMLInputElement).value))
              void patchSettings({ streamWidth: v })
            }}
          />
          <button
            className="seg-btn"
            onClick={() => void patchSettings({ streamWidth: 0 })}
            title={t('set.streamWidthReset')}
            data-testid="set-stream-width-reset"
            disabled={streamWidth === 0}
          >
            <Icon name="refresh" size={12} />
          </button>
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.toolDetail')}</div>
          <div className="set-desc">{t('set.toolDetailDesc')}</div>
        </div>
        <div className="set-ctl">
          {/*
           * 用户要求：「提供一个开关来让用户自己选择是否可以看到
           * 用类似终端窗口的工具调用详情」。
           *
           * 默认关（收起）：开始 / 增量输出 / 结束都不自动展开。
           * 打开后**只有正在跑的那条**会自动展开成终端窗口。
           * 同时写 `toolDetailExplicit` —— 这是用户偏好，迁移时不再被重置。
           */}
          <button
            className={`seg-btn ${toolDetail ? 'sel' : ''}`}
            onClick={() => void patchSettings({ toolDetail: !toolDetail, toolDetailExplicit: true })}
            data-testid="set-tool-detail"
            data-on={toolDetail ? '1' : '0'}
          >
            <Icon name="menu" size={12} />
            <span>{toolDetail ? t('set.on') : t('set.off')}</span>
          </button>
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

/** ------------------------------------------------------------- 声音提示 */

/** 设置还没读完时的兜底（与主进程 DEFAULTS 保持一致） */
const DEFAULT_SOUND: SoundSettings = {
  enabled: false,
  volume: 0.4,
  notifications: true,
  events: { done: true, question: true, error: true }
}

/**
 * 声音提示设置。
 *
 * 对应 opencode 的 attention：回合完成 / 需要回答 / 出错时出声。
 * 每个事件都可单独关，且都能「试听」——不用真跑一轮就能确认音色。
 */
function SoundTab() {
  const t = useT()
  const sound = useStore((s) => s.settings?.sound) ?? DEFAULT_SOUND
  const patchSettings = useStore((s) => s.patchSettings)
  /** 音量拖动中的本地值（受控 range 否则会被 settings 拉回去，与对话宽度同一套） */
  const [volDraft, setVolDraft] = useState<number | null>(null)
  useEffect(() => setVolDraft(null), [sound.volume])
  const shownVol = volDraft ?? sound.volume

  const write = (patch: Partial<SoundSettings>): void => {
    void patchSettings({ sound: { ...sound, ...patch } })
  }
  const toggleEvent = (ev: SoundEvent): void => {
    write({ events: { ...sound.events, [ev]: !sound.events[ev] } })
  }

  const events: { id: SoundEvent; name: string; desc: string }[] = [
    { id: 'done', name: t('set.soundEventDone'), desc: t('set.soundEventDoneDesc') },
    { id: 'question', name: t('set.soundEventQuestion'), desc: t('set.soundEventQuestionDesc') },
    { id: 'error', name: t('set.soundEventError'), desc: t('set.soundEventErrorDesc') }
  ]

  return (
    <div className="set-group" data-testid="set-sound">
      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.soundEnabled')}</div>
          <div className="set-desc">{t('set.soundEnabledDesc')}</div>
        </div>
        <div className="set-ctl">
          <button
            className={`seg-btn ${sound.enabled ? 'sel' : ''}`}
            onClick={() => write({ enabled: !sound.enabled })}
            data-testid="set-sound-enabled"
            data-on={sound.enabled ? '1' : '0'}
          >
            <Icon name="sparkles" size={12} />
            <span>{sound.enabled ? t('set.on') : t('set.off')}</span>
          </button>
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.soundNotify')}</div>
          <div className="set-desc">{t('set.soundNotifyDesc')}</div>
        </div>
        <div className="set-ctl">
          <button
            className={`seg-btn ${sound.notifications ? 'sel' : ''}`}
            onClick={() => write({ notifications: !sound.notifications })}
            data-testid="set-sound-notify"
            data-on={sound.notifications ? '1' : '0'}
          >
            <Icon name="alert-circle" size={12} />
            <span>{sound.notifications ? t('set.on') : t('set.off')}</span>
          </button>
          {/* 测试：不受「窗口失焦」限制，直接让主进程弹一条，方便确认系统真的能弹 */}
          <button
            className="seg-btn"
            onClick={() =>
              void window.yan.notifyAttention({
                kind: 'question',
                title: t('set.soundNotifyTestTitle'),
                body: t('set.soundNotifyTestBody')
              })
            }
            title={t('set.soundNotifyTest')}
            data-testid="set-sound-notify-test"
          >
            <Icon name="send" size={12} />
            <span>{t('set.soundNotifyTest')}</span>
          </button>
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.soundVolume')}</div>
          <div className="set-desc">{t('set.soundVolumeDesc')}</div>
          <div className="set-desc set-num" data-testid="set-sound-volume-now">
            {t('set.soundVolumeNow', { n: Math.round(shownVol * 100) })}
          </div>
        </div>
        <div className="set-ctl stream-width-ctl">
          <input
            className="range"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={shownVol}
            aria-label={t('set.soundVolume')}
            disabled={!sound.enabled}
            data-testid="set-sound-volume"
            onChange={(e) => setVolDraft(Number(e.target.value))}
            onPointerUp={(e) => {
              const v = Number((e.target as HTMLInputElement).value)
              write({ volume: v })
              previewSound('done', v)
            }}
            onKeyUp={(e) => {
              const v = Number((e.target as HTMLInputElement).value)
              write({ volume: v })
              previewSound('done', v)
            }}
          />
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.soundEvents')}</div>
          <div className="set-desc">{t('set.soundDesc')}</div>
        </div>
      </div>

      {events.map((ev) => (
        <div className="set-row" key={ev.id}>
          <div className="set-label">
            <div className="set-name">{ev.name}</div>
            <div className="set-desc">{ev.desc}</div>
          </div>
          <div className="set-ctl">
            <button
              className={`seg-btn ${sound.events[ev.id] ? 'sel' : ''}`}
              onClick={() => toggleEvent(ev.id)}
              data-testid={`set-sound-event-${ev.id}`}
              data-on={sound.events[ev.id] ? '1' : '0'}
            >
              <Icon name="sparkle" size={12} />
              <span>{sound.events[ev.id] ? t('set.on') : t('set.off')}</span>
            </button>
            <button
              className="seg-btn"
              onClick={() => previewSound(ev.id, sound.volume)}
              title={t('set.soundPreview')}
              data-testid={`set-sound-preview-${ev.id}`}
            >
              <Icon name="send" size={12} />
              <span>{t('set.soundPreview')}</span>
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------- 状态 */

function StatusTab() {
  const t = useT()
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)

  const cu = stats?.contextUsage
  const modelKey = session?.model ? `${session.model.provider}/${session.model.id}` : undefined
  const statsMatchModel = !!cu && (!cu.modelKey || cu.modelKey === modelKey)
  const known = statsMatchModel && typeof cu?.tokens === 'number'
  const used = known ? (cu?.tokens as number) : 0
  const win = session?.model?.contextWindow ?? (statsMatchModel ? cu?.contextWindow : undefined) ?? 0
  const pct = known ? (cu?.percent ?? (used && win ? (used / win) * 100 : 0)) : 0
  const nf = new Intl.NumberFormat('en-US')

  return (
    <div className="set-group" data-testid="set-status-diagnostics">
      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('status.session')}</div>
          <div className="set-desc set-num">{session?.sessionId ?? '—'}</div>
        </div>
        <div className="set-ctl set-static set-num">
          {session?.model?.name ?? '—'} · {session?.thinkingLevel ?? 'off'}
        </div>
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('status.context')}</div>
          <div className="set-desc">
            {known ? `${nf.format(used)} / ` : '— / '}{win ? nf.format(win) : '—'} · {known && win ? pct.toFixed(1) : '—'}%
          </div>
        </div>
        <div className="set-ctl set-static">
          {session?.isCompacting ? t('status.compacting') : session?.isStreaming ? t('status.streaming') : t('status.context')}
        </div>
      </div>

      <div className="set-row col">
        <div className="set-label">
          <div className="set-name">{t('status.tools')} / {t('status.rounds')}</div>
          <div className="set-desc">{stats?.toolCalls ?? 0} / {stats?.userMessages ?? 0}</div>
        </div>
        <div className="meter">
          <i style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <div className="usage-line">
          <span>
            <b>{t('status.tools')}</b> {stats?.toolCalls ?? 0}
          </span>
          <span>
            <b>{t('status.cost')}</b> ${(stats?.cost ?? 0).toFixed(3)}
          </span>
          <span>
            <b>{t('status.rounds')}</b> {stats?.userMessages ?? 0}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- 关于 */

function AboutTab({ onShowOnboarding }: { onShowOnboarding: () => void }) {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const session = useStore((s) => s.session)
  const conn = useStore((s) => s.conn)
  const logs = useStore((s) => s.logs)
  const piInfo = useStore((s) => s.piInfo)
  const changeCwd = useStore((s) => s.changeCwd)
  const redetectPi = useStore((s) => s.redetectPi)
  const [detecting, setDetecting] = useState(false)

  const pickCwd = async (): Promise<void> => {
    const p = await window.yan.pickCwd()
    if (p) await changeCwd(p)
  }

  const redetect = async (): Promise<void> => {
    setDetecting(true)
    try {
      await redetectPi()
    } finally {
      setDetecting(false)
    }
  }

  /*
   * 「缺件修复」提示只在这几种情况下出现：
   *   · 没版本且内置运行时缺失 → 给出生成/重装指引（最常见：新克隆没跑 vendor:pi）
   *   · 没版本且内置在、但其它来源也没命中 → 给出安装命令
   *   · 退回 shell 兜底 → 提醒特殊字符风险
   */
  const hint = !piInfo?.version
    ? piInfo && piInfo.bundledAvailable === false
      ? t('set.piBundledMissing')
      : t('set.piMissing')
    : piInfo?.source === 'shell'
      ? t('set.piShellWarn')
      : piInfo?.error

  const binPath = piInfo?.bin ?? '—'

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
          <div className="set-desc">
            {t('set.piSource')}: {sourceLabel(t, piInfo?.source)} · {t('set.piVersion')}:{' '}
            {piInfo?.version ?? '—'}
          </div>
          {piInfo?.home ? (
            <div className="set-desc set-path" title={piInfo.home}>
              {t('set.piHome')}: {piInfo.home}
            </div>
          ) : null}
          <div className="set-desc set-path" title={binPath}>
            {binPath}
          </div>
        </div>
        <div className="set-ctl">
          <button className="btn" onClick={() => void redetect()} disabled={detecting} data-testid="pi-redetect">
            {detecting ? t('set.piRedetecting') : t('set.piRedetect')}
          </button>
        </div>
        {hint ? <div className="set-warn">{hint}</div> : null}
      </div>

      <div className="set-row">
        <div className="set-label">
          <div className="set-name">{t('set.replayOnboard')}</div>
          <div className="set-desc">{t('set.replayOnboardDesc')}</div>
        </div>
        <div className="set-ctl">
          <button className="btn" onClick={onShowOnboarding} data-testid="ob-reopen">
            {t('set.replayOnboardAction')}
          </button>
        </div>
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

/** pi 来源的中文/英文标签 */
function sourceLabel(t: TFunc, src?: string): string {
  switch (src) {
    case 'bundled':
      return t('set.piSourceBundled')
    case 'global':
      return t('set.piSourceGlobal')
    case 'override':
      return t('set.piSourceOverride')
    case 'env':
      return t('set.piSourceEnv')
    case 'path':
      return t('set.piSourcePath')
    case 'shell':
      return t('set.piSourceShell')
    default:
      return '—'
  }
}
