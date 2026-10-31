import type { SettingsText } from '../settings-text'
import { CAPABILITIES_TABS, type CapabilitiesTabId, type SettingsNavEntry, type SettingsSectionId } from '../types'

export const SECTION_LABEL: Record<SettingsSectionId, keyof SettingsText> = {
  appearance: 'sectionAppearance',
  session: 'sectionSession',
  notifications: 'sectionNotifications',
  models: 'sectionModels',
  capabilities: 'sectionCapabilities',
  security: 'sectionSecurity',
  devices: 'sectionDevices',
  data: 'sectionData',
  usage: 'sectionUsage',
  code: 'sectionCode',
  shortcuts: 'sectionShortcuts',
  about: 'sectionAbout'
}

export const TAB_LABEL: Record<CapabilitiesTabId, keyof SettingsText> = {
  skills: 'navSkills',
  mcp: 'navMcp',
  tools: 'navTools',
  market: 'navMarket'
}

export function settingsNavLabel(entry: SettingsNavEntry, text: SettingsText): string {
  return entry.tab ? text[TAB_LABEL[entry.tab]] : text[SECTION_LABEL[entry.section]]
}

export function capabilitiesTabOfView(view: string): CapabilitiesTabId | null {
  const match = /^capabilities-(.+)$/.exec(view)
  const tab = match?.[1]
  return tab && (CAPABILITIES_TABS as readonly string[]).includes(tab) ? (tab as CapabilitiesTabId) : null
}
