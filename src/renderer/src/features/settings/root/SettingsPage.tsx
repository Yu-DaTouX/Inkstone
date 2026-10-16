/**
 * v3 设置根页（WP-43 / S0）。
 *
 * 结构：左侧分区导航（外观 / 上下文 / 模型与服务 / 能力 / 用量 / 快捷键），右侧当前分区。
 * 外观、上下文、用量与快捷键由本页实现；模型与服务、能力由并行实现（S1 / S2）以
 * `features/settings/{models,capabilities}/index` 的无 props 组件提供，这里
 * 用 `import.meta.glob` 懒加载：模块还没落盘时如实说明限制，不造假数据、
 * 也不替对方建 stub 覆盖文件。
 *
 * 旧深链接：`openSettings(name)` 经 `deep-link.ts` 记录页名，这里用
 * `types.ts` 的纯函数映射到 v3 分区；映射不到的旧页/未知页会明确提示，
 * 不静默吞掉导航。
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type LazyExoticComponent,
  type ReactElement
} from 'react'
import { BarChart3, Bell, Clock, Gauge, HardDrive, Info, KeyRound, Keyboard, Moon, RefreshCw, Shield, Smartphone, Sparkles } from 'lucide-react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import { useUiV3 } from '../../../state/ui-v3'
import { Button } from '../../../ui'
import { AppearanceSettings } from '../appearance/AppearanceSettings'
import { ContextSettings } from '../context/ContextSettings'
import { ShortcutsSettings } from '../shortcuts/ShortcutsSettings'
import { SyncSettings } from '../sync/SyncSettings'
import { AboutSettings, DataSettings, DevicesSettings, NotificationsSettings, SecuritySettings, SessionSettings } from '../general'
import { UsageSettings } from '../usage/UsageSettings'
import { settingsText, type SettingsText } from '../settings-text'
import {
  DEFAULT_SETTINGS_SECTION,
  resolveLegacyView,
  SETTINGS_SECTIONS,
  type SettingsSectionDef,
  type SettingsSectionId
} from '../types'
import { getSettingsRequest, subscribeSettingsRequest } from './deep-link'
import { useSwitchToV2 } from './use-switch-to-v2'
import '../settings.css'

type Submodule = LazyExoticComponent<() => ReactElement>

/** 从 glob 结果里取一个懒加载组件；没有文件（或没有导出）时返回 null。 */
function pickLazy(record: Record<string, () => Promise<unknown>>, exportName: string): Submodule | null {
  const loader = Object.values(record)[0]
  if (!loader) return null
  return lazy(async () => {
    const mod = (await loader()) as Record<string, unknown>
    const component = mod[exportName]
    if (typeof component !== 'function') throw new Error(`设置子模块缺少导出 ${exportName}`)
    return { default: component as () => ReactElement }
  })
}

/* 并行实现（S1 / S2）的入口：优先 `features/settings/{models,capabilities}/index`，
 * 没有 index 时回退到直接文件名（对方仍在落盘，不能假定 index 已存在）。 */
const modelsGlob = {
  ...import.meta.glob('../index.ts'),
  ...import.meta.glob('../index.tsx'),
  ...import.meta.glob('../models/index.ts'),
  ...import.meta.glob('../models/index.tsx'),
  ...import.meta.glob('../models/ModelsSettings.tsx')
}
const capabilitiesGlob = {
  ...import.meta.glob('../index.ts'),
  ...import.meta.glob('../index.tsx'),
  ...import.meta.glob('../capabilities/index.ts'),
  ...import.meta.glob('../capabilities/index.tsx'),
  ...import.meta.glob('../capabilities/CapabilitiesSettings.tsx')
}
const ModelsSettings = pickLazy(modelsGlob, 'ModelsSettings')
const CapabilitiesSettings = pickLazy(capabilitiesGlob, 'CapabilitiesSettings')

const SECTION_ICON: Record<SettingsSectionDef['icon'], ReactElement> = {
  moon: <Moon size={15} aria-hidden />,
  clock: <Clock size={15} aria-hidden />,
  bell: <Bell size={15} aria-hidden />,
  gauge: <Gauge size={15} aria-hidden />,
  key: <KeyRound size={15} aria-hidden />,
  sparkles: <Sparkles size={15} aria-hidden />,
  shield: <Shield size={15} aria-hidden />,
  smartphone: <Smartphone size={15} aria-hidden />,
  'hard-drive': <HardDrive size={15} aria-hidden />,
  chart: <BarChart3 size={15} aria-hidden />,
  keyboard: <Keyboard size={15} aria-hidden />,
  info: <Info size={15} aria-hidden />,
  refresh: <RefreshCw size={15} aria-hidden />
}

/** 分区 → 文案键（显式映射，避免用字符串拼 key 丢类型）。 */
const SECTION_LABEL: Record<SettingsSectionId, keyof SettingsText> = {
  appearance: 'sectionAppearance',
  session: 'sectionSession',
  notifications: 'sectionNotifications',
  context: 'sectionContext',
  models: 'sectionModels',
  capabilities: 'sectionCapabilities',
  security: 'sectionSecurity',
  devices: 'sectionDevices',
  data: 'sectionData',
  usage: 'sectionUsage',
  shortcuts: 'sectionShortcuts',
  about: 'sectionAbout',
  sync: 'sectionSync'
}

function SubmoduleHost({
  component: Host,
  title,
  body,
  onDismiss
}: {
  component: Submodule | null
  title: string
  body: string
  onDismiss: () => void
}): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const { env, busy, error, switchToV2 } = useSwitchToV2(lang)

  if (Host) {
    return (
      <Suspense fallback={<p className="settings-value">{text.loading}</p>}>
        <Host />
      </Suspense>
    )
  }

  return (
    <section className="settings-section" data-testid="settings-missing">
      <h2 className="settings-h2">{title}</h2>
      <p className="settings-note" role="note">
        {body}
      </p>
      <div className="settings-actions">
        <Button variant="secondary" size="sm" isDisabled={busy || env} onPress={() => void switchToV2()}>
          {text.openLegacy}
        </Button>
        <Button variant="ghost" size="sm" onPress={onDismiss}>
          {text.backToAppearance}
        </Button>
      </div>
      {error ? (
        <p className="settings-row__desc settings-row__desc--error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function LegacyNotice({
  view,
  kind,
  onDismiss,
  onBack
}: {
  view: string
  kind: 'unmigrated' | 'unknown'
  onDismiss: () => void
  onBack?: () => void
}): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const { env, busy, error, switchToV2 } = useSwitchToV2(lang)
  const title = kind === 'unmigrated' ? text.unmigratedTitle : text.unknownTitle
  const body = (kind === 'unmigrated' ? text.unmigratedBody : text.unknownBody).replace('{view}', view || text.unknownTitle)

  return (
    <section className="settings-section" data-testid="settings-legacy">
      <h2 className="settings-h2">{title}</h2>
      <p className="settings-note" role="note">
        {body}
      </p>
      <div className="settings-actions">
        <Button variant="secondary" size="sm" isDisabled={busy || env} onPress={() => void switchToV2()}>
          {text.openLegacy}
        </Button>
        <Button variant="ghost" size="sm" onPress={onDismiss}>
          {text.backToAppearance}
        </Button>
        {onBack ? (
          <Button variant="ghost" size="sm" onPress={onBack}>
            {text.backToChat}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="settings-row__desc settings-row__desc--error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

export interface SettingsPageProps {
  /** 外壳的「返回」（Header 已有；转发给消费方，当前仅在旧页提示里作为可选出口）。 */
  onBack?: () => void
  /** 「运行总览」入口；不传时用量页走正式 v3 路由。 */
  onRuns?: () => void
  /** 「重新查看首次引导」：由外壳注入时，关于页显示可点的重新查看入口。 */
  onShowOnboarding?: () => void
}

export function SettingsPage({ onBack, onRuns, onShowOnboarding }: SettingsPageProps = {}): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const settings = useStore((s) => s.settings)
  const request = useSyncExternalStore(subscribeSettingsRequest, getSettingsRequest)
  const [section, setSection] = useState<SettingsSectionId>(DEFAULT_SETTINGS_SECTION)
  const [legacy, setLegacy] = useState<{ view: string; kind: 'unmigrated' | 'unknown' } | null>(null)

  /* 深链接：旧页名 → v3 分区；映射不到就留在当前页并提示，不静默跳走。 */
  useEffect(() => {
    if (!request) return
    const resolved = resolveLegacyView(request.view)
    if (resolved.kind === 'section') {
      setSection(resolved.section)
      setLegacy(null)
    } else {
      setLegacy({ view: resolved.view, kind: resolved.kind })
    }
  }, [request])

  const select = useCallback((next: SettingsSectionId): void => {
    setSection(next)
    setLegacy(null)
  }, [])
  const openAppearance = useCallback((): void => {
    setSection(DEFAULT_SETTINGS_SECTION)
    setLegacy(null)
  }, [])
  const openRuns = useCallback((): void => {
    if (onRuns) onRuns()
    else useUiV3.getState().navigate({ name: 'runs' })
  }, [onRuns])

  if (!settings) {
    return (
      <div className="settings-page" data-loading="1">
        <p className="settings-value" role="status">
          {text.loading}
        </p>
      </div>
    )
  }

  return (
    <div className="settings-page" data-testid="settings-root">
      <nav className="settings-nav" aria-label={text.navLabel}>
        <h2 className="settings-h2 settings-nav__title">{text.title}</h2>
        {SETTINGS_SECTIONS.map((entry) => {
          const active = !legacy && entry.id === section
          return (
            <button
              key={entry.id}
              type="button"
              className="settings-nav__item"
              data-active={active ? '1' : '0'}
              aria-current={active ? 'page' : undefined}
              data-testid={`v3-settings-nav-${entry.id}`}
              onClick={() => select(entry.id)}
            >
              {SECTION_ICON[entry.icon]}
              <span>{text[SECTION_LABEL[entry.id]]}</span>
            </button>
          )
        })}
      </nav>

      <div className="settings-main">
        {legacy ? (
          <LegacyNotice view={legacy.view} kind={legacy.kind} onDismiss={openAppearance} onBack={onBack} />
        ) : section === 'appearance' ? (
          <AppearanceSettings />
        ) : section === 'session' ? (
          <SessionSettings />
        ) : section === 'notifications' ? (
          <NotificationsSettings />
        ) : section === 'context' ? (
          <ContextSettings />
        ) : section === 'models' ? (
          <SubmoduleHost
            component={ModelsSettings}
            title={text.missingTitle}
            body={text.missingBody}
            onDismiss={openAppearance}
          />
        ) : section === 'capabilities' ? (
          <SubmoduleHost
            component={CapabilitiesSettings}
            title={text.missingTitle}
            body={text.missingBody}
            onDismiss={openAppearance}
          />
        ) : section === 'shortcuts' ? (
          <ShortcutsSettings />
        ) : section === 'security' ? (
          <SecuritySettings />
        ) : section === 'devices' ? (
          <DevicesSettings />
        ) : section === 'data' ? (
          <DataSettings />
        ) : section === 'about' ? (
          <AboutSettings onOpenModels={() => select('models')} onShowOnboarding={onShowOnboarding} />
        ) : section === 'sync' ? (
          <SyncSettings />
        ) : (
          <UsageSettings onOpenRuns={openRuns} />
        )}
      </div>
    </div>
  )
}
