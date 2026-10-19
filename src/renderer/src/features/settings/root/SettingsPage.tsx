import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type LazyExoticComponent,
  type ReactElement
} from 'react'
import { BarChart3, Bell, Clock, HardDrive, Info, KeyRound, Keyboard, Moon, Shield, Smartphone, Sparkles } from 'lucide-react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import {
  Button,
  SearchField,
  SettingsDialog,
  SettingsNav,
  SettingsNavEmpty,
  SettingsNavGroup,
  SettingsNavItem
} from '../../../ui'
import { AppearanceSettings } from '../appearance/AppearanceSettings'
import { ShortcutsSettings } from '../shortcuts/ShortcutsSettings'
import { AboutSettings, DataSettings, DevicesSettings, NotificationsSettings, SecuritySettings, SessionSettings } from '../general'
import { UsageSettings } from '../usage/UsageSettings'
import { settingsText, type SettingsText } from '../settings-text'
import {
  DEFAULT_SETTINGS_SECTION,
  groupSettingsSections,
  resolveLegacyView,
  type SettingsNavGroupId,
  type SettingsSectionDef,
  type SettingsSectionId
} from '../types'
import { getSettingsRequest, lastSettingsSection, rememberSettingsSection, subscribeSettingsRequest } from './deep-link'
import { SETTINGS_SEARCH_ENTRIES } from '../search/entries'
import {
  getSettingReveal,
  matchSettings,
  requestSettingReveal,
  settingSelector,
  subscribeSettingReveal,
  type SettingsSearchEntry
} from '../search/search-model'
import '../settings.css'

type Submodule = LazyExoticComponent<() => ReactElement>

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
  moon: <Moon size={16} aria-hidden />,
  clock: <Clock size={16} aria-hidden />,
  bell: <Bell size={16} aria-hidden />,
  key: <KeyRound size={16} aria-hidden />,
  sparkles: <Sparkles size={16} aria-hidden />,
  shield: <Shield size={16} aria-hidden />,
  smartphone: <Smartphone size={16} aria-hidden />,
  'hard-drive': <HardDrive size={16} aria-hidden />,
  chart: <BarChart3 size={16} aria-hidden />,
  keyboard: <Keyboard size={16} aria-hidden />,
  info: <Info size={16} aria-hidden />
}

const SECTION_LABEL: Record<SettingsSectionId, keyof SettingsText> = {
  appearance: 'sectionAppearance',
  session: 'sectionSession',
  notifications: 'sectionNotifications',
  models: 'sectionModels',
  capabilities: 'sectionCapabilities',
  security: 'sectionSecurity',
  devices: 'sectionDevices',
  data: 'sectionData',
  usage: 'sectionUsage',
  shortcuts: 'sectionShortcuts',
  about: 'sectionAbout'
}

const GROUP_LABEL: Record<SettingsNavGroupId, keyof SettingsText> = {
  general: 'groupGeneral',
  customize: 'groupCustomize',
  local: 'groupLocal'
}

const REVEAL_FRAMES = 90
const REVEAL_SETTLE_MS = 240
const FLASH_MS = 1800

function useRevealScroll(): void {
  const target = useSyncExternalStore(subscribeSettingReveal, getSettingReveal, getSettingReveal)
  useEffect(() => {
    if (!target) return
    let frame = 0
    let tries = 0
    let settle: ReturnType<typeof setTimeout> | undefined
    let flash: ReturnType<typeof setTimeout> | undefined
    const seek = (): void => {
      const node = document.querySelector<HTMLElement>(settingSelector(target.id))
      if (!node) {
        if (++tries < REVEAL_FRAMES) frame = requestAnimationFrame(seek)
        return
      }
      settle = setTimeout(() => {
        node.scrollIntoView({ block: 'center' })
        if (node.tabIndex < 0) node.tabIndex = -1
        node.focus({ preventScroll: true })
        node.setAttribute('data-flash', '1')
        flash = setTimeout(() => node.removeAttribute('data-flash'), FLASH_MS)
      }, REVEAL_SETTLE_MS)
    }
    frame = requestAnimationFrame(seek)
    return () => {
      cancelAnimationFrame(frame)
      if (settle) clearTimeout(settle)
      if (flash) clearTimeout(flash)
    }
  }, [target])
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
        <Button variant="ghost" size="sm" onPress={onDismiss}>
          {text.backToAppearance}
        </Button>
      </div>
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
  const title =kind === 'unmigrated' ? text.unmigratedTitle : text.unknownTitle
  const body = (kind === 'unmigrated' ? text.unmigratedBody : text.unknownBody).replace('{view}', view || text.unknownTitle)

  return (
    <section className="settings-section" data-testid="settings-legacy">
      <h2 className="settings-h2">{title}</h2>
      <p className="settings-note" role="note">
        {body}
      </p>
      <div className="settings-actions">
        <Button variant="ghost" size="sm" onPress={onDismiss}>
          {text.backToAppearance}
        </Button>
        {onBack ? (
          <Button variant="ghost" size="sm" onPress={onBack}>
            {text.backToChat}
          </Button>
        ) : null}
      </div>
    </section>
  )
}

export interface SettingsPageProps {
  onClose: () => void
  onShowOnboarding?: () => void
}

export function SettingsPage({ onClose, onShowOnboarding }: SettingsPageProps): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const settings = useStore((s) => s.settings)
  const request = useSyncExternalStore(subscribeSettingsRequest, getSettingsRequest)
  const [section, setSection] = useState<SettingsSectionId>(lastSettingsSection)
  const [legacy, setLegacy] = useState<{ view: string; kind: 'unmigrated' | 'unknown' } | null>(null)
  const [query, setQuery] = useState('')
  const searchBox = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const sectionLabel = useCallback((id: SettingsSectionId): string => text[SECTION_LABEL[id]], [text])
  const hits = useMemo(
    () => matchSettings(SETTINGS_SEARCH_ENTRIES, query, lang, sectionLabel),
    [query, lang, sectionLabel]
  )
  useRevealScroll()

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

  useEffect(() => {
    const frame = requestAnimationFrame(() => searchBox.current?.querySelector('input')?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    rememberSettingsSection(section)
    content.current?.closest('.ui-settings__content')?.scrollTo({ top: 0 })
  }, [section])

  const select = useCallback((next: SettingsSectionId): void => {
    setSection(next)
    setLegacy(null)
  }, [])
  const openDefault = useCallback((): void => {
    setSection(DEFAULT_SETTINGS_SECTION)
    setLegacy(null)
  }, [])
  const reveal = useCallback((entry: SettingsSearchEntry): void => {
    setSection(entry.section)
    setLegacy(null)
    setQuery('')
    requestSettingReveal(entry)
  }, [])
  const focusSearch = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
    event.preventDefault()
    searchBox.current?.querySelector('input')?.focus()
  }

  const search = (
    <SearchField
      ref={searchBox}
      aria-label={text.searchLabel}
      placeholder={text.searchPlaceholder}
      value={query}
      onChange={setQuery}
      onSubmit={() => {
        if (hits[0]) reveal(hits[0])
      }}
      className="settings-search"
      data-testid="settings-search"
    />
  )

  const nav = (
    <SettingsNav label={text.navLabel} search={search}>
      {query.trim() ? (
        hits.length > 0 ? (
          <SettingsNavGroup>
            {hits.map((hit) => (
              <SettingsNavItem
                key={hit.id}
                label={lang === 'en-US' ? hit.en : hit.zh}
                hint={hit.more ? `${sectionLabel(hit.section)} · ${text.moreSettings}` : sectionLabel(hit.section)}
                onPress={() => reveal(hit)}
                data-testid={`settings-hit-${hit.id}`}
              />
            ))}
          </SettingsNavGroup>
        ) : (
          <SettingsNavEmpty>{text.searchEmpty}</SettingsNavEmpty>
        )
      ) : (
        groupSettingsSections().map(({ group, sections }) => (
          <SettingsNavGroup key={group} title={text[GROUP_LABEL[group]]}>
            {sections.map((entry) => (
              <SettingsNavItem
                key={entry.id}
                icon={SECTION_ICON[entry.icon]}
                label={text[SECTION_LABEL[entry.id]]}
                current={!legacy && entry.id === section}
                onPress={() => select(entry.id)}
                data-testid={`v3-settings-nav-${entry.id}`}
              />
            ))}
          </SettingsNavGroup>
        ))
      )}
    </SettingsNav>
  )

  return (
    <SettingsDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={text.title}
      closeLabel={text.close}
      nav={nav}
      onKeyDown={focusSearch}
      data-testid="settings-root"
    >
      {!settings ? (
        <p className="settings-loading" role="status">
          {text.loading}
        </p>
      ) : (
        <div className="settings-main__col" key={legacy ? 'legacy' : section} ref={content}>
          {legacy ? null : <h2 className="settings-h2 settings-main__title">{text[SECTION_LABEL[section]]}</h2>}
          {legacy ? (
            <LegacyNotice view={legacy.view} kind={legacy.kind} onDismiss={openDefault} onBack={onClose} />
          ) : section === 'appearance' ? (
            <AppearanceSettings />
          ) : section === 'session' ? (
            <SessionSettings />
          ) : section === 'notifications' ? (
            <NotificationsSettings />
          ) : section === 'models' ? (
            <SubmoduleHost
              component={ModelsSettings}
              title={text.missingTitle}
              body={text.missingBody}
              onDismiss={openDefault}
            />
          ) : section === 'capabilities' ? (
            <SubmoduleHost
              component={CapabilitiesSettings}
              title={text.missingTitle}
              body={text.missingBody}
              onDismiss={openDefault}
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
            <AboutSettings onShowOnboarding={onShowOnboarding} />
          ) : (
            <UsageSettings />
          )}
        </div>
      )}
    </SettingsDialog>
  )
}
