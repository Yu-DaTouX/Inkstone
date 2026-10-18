import type { SettingsSearchEntry } from './search-model'
import { CAPABILITIES_SEARCH_ENTRIES } from './entries-capabilities'
import { DATA_SEARCH_ENTRIES } from './entries-data'
import { GENERAL_SEARCH_ENTRIES } from './entries-general'
import { MODELS_SEARCH_ENTRIES } from './entries-models'

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  ...MODELS_SEARCH_ENTRIES,
  ...GENERAL_SEARCH_ENTRIES,
  ...CAPABILITIES_SEARCH_ENTRIES,
  ...DATA_SEARCH_ENTRIES
]
