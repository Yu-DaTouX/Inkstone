import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useI18n, useT, type TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { STREAM_MAX, STREAM_MIN, clampStreamWidth } from '../../../../shared/ipc'
import type { SoundEvent, SoundSettings } from '../../../../shared/ipc'
import { previewSound } from '../../lib/sound'
import { BACKGROUND_PRESETS, CUSTOM_BACKGROUND_ID } from '../../lib/background'
import { prefersReducedMotion, usePresence } from '../../lib/usePresence'
import { BUILD_INFO, formatBuildTime } from '../../../../shared/build-info'
import { Button, Disclosure, SettingGroup, SettingRow, Spinner, Switch } from '../ui'
import { AppUpdateSection } from './AppUpdateSection'
import { StorageSection } from './StorageSection'

// Keep the modal shell eager so focus, Escape and native browser occlusion work while loading.
const AuthTab = lazy(() => import('./AuthTab').then(m => ({ default: m.AuthTab })))
const WorkspaceTab = lazy(() => import('./WorkspaceTab').then(m => ({ default: m.WorkspaceTab })))
const ContextTab = lazy(() => import('./ContextTab').then(m => ({ default: m.ContextTab })))
const RemoteTab = lazy(() => import('./RemoteTab').then(m => ({ default: m.RemoteTab })))
const VoiceTab = lazy(() => import('./VoiceTab').then(m => ({ default: m.VoiceTab })))
const PeerTab = lazy(() => import('./PeerTab').then(m => ({ default: m.PeerTab })))
const PluginMarketTab = lazy(() => import('./PluginMarketTab').then(m => ({ default: m.PluginMarketTab })))
const CapabilitiesTab = lazy(() => import('./CapabilitiesTab').then(m => ({ default: m.CapabilitiesTab })))

/**
 * 设置页的 id。
 *
 * 导航含独立插件市场（SETTINGS_PAGES）；旧 id（input / sound / context / knowledge / voice /
 * status / packages / remote / peer）仍可传给 openSettings，由 PAGE_OF 落到合并后的那一页，
 * 这样散落在输入区、引导与菜单里的深链接不用逐个改。
 */
export type SettingsTab =
  | 'auth'
  | 'appearance'
  | 'input'
  | 'workspace'
  | 'context'
  | 'capabilities'
  | 'voice'
  | 'devices'
  | 'about'
  | 'sound'
  | 'status'
  | 'knowledge'
  | 'packages'
  | 'market'
  | 'remote'
  | 'peer'

type SettingsPage = 'auth' | 'appearance' | 'workspace' | 'capabilities' | 'market' | 'devices' | 'about'

const PAGE_OF: Record<SettingsTab, SettingsPage> = {
  auth: 'auth',
  appearance: 'appearance',
  input: 'appearance',
  sound: 'appearance',
  workspace: 'workspace',
  context: 'workspace',
  knowledge: 'workspace',
  capabilities: 'capabilities',
  packages: 'market',
  market: 'market',
  voice: 'devices',
  devices: 'devices',
  remote: 'devices',
  peer: 'devices',
  about: 'about',
  status: 'about'
}

/** 导航顺序：先是每天会碰的（模型、外观与输入），再是工作方式与能力，最后是设备与关于 */
const SETTINGS_PAGES: { id: SettingsPage; key: Parameters<TFunc>[0]; icon: string }[] = [
  { id: 'auth', key: 'set.auth', icon: 'key' },
  { id: 'appearance', key: 'set.pageAppearance', icon: 'moon' },
  { id: 'workspace', key: 'set.pageWorkspace', icon: 'group' },
  { id: 'capabilities', key: 'set.capabilities', icon: 'sparkles' },
  { id: 'market', key: 'market.title', icon: 'package' },
  { id: 'devices', key: 'set.pageDevices', icon: 'phone' },
  { id: 'about', key: 'set.about', icon: 'shield-check' }
]

/**
 * 设置面板：左侧导航，右侧当前页。
 * 每页先放最常改的几项，诊断与高级数值收进页尾的「高级」。
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
  /** 「重新查看首次引导」：引导只在首次启动时自动出现，这里给一个找得到的入口 */
  onShowOnboarding: () => void
}) {
  const t = useT()
  const { lang, setLang } = useI18n()
  const scrim = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  /** 导航项引用：方向键切换后把焦点跟过去（roving focus） */
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const presence = usePresence(open, prefersReducedMotion() ? 1 : 110)
  const page = PAGE_OF[tab] ?? 'appearance'

  /* 模态层：Esc 只关最上层；焦点圈定只在最上层生效（两层模态叠加时不互抢） */
  const { isTop } = useModalLayer(open, onClose)
  /* 传 presence.mounted 而不是 open：open 变 true 的那一帧面板还没挂载 */
  useFocusTrap(panel, presence.mounted, isTop)
  /*
   * 打开时焦点落在当前页的导航项上。排在 useFocusTrap 之后：陷阱先记下
   * 「打开它的元素」（关闭时还焦点），这里再移动焦点。
   */
  useEffect(() => {
    if (!presence.mounted || !open) return
    const id = window.setTimeout(() => {
      tabRefs.current[SETTINGS_PAGES.findIndex((x) => x.id === page)]?.focus()
    }, 0)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence.mounted, open])

  /*
   * 页面被外部切换（深链接、引导里的「去设置」）时，若焦点还停在导航里，
   * 跟到新的选中项上；否则旧页签会留着键盘焦点环，看起来像同时选中了两项。
   */
  useEffect(() => {
    const active = document.activeElement
    if (!active || !tabRefs.current.includes(active as HTMLButtonElement)) return
    const selected = tabRefs.current[SETTINGS_PAGES.findIndex((x) => x.id === page)]
    if (selected && selected !== active) selected.focus()
  }, [page])

  if (!presence.mounted) return null

  const current = SETTINGS_PAGES.find((x) => x.id === page)

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
        <nav className="settings-nav">
          <div className="settings-nav-title">{t('set.title')}</div>
          {/*
           * tablist 使用单一 Tab 入口，方向键从当前焦点切页。
           */}
          <div className="ui-tabs vertical settings-tabs" role="tablist" aria-orientation="vertical" aria-label={t('set.title')}>
            {SETTINGS_PAGES.map((x, i) => (
              <button
                key={x.id}
                ref={(el) => {
                  tabRefs.current[i] = el
                }}
                className={`ui-tab settings-tab ${page === x.id ? 'sel' : ''}`}
                style={{ '--i': i } as React.CSSProperties}
                role="tab"
                id={`settings-tab-${x.id}`}
                aria-selected={page === x.id}
                tabIndex={page === x.id ? 0 : -1}
                aria-controls="settings-tabpanel"
                onClick={() => onTabChange(x.id)}
                onKeyDown={(e) => {
                  const cur = i
                  const to =
                    e.key === 'ArrowDown' || e.key === 'ArrowRight'
                      ? cur + 1
                      : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
                        ? cur - 1
                        : e.key === 'Home'
                          ? 0
                          : e.key === 'End'
                            ? SETTINGS_PAGES.length - 1
                            : null
                  if (to === null) return
                  e.preventDefault()
                  const next = (to + SETTINGS_PAGES.length) % SETTINGS_PAGES.length
                  onTabChange(SETTINGS_PAGES[next].id)
                  /* setTimeout 而不是 rAF：隐藏窗口里 rAF 会被节流 */
                  window.setTimeout(() => tabRefs.current[next]?.focus(), 0)
                }}
              >
                <Icon name={x.icon as never} size={12} />
                <span>{t(x.key)}</span>
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button className="ui-tab settings-tab settings-close" onClick={onClose}>
            <Icon name="chevron-right" size={12} className="chev-flip" />
            <span>{t('set.close')}</span>
          </button>
        </nav>

        {/* key 跟着页走：切页时新节点重演一次淡入 */}
        <div
          className="settings-body"
          key={page}
          id="settings-tabpanel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${page}`}
        >
          <h2 className="settings-page-title">{current ? t(current.key) : ''}</h2>
          <Suspense fallback={<Spinner />}>
          {page === 'auth' ? (
            <AuthTab />
          ) : page === 'appearance' ? (
            <>
              <AppearanceTab lang={lang} setLang={setLang} />
              <SettingGroup title={t('set.input')}>
                <InputTab />
              </SettingGroup>
              <SettingGroup title={t('set.sound')}>
                <SoundTab />
              </SettingGroup>
            </>
          ) : page === 'workspace' ? (
            <>
              <WorkspaceTab />
              <SettingGroup title={t('set.context')}>
                <ContextTab />
              </SettingGroup>
            </>
          ) : page === 'capabilities' ? (
            <>
              <CapabilitiesTab />
            </>
          ) : page === 'market' ? (
            <PluginMarketTab />
          ) : page === 'devices' ? (
            <>
              <DevicesJump initial={tab === 'remote' || tab === 'peer' ? tab : 'voice'} />
              <div id="devices-section-voice">
              <SettingGroup title={t('set.voice')}>
                <VoiceTab />
              </SettingGroup>
              </div>
              <div id="devices-section-remote">
              <SettingGroup title={t('set.remote')}>
                <RemoteTab />
              </SettingGroup>
              </div>
              <div id="devices-section-peer">
              <SettingGroup title={t('set.peer')}>
                <PeerTab />
              </SettingGroup>
              </div>
            </>
          ) : (
            <AboutTab onShowOnboarding={onShowOnboarding} />
          )}
          </Suspense>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- 设备页定位 */

const DEVICE_SECTIONS = ['voice', 'remote', 'peer'] as const
type DeviceSection = (typeof DEVICE_SECTIONS)[number]

/**
 * 设备页顶部的分区定位条：吸顶，点击滚到对应分区，滚动时高亮当前分区。
 * 旧深链接（openSettings('remote' | 'peer')）落到本页后直接滚到对应分区。
 */
function DevicesJump({ initial }: { initial: DeviceSection }) {
  const t = useT()
  const bar = useRef<HTMLElement>(null)
  const [current, setCurrent] = useState<DeviceSection>(initial)
  const jump = (section: DeviceSection, smooth: boolean) => {
    setCurrent(section)
    const root = bar.current?.closest('.settings-body')
    const target = document.getElementById(`devices-section-${section}`)
    if (!root || !target) return
    const top = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - (bar.current?.offsetHeight ?? 0)
    root.scrollTo({ top: section === 'voice' ? 0 : top, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' })
  }
  useEffect(() => {
    /* 分区内容懒加载，等一帧再定位 */
    if (initial === 'voice') return
    const id = window.setTimeout(() => jump(initial, false), 120)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])
  useEffect(() => {
    const root = bar.current?.closest('.settings-body')
    if (!root) return
    const onScroll = () => {
      const edge = root.getBoundingClientRect().top + (bar.current?.offsetHeight ?? 0) + 24
      let next: DeviceSection = 'voice'
      for (const section of DEVICE_SECTIONS) {
        const el = document.getElementById(`devices-section-${section}`)
        if (el && el.getBoundingClientRect().top <= edge) next = section
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) next = DEVICE_SECTIONS[DEVICE_SECTIONS.length - 1]
      setCurrent(next)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [])
  return (
    <nav ref={bar} className="ui-tabs settings-jump" aria-label={t('set.devicesSections')}>
      {DEVICE_SECTIONS.map((section) => (
        <button key={section} type="button" className={`ui-tab ${current === section ? 'sel' : ''}`}
          aria-current={current === section ? 'location' : undefined}
          data-testid={`devices-jump-${section}`} onClick={() => jump(section, true)}>
          {t(`set.${section}`)}
        </button>
      ))}
    </nav>
  )
}

/* ------------------------------------------------------------- 外观 */

/**
 * 界面缩放档位。0 = 自动（按屏幕缩放算，见 main/zoom.ts）。
 * 固定档位而不是滑块：档位可逆、可记住、能用快捷键走到底。
 */
const SCALE_OPTS = [
  { v: 0, key: 'set.uiScaleAuto' },
  { v: 0.9, key: 'set.uiScaleTight' },
  { v: 1, key: 'set.uiScaleNormal' },
  { v: 1.25, key: 'set.uiScaleWide' },
  { v: 1.5, key: 'set.uiScaleHuge' }
] as const

/**
 * 发送键档位。`auto` 是默认值（短输入框 Enter 发送，长文模式 Enter 换行），
 * 不改成别的默认 —— 那会静悄悄改变所有人的按键习惯。
 */
const SEND_KEY_OPTS = [
  { v: 'auto', key: 'set.sendKeyAuto' },
  { v: 'enter', key: 'set.sendKeyEnter' },
  { v: 'ctrlEnter', key: 'set.sendKeyCtrl' }
] as const

/** 界面密度：三档只改间距与行高，不改字号（字号缩放会让中文发虚） */
const DENSITY_OPTS = [
  { v: 'compact', key: 'set.densityCompact' },
  { v: 'standard', key: 'set.densityStandard' },
  { v: 'comfortable', key: 'set.densityComfortable' }
] as const

function AppearanceTab({ lang, setLang }: { lang: string; setLang: (l: 'zh-CN' | 'en-US') => void }) {
  const t = useT()
  const theme = useStore((s) => s.settings?.theme) ?? 'dark'
  const setTheme = useThemeSetter()
  const patchSettings = useStore((s) => s.patchSettings)
  const onTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const keepAwake = useStore((s) => s.settings?.keepAwakeWhileWorking) !== false
  const keepAwakeBattery = useStore((s) => s.settings?.keepAwakeOnBattery) !== false
  const uiScale = useStore((s) => s.settings?.uiScale) ?? 0
  const setUiScale = useStore((s) => s.setUiScale)
  const density = useStore((s) => s.settings?.density) ?? 'standard'
  const zoom = useStore((s) => s.zoom)
  /** 对话内容列宽度（0 = 用设计默认值） */
  const streamWidth = useStore((s) => s.settings?.streamWidth) ?? 0
  const processLayout = useStore((s) => s.settings?.processLayout)
  const liveThinking = useStore((s) => s.settings?.liveThinking === true)
  const backgroundPreset = useStore((s) => s.settings?.backgroundPreset)
  const backgroundCustom = useStore((s) => s.settings?.backgroundCustom)
  /**
   * 滑块拖动中的本地值：range 是受控输入，拖动时若一直绑在 settings 上，
   * React 会把滑块拉回旧值。拖动期间用 draft，落盘后清掉。
   */
  const [draft, setDraft] = useState<number | null>(null)
  /* 取色器拖动时每帧都会触发 change：先本地预览，停手 250ms 再落盘 */
  const [bgDraft, setBgDraft] = useState<string | null>(null)
  const bgTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(bgTimer.current), [])
  /* 未手动设置时的实际宽度：与 tokens.css 的 --w-stream clamp 同一公式 */
  const shownWidth = draft ?? (streamWidth || Math.round(Math.min(920, Math.max(768, window.innerWidth - 680))))
  useEffect(() => setDraft(null), [streamWidth])

  return (
    <div className="ui-rows">
      <SettingRow name={t('set.theme')} ctlClassName="seg">
        {(['dark', 'light'] as const).map((x) => (
          <button
            key={x}
            className={`seg-btn ${theme === x ? 'sel' : ''}`}
            data-testid={`theme-${x}`}
            onClick={(event) => setTheme(x, centerOf(event.currentTarget))}
          >
            <Icon name={x === 'dark' ? 'moon' : 'sun'} size={12} />
            <span>{x === 'dark' ? t('set.dark') : t('set.light')}</span>
          </button>
        ))}
      </SettingRow>

      <SettingRow name={t('set.lang')} ctlClassName="seg">
        {(['zh-CN', 'en-US'] as const).map((x) => (
          <button key={x} className={`seg-btn ${lang === x ? 'sel' : ''}`} onClick={() => setLang(x)}>
            {x === 'zh-CN' ? '中文' : 'English'}
          </button>
        ))}
      </SettingRow>

      <SettingRow name={t('set.liveThinking')} desc={t('set.liveThinkingDesc')}>
        <Switch checked={liveThinking} onChange={(on) => void patchSettings({ liveThinking: on })} label={t('set.liveThinking')} testId="set-live-thinking" />
      </SettingRow>

      <SettingRow col name={t('set.background')} desc={t('set.backgroundDesc')} ctlClassName="seg bg-ctl" ctlProps={{ 'data-testid': 'set-background' }}>
        {BACKGROUND_PRESETS.map((p) => {
          const swatch = p[theme === 'light' ? 'light' : 'dark']
          return (
            <button
              key={p.id}
              className={`seg-btn ${(backgroundPreset ?? 'default') === p.id ? 'sel' : ''}`}
              data-background={p.id}
              onClick={() => void patchSettings({ backgroundPreset: p.id })}
            >
              <span className="bg-swatch" style={swatch ? { background: swatch } : undefined} aria-hidden />
              {t(p.key as Parameters<typeof t>[0])}
            </button>
          )
        })}
        <label className={`seg-btn bg-custom ${backgroundPreset === CUSTOM_BACKGROUND_ID ? 'sel' : ''}`} data-background={CUSTOM_BACKGROUND_ID}>
          <input
            type="color"
            className="bg-picker"
            value={bgDraft ?? backgroundCustom ?? (theme === 'light' ? '#f6f7f9' : '#17191d')}
            aria-label={t('set.bg.custom')}
            onChange={(e) => {
              const value = e.target.value
              setBgDraft(value)
              window.clearTimeout(bgTimer.current)
              bgTimer.current = window.setTimeout(() => {
                void patchSettings({ backgroundPreset: CUSTOM_BACKGROUND_ID, backgroundCustom: value }).finally(() => setBgDraft(null))
              }, 250)
            }}
          />
          {t('set.bg.custom')}
        </label>
      </SettingRow>

      <SettingRow
        name={t('set.uiScale')}
        desc={
          zoom
            ? t('set.uiScaleNow', { sf: Math.round(zoom.scaleFactor * 100), now: zoom.effective.toFixed(2) })
            : t('set.uiScaleDesc')
        }
        ctlClassName="seg seg-scale"
        ctlProps={{ 'data-testid': 'set-ui-scale' }}
      >
        {SCALE_OPTS.map((o) => (
          <button
            key={o.v}
            className={`seg-btn ${uiScale === o.v ? 'sel' : ''}`}
            data-scale={o.v}
            title={o.v === 0 && zoom ? t('set.uiScaleAutoVal', { v: zoom.autoScale.toFixed(2) }) : undefined}
            onClick={() => void setUiScale(o.v)}
          >
            {t(o.key)}
          </button>
        ))}
      </SettingRow>

      <SettingRow name={t('set.density')} ctlClassName="seg" ctlProps={{ 'data-testid': 'set-density' }}>
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
      </SettingRow>

      <SettingRow
        name={t('set.streamWidth')}
        desc={<span data-testid="set-stream-width-now">{streamWidth > 0 ? t('set.streamWidthNow', { n: shownWidth }) : t('set.streamWidthDefault')}</span>}
        ctlClassName="stream-width-ctl"
        ctlProps={{ 'data-testid': 'set-stream-width' }}
      >
        {/* 拖动时实时改 CSS 变量（不走 IPC），松手才落盘 —— 与面板拖拽同一套 */}
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
          onPointerUp={(e) => void patchSettings({ streamWidth: clampStreamWidth(Number((e.target as HTMLInputElement).value)) })}
          onKeyUp={(e) => void patchSettings({ streamWidth: clampStreamWidth(Number((e.target as HTMLInputElement).value)) })}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void patchSettings({ streamWidth: 0 })}
          title={t('set.streamWidthReset')}
          data-testid="set-stream-width-reset"
          disabled={streamWidth === 0}
        >
          {t('set.reset')}
        </Button>
      </SettingRow>

      <SettingRow name={t('set.procLayout')} desc={t('set.procLayoutDesc')} ctlClassName="seg" ctlProps={{ 'data-testid': 'set-process-layout' }}>
        {(['inline', 'left', 'side'] as const).map((v) => (
          <button
            key={v}
            className={`seg-btn ${(processLayout ?? 'inline') === v ? 'sel' : ''}`}
            data-process-layout={v}
            onClick={() => void patchSettings({ processLayout: v })}
          >
            {t(v === 'side' ? 'set.procSide' : v === 'left' ? 'set.procLeft' : 'set.procInline')}
          </button>
        ))}
      </SettingRow>

      {/* 与标题栏的图钉是同一个状态（store.alwaysOnTop），显示以主进程推的真实值为准 */}
      <SettingRow name={t('set.alwaysOnTop')}>
        <Switch checked={onTop} onChange={() => void toggleAlwaysOnTop()} label={t('set.alwaysOnTop')} testId="set-always-on-top" />
      </SettingRow>
      <SettingRow name={t('set.keepAwake')} desc={t('set.keepAwakeDesc')}>
        <Switch checked={keepAwake} onChange={(on) => void patchSettings({ keepAwakeWhileWorking: on })} label={t('set.keepAwake')} testId="set-keep-awake" />
      </SettingRow>
      {/* 电池选项只在开启防睡眠后才有意义 */}
      {keepAwake ? (
        <SettingRow name={t('set.keepAwakeBattery')} desc={t('set.keepAwakeBatteryDesc')}>
          <Switch checked={keepAwakeBattery} onChange={(on) => void patchSettings({ keepAwakeOnBattery: on })} label={t('set.keepAwakeBattery')} testId="set-keep-awake-battery" />
        </SettingRow>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------- 输入 */

function InputTab() {
  const t = useT()
  const patchSettings = useStore((s) => s.patchSettings)
  const sendKey = useStore((s) => s.settings?.sendKey) ?? 'auto'
  /** 运行中的工具调用是否自动展开详情（默认关） */
  const toolDetail = useStore((s) => s.settings?.toolDetail === true)
  const subagentNotify = useStore((s) => s.settings?.subagentNotify !== false)

  return (
    <div className="ui-rows">
      <SettingRow name={t('set.sendKey')} desc={t('set.sendKeyDesc')} ctlClassName="seg" ctlProps={{ 'data-testid': 'set-send-key' }}>
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
      </SettingRow>

      {/* 子代理结束后自动叫醒发起它的会话；关掉后模型只能自己去查 */}
      <SettingRow name={t('set.subagentNotify')} desc={t('set.subagentNotifyDesc')}>
        <Switch
          checked={subagentNotify}
          onChange={(next) => void patchSettings({ subagentNotify: next })}
          label={t('set.subagentNotify')}
          testId="set-subagent-notify"
        />
      </SettingRow>

      {/* 查看历史详情不受影响；这里只决定「正在运行」的那条要不要自动展开 */}
      <SettingRow name={t('set.toolDetail')} desc={t('set.toolDetailDesc')}>
        <Switch
          checked={toolDetail}
          onChange={(next) => void patchSettings({ toolDetail: next, toolDetailExplicit: true })}
          label={t('set.toolDetail')}
          testId="set-tool-detail"
        />
      </SettingRow>
    </div>
  )
}

/** 主题存在 App 的 state + 主进程设置里；这里通过事件让 App 处理 */
function useThemeSetter(): (t: 'dark' | 'light', origin?: { x: number; y: number }) => void {
  return (next, origin) => {
    try {
      localStorage.setItem('yan.theme', next)
    } catch {
      /* 忽略 */
    }
    /* 走 store 的 patchSettings：选中态读的是 settings.theme，store 写回后按钮才跟着换 */
    void useStore.getState().patchSettings({ theme: next })
    /* 捎上按钮中心：主题扩散 / 收拢的圆心就在用户点的那一下 */
    window.dispatchEvent(new CustomEvent('yan:theme', { detail: { theme: next, origin } }))
  }
}

/** 元素中心（视口坐标）—— 主题切换动画的圆心；量不到就不给，CSS 回退到屏幕中心 */
function centerOf(el: Element | null | undefined): { x: number; y: number } | undefined {
  if (!el) return undefined
  const rect = el.getBoundingClientRect()
  if (!rect.width && !rect.height) return undefined
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/* ------------------------------------------------------------- 提醒 */

/** 设置还没读完时的兜底（与主进程 DEFAULTS 保持一致） */
const DEFAULT_SOUND: SoundSettings = {
  enabled: false,
  volume: 0.4,
  notifications: true,
  events: { done: true, question: true, error: true }
}

/**
 * 提醒：回合完成 / 需要回答 / 出错时发声或发系统通知。
 * 每个事件都能单独关、都能试听 —— 不用真跑一轮就能确认音色。
 */
function SoundTab() {
  const t = useT()
  const sound = useStore((s) => s.settings?.sound) ?? DEFAULT_SOUND
  const patchSettings = useStore((s) => s.patchSettings)
  /** 音量拖动中的本地值（受控 range 否则会被 settings 拉回去） */
  const [volDraft, setVolDraft] = useState<number | null>(null)
  useEffect(() => setVolDraft(null), [sound.volume])
  const shownVol = volDraft ?? sound.volume

  const write = (patch: Partial<SoundSettings>): void => {
    void patchSettings({ sound: { ...sound, ...patch } })
  }

  const events: { id: SoundEvent; name: string }[] = [
    { id: 'done', name: t('set.soundEventDone') },
    { id: 'question', name: t('set.soundEventQuestion') },
    { id: 'error', name: t('set.soundEventError') }
  ]

  return (
    <div className="ui-rows" data-testid="set-sound">
      <SettingRow name={t('set.soundNotify')} desc={t('set.soundNotifyDesc')}>
        {/* 测试：不受「窗口失焦」限制，直接让主进程弹一条 */}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void window.yan.notifyAttention({
              kind: 'question',
              title: t('set.soundNotifyTestTitle'),
              body: t('set.soundNotifyTestBody')
            })
          }
          data-testid="set-sound-notify-test"
        >
          {t('set.soundNotifyTest')}
        </Button>
        <Switch
          checked={sound.notifications}
          onChange={(next) => write({ notifications: next })}
          label={t('set.soundNotify')}
          testId="set-sound-notify"
        />
      </SettingRow>

      <SettingRow name={t('set.soundEnabled')} desc={t('set.soundEnabledDesc')}>
        <Switch checked={sound.enabled} onChange={(next) => write({ enabled: next })} label={t('set.soundEnabled')} testId="set-sound-enabled" />
      </SettingRow>

      {sound.enabled ? (
        <>
          <SettingRow
            name={t('set.soundVolume')}
            desc={<span data-testid="set-sound-volume-now">{t('set.soundVolumeNow', { n: Math.round(shownVol * 100) })}</span>}
            ctlClassName="stream-width-ctl"
          >
            <input
              className="range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={shownVol}
              aria-label={t('set.soundVolume')}
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
          </SettingRow>

          {events.map((ev) => (
            <SettingRow key={ev.id} name={ev.name}>
              <Button size="sm" variant="ghost" onClick={() => previewSound(ev.id, sound.volume)} data-testid={`set-sound-preview-${ev.id}`}>
                {t('set.soundPreview')}
              </Button>
              <Switch
                checked={sound.events[ev.id]}
                onChange={(next) => write({ events: { ...sound.events, [ev.id]: next } })}
                label={ev.name}
                testId={`set-sound-event-${ev.id}`}
              />
            </SettingRow>
          ))}
        </>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------- 关于 */

/** 目录名的最后一段（快切按钮只显示它，全路径放 title） */
function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function AboutTab({ onShowOnboarding }: { onShowOnboarding: () => void }) {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const conn = useStore((s) => s.conn)
  const logs = useStore((s) => s.logs)
  const piInfo = useStore((s) => s.piInfo)
  const changeCwd = useStore((s) => s.changeCwd)
  const redetectPi = useStore((s) => s.redetectPi)
  const openBrowser = useStore((s) => s.openBrowser)
  const closeSettings = useStore((s) => s.closeSettings)
  const [detecting, setDetecting] = useState(false)

  const pickCwd = async (): Promise<void> => {
    const p = await window.yan.pickCwd()
    if (p) await changeCwd(p)
  }
  /* 最近用过的目录（主进程维护，最多 8 个） */
  const recentCwds = (settings?.recentCwds ?? []).filter((p) => p !== settings?.cwd)

  const redetect = async (): Promise<void> => {
    setDetecting(true)
    try {
      await redetectPi()
    } finally {
      setDetecting(false)
    }
  }

  /*
   * 「缺件修复」提示只在这几种情况下出现：没版本且内置运行时缺失 / 没版本且
   * 其它来源也没命中 / 退回 shell 兜底（提醒特殊字符风险）。
   */
  const hint = !piInfo?.version
    ? piInfo && piInfo.bundledAvailable === false
      ? t('set.piBundledMissing')
      : t('set.piMissing')
    : piInfo?.source === 'shell'
      ? t('set.piShellWarn')
      : piInfo?.error

  const cu = stats?.contextUsage
  const nf = new Intl.NumberFormat('en-US')

  return (
    <div className="ui-rows">
      {/* 版本放最上面：它回答「我现在跑的是哪一份代码」 */}
      <SettingRow
        data-testid="about-release"
        name={`${t('set.releaseVersion')} ${BUILD_INFO.version || '—'}`}
        desc={
          <span data-testid="about-build" title={BUILD_INFO.buildTime}>
            {t('set.buildVersion')} {formatBuildTime(BUILD_INFO.buildTime) || '—'}
            {BUILD_INFO.buildHash ? ` · ${BUILD_INFO.buildHash}` : ''}
          </span>
        }
      >
        {/* 项目主页走内部浏览器，所以先关掉设置这层遮罩，否则网页开在遮罩下面 */}
        {BUILD_INFO.repositoryUrl ? (
          <Button
            size="sm"
            data-testid="about-repo-open"
            title={BUILD_INFO.repositoryUrl}
            onClick={() => {
              closeSettings()
              void openBrowser(BUILD_INFO.repositoryUrl)
            }}
          >
            {t('set.projectHomeOpen')}
          </Button>
        ) : null}
      </SettingRow>

      <AppUpdateSection />

      <SettingRow
        name={t('tb.cwd')}
        desc={<span className="set-path" title={settings?.cwd}>{settings?.cwd ?? '—'}</span>}
      >
        <Button size="sm" onClick={() => void pickCwd()}>
          {t('set.change')}
        </Button>
      </SettingRow>

      {recentCwds.length > 0 ? (
        <SettingRow col name={t('set.recentCwd')} data-testid="recent-cwds">
          <div className="set-chips">
            {recentCwds.map((p, i) => (
              <Button key={p} size="sm" variant="ghost" title={p} onClick={() => void changeCwd(p)} data-testid={`recent-cwd-${i}`}>
                {folderName(p)}
              </Button>
            ))}
          </div>
        </SettingRow>
      ) : null}

      <SettingRow
        name={t('set.piBin')}
        desc={
          <>
            {conn === 'ready' ? t('conn.ready') : conn === 'starting' ? t('conn.starting') : t('conn.down')}
            {' · '}
            {sourceLabel(t, piInfo?.source)} {piInfo?.version ?? '—'}
            {hint ? <span className="set-warn">{hint}</span> : null}
          </>
        }
      >
        <Button size="sm" onClick={() => void redetect()} disabled={detecting} data-testid="pi-redetect">
          {detecting ? t('set.piRedetecting') : t('set.piRedetect')}
        </Button>
      </SettingRow>

      <SettingRow name={t('set.replayOnboard')} desc={t('set.replayOnboardDesc')}>
        <Button size="sm" onClick={onShowOnboarding} data-testid="ob-reopen">
          {t('set.replayOnboardAction')}
        </Button>
      </SettingRow>

      <StorageSection />

      {/* 诊断：路径、会话 id、本会话用量与日志。排查问题时才看，默认收起 */}
      <Disclosure title={t('set.diagnostics')} testId="set-status-diagnostics">
        <div className="set-diag">
          <DiagLine k={t('set.piHome')} v={piInfo?.home} />
          <DiagLine k={t('set.piPath')} v={piInfo?.bin} />
          <DiagLine k={t('status.session')} v={session?.sessionId} />
          <DiagLine k={t('status.model')} v={session?.model ? `${session.model.name} · ${session.thinkingLevel ?? 'off'}` : undefined} />
          <DiagLine
            k={t('status.context')}
            v={cu && typeof cu.tokens === 'number' && cu.contextWindow ? `${nf.format(cu.tokens)} / ${nf.format(cu.contextWindow)}` : undefined}
          />
          <DiagLine k={t('status.tools')} v={`${stats?.toolCalls ?? 0} · ${t('status.rounds')} ${stats?.userMessages ?? 0} · $${(stats?.cost ?? 0).toFixed(3)}`} />
          {logs.length > 0 ? <pre className="set-logs">{logs.slice(-20).join('\n')}</pre> : null}
        </div>
      </Disclosure>
    </div>
  )
}

function DiagLine({ k, v }: { k: string; v?: string }) {
  return (
    <div className="set-diag-line">
      <span className="set-diag-k">{k}</span>
      <span className="set-diag-v set-path" title={v}>{v || '—'}</span>
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
