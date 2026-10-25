export type SearchSourceId = 'wikipedia' | 'arxiv' | 'hackernews' | 'brave' | 'tavily' | 'ddg' | 'deepseek'

export interface SearchSource {
  id: SearchSourceId
  app: string
  subcommand: string
  label: string
  needsBrowser: boolean
  urlKind: 'direct' | 'hackernews'
  direct?: boolean
}

export const SEARCH_SOURCES: readonly SearchSource[] = [
  { id: 'wikipedia', app: 'wikipedia', subcommand: 'search', label: '维基百科', needsBrowser: false, urlKind: 'direct' },
  { id: 'arxiv', app: 'arxiv', subcommand: 'search', label: 'arXiv', needsBrowser: false, urlKind: 'direct' },
  { id: 'hackernews', app: 'hackernews', subcommand: 'search', label: 'Hacker News', needsBrowser: false, urlKind: 'hackernews' },
  { id: 'brave', app: '', subcommand: '', label: 'Brave 搜索', needsBrowser: false, urlKind: 'direct', direct: true },
  { id: 'tavily', app: '', subcommand: '', label: 'Tavily 搜索', needsBrowser: false, urlKind: 'direct', direct: true },
  { id: 'deepseek', app: '', subcommand: '', label: 'DeepSeek 搜索', needsBrowser: false, urlKind: 'direct', direct: true },
  { id: 'ddg', app: '', subcommand: '', label: 'DuckDuckGo', needsBrowser: false, urlKind: 'direct', direct: true }
]

export const DEFAULT_SEARCH_SOURCES: readonly SearchSourceId[] = SEARCH_SOURCES.filter((s) => !s.direct).map((s) => s.id)

export const SEARCH_LIMIT_PER_SOURCE_DEFAULT = 6
export const SEARCH_LIMIT_PER_SOURCE_MAX = 20
export const SEARCH_LIMIT_TOTAL_DEFAULT = 12
export const SEARCH_LIMIT_TOTAL_MAX = 40
export const SEARCH_TIMEOUT_MS_DEFAULT = 20_000
export const SEARCH_TIMEOUT_MS_MAX = 60_000
export const SEARCH_OUTPUT_MAX_BYTES = 512 * 1024
export const SEARCH_SNIPPET_MAX = 280
export const SEARCH_SUMMARY_MAX = 3000
export const SEARCH_URL_MAX = 8192
export const SEARCH_QUERY_MAX = 200
export const SEARCH_QUERIES_MAX = 5
export const SEARCH_SITES_MAX = 5
export const SEARCH_CONTENT_MAX = 3000

export type SearchRecency = 'day' | 'week' | 'month' | 'year'
export const SEARCH_RECENCIES: readonly SearchRecency[] = ['day', 'week', 'month', 'year']

export interface SearchModifiers {
  recent?: SearchRecency
  sites?: string[]
  question?: string
  withContent?: boolean
}

export interface SearchQuery extends SearchModifiers {
  text: string
  sources?: SearchSourceId[]
  limitPerSource?: number
  limitTotal?: number
  timeoutMs?: number
}

export interface SearchItem {
  title: string
  url: string
  snippet?: string
  summary?: string
  quality?: { provider: 'deepseek'; rerank_score?: number; authority?: number }
  source: SearchSourceId
  published?: string
  content?: string
  meta?: Record<string, string | number>
}

export type SourceStatusKind = 'ok' | 'empty' | 'error' | 'timeout' | 'unavailable' | 'skipped'

export interface PerSourceStatus {
  source: SearchSourceId
  status: SourceStatusKind
  count: number
  droppedByLimit?: number
  code?: string
  message?: string
  elapsedMs: number
}

export interface SearchOutcome {
  query: string
  items: SearchItem[]
  sources: PerSourceStatus[]
  truncated: boolean
  durationMs: number
  error?: { code: string; message: string }
  ignoredSources?: string[]
}

export interface SearchBackendStatus {
  available: boolean
  version: string | null
  detail: string
  code?: string
  sources: { id: SearchSourceId; label: string; needsBrowser: boolean; ready: boolean }[]
}

export type SearchProviderId = 'brave' | 'tavily' | 'firecrawl' | 'context7'

export interface SearchProvider {
  id: SearchProviderId
  label: string
  keyUrl: string
  envName: string
  keyOptional?: boolean
}

export const SEARCH_PROVIDERS: readonly SearchProvider[] = [
  { id: 'tavily', label: 'Tavily', keyUrl: 'https://app.tavily.com/', envName: 'TAVILY_API_KEY' },
  { id: 'brave', label: 'Brave Search', keyUrl: 'https://brave.com/search/api/', envName: 'BRAVE_API_KEY' },
  { id: 'firecrawl', label: 'Firecrawl', keyUrl: 'https://www.firecrawl.dev/app/api-keys', envName: 'FIRECRAWL_API_KEY' },
  { id: 'context7', label: 'Context7', keyUrl: 'https://context7.com/dashboard', envName: 'CONTEXT7_API_KEY', keyOptional: true }
]

export function isSearchProviderId(value: unknown): value is SearchProviderId {
  return SEARCH_PROVIDERS.some((provider) => provider.id === value)
}

export interface SearchProviderState {
  configured: boolean
  source?: 'file' | 'env'
}

export interface SearchApiConfigView {
  configured: boolean
  hintDismissed: boolean
  providers: Record<SearchProviderId, SearchProviderState>
  deepseekModelKey: boolean
}
