export const ERR_ABORTED = -3

export interface BrowserLoadFailure {
  code: number
  description: string
  url: string
}

export function shouldSurfaceLoadError(errorCode: number, isMainFrame: boolean): boolean {
  if (!isMainFrame) return false
  return errorCode !== ERR_ABORTED
}

export interface SearchEnginePreset {
  id: string
  name: string
  template: string
}

export const SEARCH_ENGINE_PRESETS: readonly SearchEnginePreset[] = [
  { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s' },
  { id: 'baidu', name: '百度', template: 'https://www.baidu.com/s?wd=%s' },
  { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' }
]

export const DEFAULT_SEARCH_ENGINE = 'bing'
const SEARCH_TEMPLATE_MAX = 512

export function isSearchTemplate(value: string): boolean {
  if (value.length > SEARCH_TEMPLATE_MAX || !value.includes('%s')) return false
  try {
    const url = new URL(value.replace(/%s/g, 'q'))
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function normalizeSearchEngine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed === DEFAULT_SEARCH_ENGINE) return undefined
  if (SEARCH_ENGINE_PRESETS.some((preset) => preset.id === trimmed)) return trimmed
  return isSearchTemplate(trimmed) ? trimmed : undefined
}

export function searchEnginePreset(setting: string | undefined): SearchEnginePreset | undefined {
  const id = setting || DEFAULT_SEARCH_ENGINE
  return SEARCH_ENGINE_PRESETS.find((preset) => preset.id === id)
}

export function searchTemplateFor(setting: string | undefined): string {
  const preset = searchEnginePreset(setting)
  if (preset) return preset.template
  return setting && isSearchTemplate(setting) ? setting : SEARCH_ENGINE_PRESETS[0].template
}

export function searchUrl(query: string, setting?: string): string {
  return searchTemplateFor(setting).replace(/%s/g, encodeURIComponent(query))
}

const LOCAL_ADDRESS = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i
const HOST_ADDRESS = /^[^\s/?#]+\.[a-z\d-]{2,}\.?(?::\d+)?(?:[/?#]|$)/i

export function addressTarget(raw: string, searchEngine?: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^about:/i.test(value)) return value
  if (/\s/.test(value)) return searchUrl(value, searchEngine)
  if (LOCAL_ADDRESS.test(value)) return `http://${value}`
  if (HOST_ADDRESS.test(value)) return `https://${value}`
  return searchUrl(value, searchEngine)
}

export function isBlankAddress(url: string | undefined): boolean {
  return !url || url === 'about:blank'
}

export function nextAddressInput(committed: string, draft: string, dirty: boolean): string {
  return dirty ? draft : committed
}

export function failureUrl(validatedUrl: string | undefined | null, fallback: string): string {
  const value = (validatedUrl ?? '').trim()
  return value || fallback
}

export function sameCommittedUrl(a: string, b: string): boolean {
  const trim = (value: string): string => value.replace(/\/+$/, '')
  return trim(a ?? '') === trim(b ?? '')
}
