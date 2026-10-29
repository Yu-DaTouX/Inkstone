import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type KeyboardEvent,
  type LazyExoticComponent,
  type ReactElement
} from 'react'
import {
  BarChart3,
  Bell,
  Clock,
  HardDrive,
  Info,
  KeyRound,
  Keyboard,
  Moon,
  Plug,
  Puzzle,
  ScrollText,
  Shield,
  Smartphone,
  Sparkles,
  Wrench
} from 'lucide-react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import {
  Button,
  Notice,
  SettingsDialog,
  SettingsNav,
  SettingsNavGroup,
  SettingsNavItem,
  SettingsSearch,
  SettingsTab,
  SettingsTabBar,
  Skeleton,
  useSettingsNarrow,
  type SettingsSearchResult
} from '../../../ui'
import { AppearanceSettings } from '../appearance/AppearanceSettings'
import { ShortcutsSettings } from '../shortcuts/ShortcutsSettings'
import { AboutSettings, DataSettings, DevicesSettings, NotificationsSettings, SecuritySettings, SessionSettings } from '../general'
import { useUiV3 } from '../../../state/ui-v3'
import { settingsText, type SettingsText } from '../settings-text'
import {
  DEFAULT_SETTINGS_SECTION,
  groupSettingsNav,
  resolveLegacyView,
  settingsNavEntries,
  type CapabilitiesTabId,
  type SettingsIconId,
  type SettingsNavEntry,
  type SettingsNavGroupId,
  type SettingsSectionId
} from '../types'
import { getSettingsRequest, lastSettingsSection, rememberSettingsSection, subscribeSettingsRequest } from './deep-link'
import { SECTION_LABEL, capabilitiesTabOfView, settingsNavLabel } from './nav-label'
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

const ModelsSettings = lazy(async () => ({ default: (await import('../models/index')).ModelsSettings }))
const CapabilitiesSettings = lazy(async () => ({ default: (await import('../capabilities/index')).CapabilitiesSettings }))

const ICON_SIZE = 20

const SECTION_ICON: Record<SettingsIconId, ReactElement> = {
  moon: <Moon size={ICON_SIZE} aria-hidden />,
  clock: <Clock size={ICON_SIZE} aria-hidden />,
  bell: <Bell size={ICON_SIZE} aria-hidden />,
  key: <KeyRound size={ICON_SIZE} aria-hidden />,
  sparkles: <Sparkles size={ICON_SIZE} aria-hidden />,
  shield: <Shield size={ICON_SIZE} aria-hidden />,
  smartphone: <Smartphone size={ICON_SIZE} aria-hidden />,
  'hard-drive': <HardDrive size={ICON_SIZE} aria-hidden />,
  chart: <BarChart3 size={ICON_SIZE} aria-hidden />,
  keyboard: <Keyboard size={ICON_SIZE} aria-hidden />,
  info: <Info size={ICON_SIZE} aria-hidden />,
  scroll: <ScrollText size={ICON_SIZE} aria-hidden />,
  plug: <Plug size={ICON_SIZE} aria-hidden />,
  wrench: <Wrench size={ICON_SIZE} aria-hidden />,
  puzzle: <Puzzle size={ICON_SIZE} aria-hidden />
}

const GROUP_LABEL: Partial<Record<SettingsNavGroupId, keyof SettingsText>> = {
  customize: 'groupCustomize',
  local: 'groupLocal'
}

const NAV_ENTRIES = settingsNavEntries()
const NAV_GROUPS = groupSettingsNav(NAV_ENTRIES)

const REVEAL_FRAMES = 90
const REVEAL_SETTLE_MS = 240
const FLASH_MS = 1950
const SEARCH_CHILDREN = 2

let lastCapabilitiesTab: CapabilitiesTabId = 'skills'

function navTestId(entry: SettingsNavEntry): string {
  return entry.tab ? `caps-tab-${entry.tab}` : `v3-settings-nav-${entry.section}`
}

function entryKeyOf(section: SettingsSectionId, tab?: string): string {
  return section === 'capabilities' ? `capabilities-${tab ?? 'skills'}` : section
}

interface SearchTarget {
  entry?: SettingsSearchEntry
  nav: SettingsNavEntry
}

function revealAnchor(node: HTMLElement): { anchor: HTMLElement; folded: boolean } {
  if (!node.closest('[inert]')) return { anchor: node, folded: false }
  let anchor: HTMLElement | null = null
  for (const row of Array.from(node.ownerDocument.querySelectorAll<HTMLElement>('[data-setting-id]'))) {
    if (row === node) break
    if (!row.closest('[inert]')) anchor = row
  }
  return { anchor: anchor ?? node, folded: true }
}

function useRevealScroll(foldedHint: string): void {
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
        const { anchor, folded } = revealAnchor(node)
        anchor.scrollIntoView({ block: 'center' })
        if (anchor.tabIndex < 0) anchor.tabIndex = -1
        anchor.focus({ preventScroll: true })
        anchor.setAttribute('data-flash', '1')
        if (folded) useStore.getState().notify('info', foldedHint)
        flash = setTimeout(() => anchor.removeAttribute('data-flash'), FLASH_MS)
      }, REVEAL_SETTLE_MS)
    }
    frame = requestAnimationFrame(seek)
    return () => {
      cancelAnimationFrame(frame)
      if (settle) clearTimeout(settle)
      if (flash) clearTimeout(flash)
    }
  }, [target, foldedHint])
}

function SettingsLoading({ label }: { label: string }): ReactElement {
  return (
    <div className="settings-loading" role="status">
      <span className="v3-visually-hidden">{label}</span>
      <Skeleton width="33%" height={20} />
      <Skeleton width="66%" height={20} />
      <Skeleton width="100%" height={20} />
    </div>
  )
}

function SubmoduleHost<P extends object>({
  component: Host,
  props
}: {
  component: LazyExoticComponent<ComponentType<P>>
  props: P
}): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)

  return (
    <Suspense fallback={<SettingsLoading label={text.loading} />}>
      <Host {...props} />
    </Suspense>
  )
}

function LegacyNotice({
  view,
  onDismiss,
  onBack
}: {
  view: string
  onDismiss: () => void
  onBack?: () => void
}): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const body = text.unknownBody.replace('{view}', view || text.unknownTitle)

  return (
    <section className="settings-section" data-testid="settings-legacy">
      <h3 className="settings-h2">{text.unknownTitle}</h3>
      <Notice tone="info" compact role="note">
        {body}
      </Notice>
      <div className="settings-actions">
        <Button variant="secondary" onPress={onDismiss}>
          {text.backToAppearance}
        </Button>
        {onBack ? (
          <Button variant="ghost" onPress={onBack}>
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
  const narrow = useSettingsNarrow()
  const [section, setSection] = useState<SettingsSectionId>(lastSettingsSection)
  const [capsTab, setCapsTab] = useState<CapabilitiesTabId>(lastCapabilitiesTab)
  const [legacy, setLegacy] = useState<{ view: string } | null>(null)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const sectionLabel = useCallback((id: SettingsSectionId): string => text[SECTION_LABEL[id]], [text])
  const navLabel = useCallback((entry: SettingsNavEntry): string => settingsNavLabel(entry, text), [text])
  useRevealScroll(text.revealFolded)

  const search = useMemo(() => {
    const targets = new Map<string, SearchTarget>()
    const results: SettingsSearchResult[] = []
    const needle = query.trim().toLowerCase()
    if (!needle) return { results, targets }
    const hits = matchSettings(SETTINGS_SEARCH_ENTRIES, query, lang, sectionLabel, 60)
    const order: string[] = []
    const byNav = new Map<string, SettingsSearchEntry[]>()
    for (const entry of NAV_ENTRIES) {
      if (navLabel(entry).toLowerCase().includes(needle)) {
        order.push(entry.key)
        byNav.set(entry.key, [])
      }
    }
    for (const hit of hits) {
      const key = entryKeyOf(hit.section, hit.tab)
      if (!byNav.has(key)) {
        order.push(key)
        byNav.set(key, [])
      }
      byNav.get(key)?.push(hit)
    }
    for (const key of order) {
      const nav = NAV_ENTRIES.find((entry) => entry.key === key)
      if (!nav) continue
      const entries = byNav.get(key) ?? []
      const heading = navLabel(nav)
      const [first, ...rest] = entries
      const firstLabel = first ? (lang === 'en-US' ? first.en : first.zh) : undefined
      const hitKey = `${key}:hit`
      targets.set(hitKey, { entry: first, nav })
      results.push({
        key: hitKey,
        kind: 'hit',
        icon: SECTION_ICON[nav.icon],
        primary: heading,
        secondary: firstLabel,
        label: firstLabel ? text.searchIn.replace('{label}', firstLabel).replace('{section}', heading) : heading,
        'data-testid': first ? `settings-hit-${first.id}` : `settings-hit-${key}`
      })
      for (const entry of rest.slice(0, SEARCH_CHILDREN)) {
        const label = lang === 'en-US' ? entry.en : entry.zh
        const childKey = `${key}:${entry.id}`
        targets.set(childKey, { entry, nav })
        results.push({
          key: childKey,
          kind: 'child',
          primary: label,
          label: text.searchIn.replace('{label}', label).replace('{section}', heading),
          'data-testid': `settings-hit-${entry.id}`
        })
      }
      const more = rest.length - SEARCH_CHILDREN
      if (more > 0) {
        const moreKey = `${key}:more`
        targets.set(moreKey, { nav })
        const moreText = text.searchMore.replace('{count}', String(more))
        results.push({ key: moreKey, kind: 'more', primary: moreText, label: `${moreText} · ${heading}` })
      }
    }
    return { results, targets }
  }, [query, lang, sectionLabel, navLabel, text])

  useEffect(() => {
    if (!request) return
    const tab = capabilitiesTabOfView(request.view)
    if (tab) {
      setSection('capabilities')
      setCapsTab(tab)
      setLegacy(null)
      return
    }
    const resolved = resolveLegacyView(request.view)
    if (resolved.kind === 'section' && resolved.section === 'usage') {
      useStore.getState().closeSettings()
      useUiV3.getState().navigate({ name: 'usage' })
    } else if (resolved.kind === 'section') {
      setSection(resolved.section)
      setLegacy(null)
    } else {
      setLegacy({ view: resolved.view })
    }
  }, [request])

  useEffect(() => {
    if (narrow) return
    const focusSearch = (): void => {
      const input = searchInput.current
      if (!input) return
      const active = document.activeElement
      const dialog = input.closest('.ui-settings')
      if (active && active !== input && dialog?.contains(active) && !active.matches('.ui-settings-dialog')) return
      input.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    }
    const frame = requestAnimationFrame(focusSearch)
    return () => cancelAnimationFrame(frame)
  }, [narrow])

  useEffect(() => {
    rememberSettingsSection(section)
    content.current?.closest('.ui-settings__content')?.scrollTo({ top: 0 })
  }, [section, capsTab])

  useEffect(() => {
    lastCapabilitiesTab = capsTab
  }, [capsTab])

  const selectEntry = useCallback((entry: SettingsNavEntry): void => {
    setSection(entry.section)
    if (entry.tab) setCapsTab(entry.tab)
    setLegacy(null)
  }, [])
  const openDefault = useCallback((): void => {
    setSection(DEFAULT_SETTINGS_SECTION)
    setLegacy(null)
  }, [])
  const chooseResult = useCallback(
    (result: SettingsSearchResult): void => {
      const target = search.targets.get(result.key)
      if (!target) return
      setQuery('')
      setLegacy(null)
      setSection(target.nav.section)
      if (target.nav.tab) setCapsTab(target.nav.tab)
      if (target.entry) requestSettingReveal(target.entry)
    },
    [search]
  )
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (narrow || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
    event.preventDefault()
    event.stopPropagation()
    searchInput.current?.focus()
    searchInput.current?.select()
  }

  const isCurrent = (entry: SettingsNavEntry): boolean =>
    !legacy && entry.section === section && (!entry.tab || entry.tab === capsTab)

  const nav = (
    <SettingsNav
      label={text.navLabel}
      search={
        <SettingsSearch
          ref={searchInput}
          value={query}
          onChange={setQuery}
          results={search.results}
          onSelect={chooseResult}
          label={text.searchLabel}
          placeholder={text.searchPlaceholder}
          resultsLabel={text.searchResults}
          emptyLabel={text.searchEmpty}
          data-testid="settings-search"
        />
      }
    >
      {NAV_GROUPS.map(({ group, entries }) => {
        const labelKey = GROUP_LABEL[group]
        return (
          <SettingsNavGroup key={group} title={labelKey ? text[labelKey] : undefined}>
            {entries.map((entry) => (
              <SettingsNavItem
                key={entry.key}
                icon={SECTION_ICON[entry.icon]}
                label={navLabel(entry)}
                current={isCurrent(entry)}
                onPress={() => selectEntry(entry)}
                data-testid={navTestId(entry)}
              />
            ))}
          </SettingsNavGroup>
        )
      })}
    </SettingsNav>
  )

  const narrowNav = (
    <SettingsTabBar label={text.navLabel}>
      {NAV_ENTRIES.map((entry) => (
        <SettingsTab
          key={entry.key}
          label={navLabel(entry)}
          selected={isCurrent(entry)}
          onPress={() => selectEntry(entry)}
          data-testid={navTestId(entry)}
        />
      ))}
    </SettingsTabBar>
  )

  const currentEntry = NAV_ENTRIES.find((entry) => isCurrent(entry))
  const pageTitle = currentEntry ? navLabel(currentEntry) : sectionLabel(section)

  return (
    <SettingsDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={legacy ? text.title : `${text.title} / ${pageTitle}`}
      closeLabel={text.close}
      nav={nav}
      narrowNav={narrowNav}
      narrow={narrow}
      onKeyDown={onDialogKeyDown}
      data-testid="settings-root"
    >
      {!settings ? (
        <SettingsLoading label={text.loading} />
      ) : (
        <div
          className="settings-main__col"
          key={legacy ? 'legacy' : section === 'capabilities' ? `capabilities-${capsTab}` : section}
          ref={content}
          data-page={legacy ? 'legacy' : section}
        >
          {legacy ? null : <h2 className="v3-visually-hidden settings-main__title">{pageTitle}</h2>}
          {legacy ? (
            <LegacyNotice view={legacy.view} onDismiss={openDefault} onBack={onClose} />
          ) : section === 'appearance' ? (
            <AppearanceSettings />
          ) : section === 'session' ? (
            <SessionSettings />
          ) : section === 'notifications' ? (
            <NotificationsSettings />
          ) : section === 'models' ? (
            <SubmoduleHost component={ModelsSettings} props={{}} />
          ) : section === 'capabilities' ? (
            <SubmoduleHost component={CapabilitiesSettings} props={{ tab: capsTab, onTabChange: setCapsTab }} />
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
          ) : null}
        </div>
      )}
    </SettingsDialog>
  )
}
