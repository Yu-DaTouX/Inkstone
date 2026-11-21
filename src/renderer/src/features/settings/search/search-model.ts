import type { SettingsSectionId } from '../types'

export interface SettingsSearchEntry {
  id: string
  section: SettingsSectionId
  tab?: string
  zh: string
  en: string
  keywords?: readonly string[]
  more?: boolean
  requires?: 'voice-plugin'
}

export interface SettingsRevealTarget {
  section: SettingsSectionId
  tab?: string
  id: string
  revision: number
}

const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, '')

interface SearchFields {
  zh: string
  en: string
  keywords: readonly string[]
}

const searchFields = new WeakMap<SettingsSearchEntry, SearchFields>()

function fieldsOf(entry: SettingsSearchEntry): SearchFields {
  const cached = searchFields.get(entry)
  if (cached) return cached
  const fields = { zh: normalize(entry.zh), en: normalize(entry.en), keywords: entry.keywords?.map(normalize) ?? [] }
  searchFields.set(entry, fields)
  return fields
}

function scoreOf(fields: SearchFields, needle: string, en: boolean): number {
  const label = en ? fields.en : fields.zh
  const other = en ? fields.zh : fields.en
  if (label.startsWith(needle)) return 5
  if (label.includes(needle)) return 4
  if (fields.keywords.some((word) => word.includes(needle))) return 3
  return other.includes(needle) ? 2 : 0
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
  const buckets: SettingsSearchEntry[][] = [[], [], [], [], []]
  const sections = new Map<SettingsSectionId, boolean>()
  const en = lang === 'en-US'
  for (const entry of entries) {
    const score = scoreOf(fieldsOf(entry), needle, en)
    if (score > 0) {
      buckets[5 - score].push(entry)
    } else {
      let matches = sections.get(entry.section)
      if (matches === undefined) {
        matches = normalize(sectionLabel(entry.section)).includes(needle)
        sections.set(entry.section, matches)
      }
      if (matches) buckets[4].push(entry)
    }
  }
  return buckets.flat().slice(0, limit)
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
