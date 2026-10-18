import type { SettingsSectionId } from '../types'

export interface SettingsSearchEntry {
  id: string
  section: SettingsSectionId
  tab?: string
  zh: string
  en: string
  keywords?: readonly string[]
  more?: boolean
}

export interface SettingsRevealTarget {
  section: SettingsSectionId
  tab?: string
  id: string
  revision: number
}

const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, '')

function scoreOf(entry: SettingsSearchEntry, needle: string, lang: string, sectionLabel: string): number {
  const label = normalize(lang === 'en-US' ? entry.en : entry.zh)
  const other = normalize(lang === 'en-US' ? entry.zh : entry.en)
  if (label.startsWith(needle)) return 5
  if (label.includes(needle)) return 4
  if (entry.keywords?.some((word) => normalize(word).includes(needle))) return 3
  if (other.includes(needle)) return 2
  if (normalize(sectionLabel).includes(needle)) return 1
  return 0
}

export function matchSettings(
  entries: readonly SettingsSearchEntry[],
  query: string,
  lang: string,
  sectionLabel: (section: SettingsSectionId) => string,
  limit = 30
): SettingsSearchEntry[] {
  const needle = normalize(query)
  if (!needle) return []
  return entries
    .map((entry, order) => ({ entry, order, score: scoreOf(entry, needle, lang, sectionLabel(entry.section)) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((hit) => hit.entry)
}

let current: SettingsRevealTarget | null = null
let revision = 0
const listeners = new Set<() => void>()

export function requestSettingReveal(entry: Pick<SettingsSearchEntry, 'section' | 'tab' | 'id'>): void {
  current = { section: entry.section, ...(entry.tab ? { tab: entry.tab } : {}), id: entry.id, revision: ++revision }
  for (const listener of listeners) listener()
}

export function subscribeSettingReveal(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSettingReveal(): SettingsRevealTarget | null {
  return current
}

export function settingSelector(id: string): string {
  return `[data-setting-id="${id.replace(/["\\]/g, '')}"]`
}
