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

export interface SettingsSectionDef {
  readonly id: SettingsSectionId
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
  { id: 'models', icon: 'key' },
  { id: 'appearance', icon: 'moon' },
  { id: 'session', icon: 'clock' },
  { id: 'notifications', icon: 'bell' },
  { id: 'security', icon: 'shield' },
  { id: 'capabilities', icon: 'sparkles' },
  { id: 'devices', icon: 'smartphone' },
  { id: 'data', icon: 'hard-drive' },
  { id: 'usage', icon: 'chart' },
  { id: 'shortcuts', icon: 'keyboard' },
  { id: 'about', icon: 'info' }
]

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
