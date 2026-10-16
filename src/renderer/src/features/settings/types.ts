import { GENERAL_LEGACY_MAP } from './general/general-model'

export type SettingsSectionId =
  | 'appearance'
  | 'session'
  | 'notifications'
  | 'context'
  | 'models'
  | 'capabilities'
  | 'security'
  | 'devices'
  | 'data'
  | 'usage'
  | 'shortcuts'
  | 'about'
  | 'sync'

export interface SettingsSectionDef {
  readonly id: SettingsSectionId
  readonly icon:
    | 'moon'
    | 'clock'
    | 'bell'
    | 'gauge'
    | 'key'
    | 'sparkles'
    | 'shield'
    | 'smartphone'
    | 'hard-drive'
    | 'chart'
    | 'keyboard'
    | 'info'
    | 'refresh'
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'appearance', icon: 'moon' },
  { id: 'session', icon: 'clock' },
  { id: 'notifications', icon: 'bell' },
  { id: 'context', icon: 'gauge' },
  { id: 'models', icon: 'key' },
  { id: 'capabilities', icon: 'sparkles' },
  { id: 'security', icon: 'shield' },
  { id: 'devices', icon: 'smartphone' },
  { id: 'data', icon: 'hard-drive' },
  { id: 'usage', icon: 'chart' },
  { id: 'shortcuts', icon: 'keyboard' },
  { id: 'about', icon: 'info' },
  { id: 'sync', icon: 'refresh' }
]

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'appearance'

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return (
    value === 'appearance' ||
    value === 'session' ||
    value === 'notifications' ||
    value === 'context' ||
    value === 'models' ||
    value === 'capabilities' ||
    value === 'security' ||
    value === 'devices' ||
    value === 'data' ||
    value === 'usage' ||
    value === 'shortcuts' ||
    value === 'about' ||
    value === 'sync'
  )
}

const LEGACY_VIEW_TO_SECTION: Record<string, SettingsSectionId> = {
  appearance: 'appearance',
  input: 'appearance',
  sound: 'appearance',
  context: 'context',
  auth: 'models',
  models: 'models',
  capabilities: 'capabilities',
  voice: 'capabilities',
  knowledge: 'capabilities',
  packages: 'capabilities',
  market: 'capabilities',
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
