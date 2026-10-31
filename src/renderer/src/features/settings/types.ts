import { GENERAL_LEGACY_MAP } from './general/general-model'

export type SettingsSectionId =
  | 'models'
  | 'appearance'
  | 'session'
  | 'notifications'
  | 'security'
  | 'capabilities'
  | 'devices'
  | 'data'
  | 'usage'
  | 'code'
  | 'shortcuts'
  | 'about'

export type SettingsNavGroupId = 'general' | 'agents' | 'code' | 'connections' | 'maintenance'

export type CapabilitiesTabId = 'skills' | 'mcp' | 'tools' | 'market'

export const CAPABILITIES_TABS: readonly CapabilitiesTabId[] = ['skills', 'mcp', 'tools', 'market']

export type SettingsIconId =
  | 'moon'
  | 'clock'
  | 'bell'
  | 'key'
  | 'sparkles'
  | 'shield'
  | 'smartphone'
  | 'hard-drive'
  | 'chart'
  | 'keyboard'
  | 'info'
  | 'scroll'
  | 'plug'
  | 'wrench'
  | 'puzzle'
  | 'git-branch'

export interface SettingsSectionDef {
  readonly id: SettingsSectionId
  readonly group: SettingsNavGroupId
  readonly icon: SettingsIconId
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'appearance', icon: 'moon', group: 'general' },
  { id: 'session', icon: 'clock', group: 'general' },
  { id: 'notifications', icon: 'bell', group: 'general' },
  { id: 'security', icon: 'shield', group: 'general' },
  { id: 'shortcuts', icon: 'keyboard', group: 'general' },
  { id: 'models', icon: 'key', group: 'agents' },
  { id: 'capabilities', icon: 'sparkles', group: 'agents' },
  { id: 'code', icon: 'git-branch', group: 'code' },
  { id: 'devices', icon: 'smartphone', group: 'connections' },
  { id: 'data', icon: 'hard-drive', group: 'connections' },
  { id: 'about', icon: 'info', group: 'maintenance' }
]

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroupId[] = ['general', 'agents', 'code', 'connections', 'maintenance']

const CAPABILITIES_TAB_ICON: Record<CapabilitiesTabId, SettingsIconId> = {
  skills: 'scroll',
  mcp: 'plug',
  tools: 'wrench',
  market: 'puzzle'
}

export interface SettingsNavEntry {
  readonly key: string
  readonly section: SettingsSectionId
  readonly tab?: CapabilitiesTabId
  readonly group: SettingsNavGroupId
  readonly icon: SettingsIconId
}

export function settingsNavEntries(sections: readonly SettingsSectionDef[] = SETTINGS_SECTIONS): SettingsNavEntry[] {
  return sections.flatMap((section): SettingsNavEntry[] =>
    section.id === 'capabilities'
      ? CAPABILITIES_TABS.map((tab) => ({
          key: `capabilities-${tab}`,
          section: section.id,
          tab,
          group: section.group,
          icon: CAPABILITIES_TAB_ICON[tab]
        }))
      : [{ key: section.id, section: section.id, group: section.group, icon: section.icon }]
  )
}

export function groupSettingsNav(entries: readonly SettingsNavEntry[] = settingsNavEntries()): { group: SettingsNavGroupId; entries: SettingsNavEntry[] }[] {
  return SETTINGS_NAV_GROUPS.map((group) => ({ group, entries: entries.filter((entry) => entry.group === group) })).filter(
    (entry) => entry.entries.length > 0
  )
}

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'models'

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return (
    value === 'models' ||
    value === 'appearance' ||
    value === 'session' ||
    value === 'notifications' ||
    value === 'security' ||
    value === 'capabilities' ||
    value === 'devices' ||
    value === 'data' ||
    value === 'usage' ||
    value === 'code' ||
    value === 'shortcuts' ||
    value === 'about'
  )
}

const LEGACY_VIEW_TO_SECTION: Record<string, SettingsSectionId> = {
  appearance: 'appearance',
  input: 'appearance',
  sound: 'appearance',
  context: 'session',
  sync: 'data',
  auth: 'models',
  models: 'models',
  capabilities: 'capabilities',
  skills: 'capabilities',
  mcp: 'capabilities',
  tools: 'capabilities',
  voice: 'capabilities',
  knowledge: 'capabilities',
  packages: 'capabilities',
  market: 'capabilities',
  git: 'code',
  github: 'code',
  android: 'capabilities',
  usage: 'usage',
  ...GENERAL_LEGACY_MAP
}

export type LegacyViewResolution =
  | { kind: 'section'; view: string; section: SettingsSectionId }
  | { kind: 'unknown'; view: string }

export function resolveLegacyView(view: string | null | undefined): LegacyViewResolution {
  const name = typeof view === 'string' ? view.trim() : ''
  if (isSettingsSectionId(name)) return { kind: 'section', view: name, section: name }
  const mapped = LEGACY_VIEW_TO_SECTION[name]
  if (mapped) return { kind: 'section', view: name, section: mapped }
  return { kind: 'unknown', view: name }
}

export interface SettingsNavGroup {
  readonly group: SettingsNavGroupId
  readonly sections: readonly SettingsSectionDef[]
}

export function settingsViewFromHash(hash: string): string | null {
  const path = hash.replace(/^#\/?/, '').split('?')[0]
  const [head, view, ...rest] = path.split('/')
  if (head !== 'settings' || rest.some(Boolean)) return null
  if (!view) return ''
  try {
    return decodeURIComponent(view)
  } catch {
    return null
  }
}
