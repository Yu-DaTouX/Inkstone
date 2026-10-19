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
  | 'shortcuts'
  | 'about'

export type SettingsNavGroupId = 'general' | 'customize' | 'local'

export interface SettingsSectionDef {
  readonly id: SettingsSectionId
  readonly group: SettingsNavGroupId
  readonly icon:
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
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'models', icon: 'key', group: 'general' },
  { id: 'appearance', icon: 'moon', group: 'general' },
  { id: 'session', icon: 'clock', group: 'general' },
  { id: 'notifications', icon: 'bell', group: 'general' },
  { id: 'security', icon: 'shield', group: 'general' },
  { id: 'capabilities', icon: 'sparkles', group: 'customize' },
  { id: 'devices', icon: 'smartphone', group: 'local' },
  { id: 'data', icon: 'hard-drive', group: 'local' },
  { id: 'usage', icon: 'chart', group: 'local' },
  { id: 'shortcuts', icon: 'keyboard', group: 'local' },
  { id: 'about', icon: 'info', group: 'local' }
]

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroupId[] = ['general', 'customize', 'local']

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
  voice: 'capabilities',
  knowledge: 'capabilities',
  packages: 'capabilities',
  market: 'capabilities',
  git: 'capabilities',
  usage: 'usage',
  ...GENERAL_LEGACY_MAP
}

const KNOWN_V2_VIEWS: readonly string[] = [
  'auth',
  'appearance',
  'input',
  'workspace',
  'capabilities',
  'voice',
  'devices',
  'about',
  'sound',
  'status',
  'knowledge',
  'packages',
  'market',
  'remote',
  'peer',
  'usage'
]

export type LegacyViewResolution =
  | { kind: 'section'; view: string; section: SettingsSectionId }
  | { kind: 'unmigrated'; view: string }
  | { kind: 'unknown'; view: string }

export function resolveLegacyView(view: string | null | undefined): LegacyViewResolution {
  const name = typeof view === 'string' ? view.trim() : ''
  if (isSettingsSectionId(name)) return { kind: 'section', view: name, section: name }
  const mapped = LEGACY_VIEW_TO_SECTION[name]
  if (mapped) return { kind: 'section', view: name, section: mapped }
  if (KNOWN_V2_VIEWS.includes(name)) return { kind: 'unmigrated', view: name }
  return { kind: 'unknown', view: name }
}

export interface SettingsNavGroup {
  readonly group: SettingsNavGroupId
  readonly sections: readonly SettingsSectionDef[]
}

export function groupSettingsSections(sections: readonly SettingsSectionDef[] = SETTINGS_SECTIONS): SettingsNavGroup[] {
  return SETTINGS_NAV_GROUPS.map((group) => ({ group, sections: sections.filter((section) => section.group === group) })).filter(
    (entry) => entry.sections.length > 0
  )
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
