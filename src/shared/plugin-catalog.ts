import builtinCatalog from '../../catalog/inkstone-plugins.json'

export const PLUGIN_CATALOG_URL = 'https://raw.githubusercontent.com/Yu-DaTouX/Inkstone/main/catalog/inkstone-plugins.json'
export const PLUGIN_CATALOG_SCHEMA = 1

export type PluginCatalogKind = 'export' | 'mcp' | 'pet' | 'link'
export type PluginCatalogLang = 'zh-CN' | 'en-US'

export interface PluginCatalogText {
  name?: string
  desc: string
  target?: string
  hint?: string
}

export interface PluginCatalogEntry {
  id: string
  kind: PluginCatalogKind
  name: string
  version: string
  url: string
  text: Partial<Record<PluginCatalogLang, PluginCatalogText>>
}

export interface PluginCatalogView {
  source: 'remote' | 'cache' | 'builtin'
  updatedAt: string
  fetchedAt: number | null
  plugins: PluginCatalogEntry[]
}

const CODE_BACKED: Record<Exclude<PluginCatalogKind, 'link'>, readonly string[]> = {
  export: ['hermes-inkstone'],
  mcp: ['codegraph'],
  pet: ['desktop-pet']
}
const KINDS: readonly PluginCatalogKind[] = ['export', 'mcp', 'pet', 'link']
const LANGS: readonly PluginCatalogLang[] = ['zh-CN', 'en-US']
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_ENTRIES = 40

function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? Array.from(text).slice(0, max).join('') : undefined
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 400) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}

function normalizeText(value: unknown): PluginCatalogText | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const desc = shortText(raw.desc, 400)
  if (!desc) return undefined
  const name = shortText(raw.name, 80)
  const target = shortText(raw.target, 400)
  const hint = shortText(raw.hint, 400)
  return { desc, ...(name ? { name } : {}), ...(target ? { target } : {}), ...(hint ? { hint } : {}) }
}

function normalizeEntry(value: unknown): PluginCatalogEntry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : null
  const kind = KINDS.find((item) => item === raw.kind)
  if (!id || !kind) return null
  if (kind !== 'link' && !CODE_BACKED[kind].includes(id)) return null
  const name = shortText(raw.name, 80)
  const url = httpsUrl(raw.url)
  if (!name || !url) return null
  const texts = (raw.text && typeof raw.text === 'object' ? raw.text : {}) as Record<string, unknown>
  const text: PluginCatalogEntry['text'] = {}
  for (const lang of LANGS) {
    const normalized = normalizeText(texts[lang])
    if (normalized) text[lang] = normalized
  }
  if (!text['zh-CN'] && !text['en-US']) return null
  return { id, kind, name, version: shortText(raw.version, 40) ?? '', url, text }
}

export function normalizePluginCatalog(value: unknown): { updatedAt: string; plugins: PluginCatalogEntry[] } | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.schema !== PLUGIN_CATALOG_SCHEMA || !Array.isArray(raw.plugins)) return null
  const seen = new Set<string>()
  const plugins: PluginCatalogEntry[] = []
  for (const item of raw.plugins.slice(0, MAX_ENTRIES)) {
    const entry = normalizeEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    plugins.push(entry)
  }
  return { updatedAt: shortText(raw.updatedAt, 40) ?? '', plugins }
}

const builtin = normalizePluginCatalog(builtinCatalog) ?? { updatedAt: '', plugins: [] }

export const BUILTIN_PLUGIN_CATALOG: PluginCatalogView = {
  source: 'builtin',
  updatedAt: builtin.updatedAt,
  fetchedAt: null,
  plugins: builtin.plugins
}

export function pluginText(entry: PluginCatalogEntry, lang: string): PluginCatalogText {
  const primary: PluginCatalogLang = lang === 'en-US' ? 'en-US' : 'zh-CN'
  const fallback: PluginCatalogLang = primary === 'en-US' ? 'zh-CN' : 'en-US'
  return entry.text[primary] ?? entry.text[fallback] ?? { desc: '' }
}
