import type { UIToolCall } from '../shared/ipc'

interface SearchRecordItem {
  title?: string
  url?: string
  text?: string
}

interface SearchRecord {
  queries?: string[]
  opened?: string[]
  results?: SearchRecordItem[]
  cited?: SearchRecordItem[]
  errors?: string[]
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [])
const items = (value: unknown): SearchRecordItem[] => (Array.isArray(value) ? value.filter((item): item is SearchRecordItem => !!item && typeof item === 'object' && typeof (item as SearchRecordItem).url === 'string') : [])

function readRecord(value: unknown): SearchRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  return { queries: strings(raw.queries), opened: strings(raw.opened), results: items(raw.results), cited: items(raw.cited), errors: strings(raw.errors) }
}

export function serverSearchCalls(message: { yanWebSearch?: unknown; timestamp?: number }, fallbackKey: string): UIToolCall[] {
  const record = readRecord(message.yanWebSearch)
  if (!record) return []
  const key = message.timestamp !== undefined ? String(message.timestamp) : fallbackKey
  const calls: UIToolCall[] = []
  const sources = new Map<string, { title: string; url: string; snippet: string; readState: 'discovered' | 'read' }>()
  for (const item of record.results ?? []) sources.set(item.url!, { title: item.title ?? '', url: item.url!, snippet: '', readState: 'discovered' })
  for (const item of record.cited ?? []) {
    const known = sources.get(item.url!)
    sources.set(item.url!, { title: known?.title || item.title || '', url: item.url!, snippet: known?.snippet || item.text || '', readState: 'read' })
  }
  const list = [...sources.values()]
  if (record.queries?.length) {
    calls.push({
      id: `server-search:${key}`,
      name: 'web_search',
      args: { queries: record.queries },
      status: record.errors?.length && !list.length ? 'error' : 'ok',
      serverSide: true,
      output: [...list.map((item) => `${item.title} — ${item.url}`), ...(record.errors ?? []).map((code) => `error: ${code}`)].join('\n'),
      details: { search: { action: 'query', items: list } }
    })
  }
  record.opened?.forEach((url, index) => {
    calls.push({
      id: `server-search:${key}:open${index}`,
      name: 'web_fetch',
      args: { url },
      status: 'ok',
      serverSide: true,
      details: { search: { action: 'fetch', url, title: sources.get(url)?.title ?? '' } }
    })
  })
  return calls
}
