import type { UIToolCall, WebSearchSourceView } from '../../../../../shared/ipc'

export type SearchAction = 'query' | 'fetch'

export interface SearchCommand {
  action: SearchAction
  queries: string[]
  url: string
}

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const YAN_BIN = /(?:^|[\\/])yan(?:\.mjs|\.cjs|\.js|\.cmd|\.exe|\.bat)?$/i
const SEGMENT_BREAK = new Set(['&&', '||', ';', '|', '&', '\n'])
const VALUE_FLAGS = new Set(['recent', 'site', 'timeout', 'timeout-ms', 'max-chars', 'sources', 'limit-per-source', 'limit-total', 'via'])
const MULTI_PART_TLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ne', 'or'])

function isEscapable(next: string | undefined): boolean {
  return next === '"' || next === "'" || next === '\\' || next === ' ' || next === '\t'
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote !== null) {
      if (ch === quote) {
        quote = null
        continue
      }
      if (ch === '\\' && quote === '"' && isEscapable(command[i + 1])) {
        current += command[++i]
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    if (ch === '\\' && isEscapable(command[i + 1])) {
      current += command[++i]
      started = true
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

function commandSegments(tokens: readonly string[]): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  for (const token of tokens) {
    if (SEGMENT_BREAK.has(token)) {
      if (current.length) segments.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length) segments.push(current)
  return segments
}

export function readFlags(tokens: readonly string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>()
  const add = (key: string, value: string): void => {
    const list = flags.get(key)
    if (list) list.push(value)
    else flags.set(key, [value])
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.startsWith('--') || token === '--') continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq > 0) {
      add(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = tokens[i + 1]
    if (next === undefined || next.startsWith('-')) {
      add(body, '')
      continue
    }
    add(body, next)
    if (VALUE_FLAGS.has(body)) i += 1
  }
  return flags
}

function firstFlag(flags: Map<string, string[]>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const values = (flags.get(key) ?? []).map((value) => value.trim()).filter(Boolean)
    if (values.length) return values
  }
  return []
}

export function parseSearchCommand(command: string | undefined | null): SearchCommand | null {
  if (typeof command !== 'string' || !command.trim()) return null
  for (const segment of commandSegments(tokenizeCommand(command))) {
    for (let i = 0; i + 2 < segment.length; i += 1) {
      if (!YAN_BIN.test(segment[i])) continue
      if (segment[i + 1] !== 'search') continue
      const action = segment[i + 2]
      if (action !== 'query' && action !== 'fetch') continue
      const flags = readFlags(segment.slice(i + 3))
      if (action === 'fetch') {
        const url = firstFlag(flags, ['url'])[0] ?? ''
        return url ? { action, queries: [], url } : null
      }
      const queries = firstFlag(flags, ['query-text', 'queryText', 'query', 'text'])
      return queries.length ? { action, queries, url: '' } : null
    }
  }
  return null
}

export function extractOperationId(output: string | undefined | null): string | null {
  if (typeof output !== 'string' || !output) return null
  const lines = output.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{') || !line.includes('operationId')) continue
    try {
      const parsed = JSON.parse(line) as { ok?: unknown; operationId?: unknown }
      if (parsed.ok === false) return null
      if (typeof parsed.operationId === 'string' && OPERATION_ID.test(parsed.operationId)) return parsed.operationId.toLowerCase()
    } catch {
      continue
    }
  }
  const fallback = /"operationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i.exec(output)
  return fallback ? fallback[1].toLowerCase() : null
}

export function normalizeUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const kept = [...url.searchParams.entries()].filter(([key]) => !/^utm_/i.test(key))
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  const search = new URLSearchParams()
  for (const [key, value] of kept) search.append(key, value)
  const query = search.toString()
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}${query ? `?${query}` : ''}`
}

export function domainOf(raw: string | undefined | null): string {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  try {
    return new URL(raw.trim()).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

export function siteLabel(domain: string): string {
  const host = domain.replace(/^www\./i, '').toLowerCase()
  if (!host) return ''
  if (/^[\d.]+$/.test(host)) return host
  const labels = host.split('.').filter(Boolean)
  if (labels.length <= 1) return host
  if (labels.length >= 3 && MULTI_PART_TLDS.has(labels[labels.length - 2]) && labels[labels.length - 1].length <= 3) {
    return labels[labels.length - 3]
  }
  return labels[labels.length - 2]
}

export function siteTone(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return hash % 6
}

export interface CitationRef {
  n: number
  title: string
  url: string
  domain: string
  site: string
  snippet: string
}

export function buildCitationIndex(sources: readonly WebSearchSourceView[]): Map<string, CitationRef> {
  const index = new Map<string, CitationRef>()
  let n = 0
  for (const source of sources) {
    const key = normalizeUrl(source.url)
    if (!key || index.has(key)) continue
    n += 1
    const domain = source.domain || domainOf(source.url)
    index.set(key, { n, title: source.title, url: source.url, domain, site: siteLabel(domain) || domain, snippet: source.snippet })
  }
  return index
}

export function citationFor(index: Map<string, CitationRef> | null | undefined, href: string | undefined | null): CitationRef | null {
  if (!index || !index.size || typeof href !== 'string') return null
  const key = normalizeUrl(href)
  return key ? index.get(key) ?? null : null
}

export interface SearchStep {
  command: SearchCommand
  operationId: string | null
  fromTool?: boolean
  sources?: WebSearchSourceView[]
}

export const DETAIL_SOURCES_MAX = 12

function httpDetailUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  return /^https?:\/\//i.test(raw) ? raw : ''
}

export function searchSourcesFromDetails(details: unknown): WebSearchSourceView[] | undefined {
  if (!details || typeof details !== 'object') return undefined
  const search = (details as Record<string, unknown>).search
  if (!search || typeof search !== 'object' || Array.isArray(search)) return undefined
  const entry = search as Record<string, unknown>
  if (entry.action === 'fetch') {
    const url = httpDetailUrl(entry.url)
    if (!url) return undefined
    const domain = domainOf(url)
    const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : domain || url
    return [{ title, url, domain, snippet: '', source: '' }]
  }
  if (entry.action !== 'query') return undefined
  const sources: WebSearchSourceView[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(entry.items) ? entry.items : []) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const url = httpDetailUrl(item.url)
    const key = normalizeUrl(url)
    if (!url || !key || seen.has(key)) continue
    seen.add(key)
    const domain = domainOf(url)
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : domain || url
    sources.push({ title, url, domain, snippet: typeof item.snippet === 'string' ? item.snippet : '', source: '' })
    if (sources.length >= DETAIL_SOURCES_MAX) break
  }
  return sources
}

function directSearchCommand(name: string, args: unknown): SearchCommand | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  if (name === 'web_fetch') {
    const url = httpDetailUrl(record.url)
    return url ? { action: 'fetch', queries: [], url } : null
  }
  if (name !== 'web_search') return null
  const query = typeof record.query === 'string' ? record.query.trim() : ''
  return query ? { action: 'query', queries: [query], url: '' } : null
}

export function searchStepOf(call: UIToolCall): SearchStep | null {
  if (call.cancelled || call.denied) return null
  if (call.status === 'error') return null
  const direct = directSearchCommand(call.name, call.args)
  if (direct) return { command: direct, operationId: null, fromTool: true, sources: searchSourcesFromDetails(call.details) }
  if (call.name !== 'bash' && call.name !== 'powershell' && call.name !== 'shell' && call.name !== 'run' && call.name !== 'exec') return null
  const args = call.args as Record<string, unknown> | undefined
  if (!args || typeof args !== 'object') return null
  const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : ''
  const parsed = parseSearchCommand(command)
  if (!parsed) return null
  return { command: parsed, operationId: extractOperationId(call.output) }
}

export function collectSearchOperationIds(tools: readonly UIToolCall[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const call of tools) {
    const step = searchStepOf(call)
    if (!step?.operationId || seen.has(step.operationId)) continue
    seen.add(step.operationId)
    ids.push(step.operationId)
  }
  return ids
}

export function collectSearchDetailSources(tools: readonly UIToolCall[]): WebSearchSourceView[] {
  const sources: WebSearchSourceView[] = []
  for (const call of tools) {
    const step = searchStepOf(call)
    if (step?.sources?.length) sources.push(...step.sources)
  }
  return sources
}

export function searchStepLabel(command: SearchCommand): string {
  if (command.action === 'fetch') return command.url
  return command.queries.join(' · ')
}
