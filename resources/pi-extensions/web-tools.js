import { callHostTool, toolText } from './host-tool-call.js'

const SOURCE_IDS = ['ddg', 'deepseek', 'tavily', 'brave', 'wikipedia', 'arxiv', 'hackernews']
const take = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : ''
const snippet = (value) => typeof value === 'string' ? value.length > 240 ? `${value.slice(0, 239)}…` : value : ''
const rootOf = (data) => data?.data ?? data ?? {}

export function searchText(data) {
  const root = rootOf(data)
  const queries = Array.isArray(root.queries) ? root.queries : [root]
  const output = queries.map((query) => {
    const lines = [`Query: ${query.query ?? ''}`, `Fetched: ${query.fetchedAt ?? 'unknown'}; cache: ${query.cached ? 'hit' : 'miss'}${query.cacheAgeMs !== undefined ? `; age: ${query.cacheAgeMs}ms` : ''}`, 'Search snippets and provider summaries are not verified page text.']
    if (query.error) lines.push(`Error: ${JSON.stringify(query.error)}`)
    for (const source of query.sources ?? []) lines.push(`Source ${source.source}: ${source.status}; ${source.count ?? 0} results; ${source.elapsedMs ?? 0}ms${source.message ? `; ${source.message}` : ''}${source.code ? ` (${source.code})` : ''}${source.usage ? `; usage: ${JSON.stringify(source.usage)}` : ''}`)
    for (const [index, item] of (query.items ?? []).entries()) {
      lines.push(`${index + 1}. ${take(item.title, 200)}\nURL: ${item.url}\nFound via: ${(item.sources ?? [item.source]).join(', ')}${item.published ? `; published: ${item.published}` : '; published: unknown'}${item.groupId ? `; content group: ${item.groupId}` : ''}`)
      if (item.snippet) lines.push(`Snippet: ${take(item.snippet, 400)}`)
      if (item.summary) lines.push(`Provider summary: ${take(item.summary, 3000)}`)
      if (item.content) lines.push(`Provider page excerpt (bounded): ${take(item.content, 3000)}`)
      if (item.quality) lines.push(`Provider-specific quality (not comparable across providers): ${JSON.stringify(item.quality)}`)
    }
    if (!(query.items?.length)) lines.push('No results returned; see source states above.')
    if (query.truncated) lines.push('Result list truncated by the requested limits.')
    return lines.join('\n')
  }).join('\n\n')
  return output.length > 60000 ? `${output.slice(0, 60000)}\n[Search output truncated; narrow the query or fetch relevant source pages.]` : output
}

export function pageText(data) {
  const page = rootOf(data)
  const lines = [`# ${take(page.title, 200)}`, `URL: ${page.url ?? ''}`, `Final URL: ${page.finalUrl ?? page.url ?? ''}`, `Page reference: ${page.pageRef ?? 'unavailable'}`, `Fetched: ${page.fetchedAt ?? 'unknown'}; cache: ${page.cached ? 'hit' : 'miss'}${page.cacheAgeMs !== undefined ? `; age: ${page.cacheAgeMs}ms` : ''}`]
  if (page.publishedAt || page.modifiedAt) lines.push(`Published: ${page.publishedAt ?? 'unknown'}; modified: ${page.modifiedAt ?? 'unknown'}`)
  if (page.note) lines.push(`Note: ${page.note}`)
  if (page.action === 'find') lines.push(`Matches: ${JSON.stringify(page.matches ?? [])}`)
  else if (page.action === 'links') lines.push(`Links (${page.totalLinks ?? 0} total): ${JSON.stringify(page.links ?? [])}`)
  else {
    lines.push(`Read via: ${page.via ?? 'unknown'}; extraction: ${page.extraction ?? 'remote'}; format: ${page.format ?? 'text'}`, `Range: ${page.offset ?? 0}–${page.endOffset ?? page.text?.length ?? 0}; stored: ${page.storedChars ?? page.totalChars ?? '?'} characters; lines ${page.startLine ?? '?'}–${page.endLine ?? '?'}${page.pageCount ? `; PDF pages: ${page.pageCount}` : ''}`)
    if (page.sourceTruncated) lines.push('Source capture was truncated; the snapshot does not contain the complete source.')
    else if (page.truncated) lines.push('More text is available in this snapshot.')
    else lines.push('Reached the end of the captured text.')
    if (page.pages) lines.push(`PDF page offsets: ${JSON.stringify(page.pages)}`)
    lines.push('', take(page.text ?? page.content, 40000))
  }
  if (page.nextOffset !== undefined) lines.push(`\nContinue with pageRef=${page.pageRef}, offset=${page.nextOffset}, action=${page.action ?? 'read'}.`)
  return lines.join('\n')
}

function searchDetails(data) {
  const root = rootOf(data)
  const queries = Array.isArray(root.queries) ? root.queries : [root]
  const items = []
  const seen = new Set()
  for (const query of queries) for (const item of query.items ?? []) {
    if (!/^https?:\/\//i.test(item.url ?? '') || seen.has(item.url)) continue
    seen.add(item.url)
    items.push({ title: take(item.title, 200), url: item.url, snippet: snippet(item.snippet), ...(item.published ? { published: item.published } : {}), ...(query.fetchedAt ? { fetchedAt: query.fetchedAt } : {}), readState: 'discovered' })
    if (items.length === 12) return items
  }
  return items
}

export function createWebTools(call = callHostTool) {
  const execute = async (name, command, params, toolCallId, signal, ctx, format, detail) => {
    const result = await call({ command, params, toolCallId, signal, cwd: ctx?.cwd })
    if (!result.ok) return toolText(`${name} failed: ${result.error}${result.data ? `\n${JSON.stringify(rootOf(result.data)).slice(0, 5000)}` : ''}`, { code: result.code }, !result.cancelled)
    return toolText(format(result.data), { summary: result.summary, ...detail(result.data) })
  }
  return [
    {
      name: 'web_search', label: 'Web search',
      description: 'Search public web pages. Returns candidate links, snippets, dates and source states. Configured paid sources may charge. Use web_fetch for original text. Identical requests cache for 10 minutes; refresh bypasses it.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200 },
          queries: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 5, description: 'Batch alternative queries instead of query.' },
          question: { type: 'string', description: 'Original question, when different from the query.' },
          recent: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
          site: { type: 'string', description: 'Required domains, comma-separated, at most 5.' },
          excludeSites: { type: 'array', items: { type: 'string' }, maxItems: 5 },
          language: { type: 'string', description: 'Search language code, e.g. en or zh; best effort.' },
          country: { type: 'string', description: 'Country code, e.g. AU; best effort, unrelated to answer language.' },
          after: { type: 'string', description: 'Publication date lower bound YYYY-MM-DD; best effort.' },
          before: { type: 'string', description: 'Publication date upper bound YYYY-MM-DD; best effort.' },
          sources: { type: 'array', items: { type: 'string', enum: SOURCE_IDS }, maxItems: 7 },
          coverage: { type: 'string', enum: ['fast', 'broad'], description: 'fast uses normal fallback; broad queries all configured sources, which may cost more.' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
          withContent: { type: 'boolean' },
          refresh: { type: 'boolean' }
        }
      },
      async execute(id, params, signal, _update, ctx) {
        if (!(typeof params?.query === 'string' && params.query.trim()) && !(Array.isArray(params?.queries) && params.queries.some((query) => typeof query === 'string' && query.trim()))) return toolText('query or queries is required', {}, true)
        return execute('web_search', 'search.query', params ?? {}, id, signal, ctx, searchText, (data) => ({ search: { action: 'query', query: params?.query ?? params?.queries?.join(' · ') ?? '', items: searchDetails(data) } }))
      }
    },
    {
      name: 'web_fetch', label: 'Web fetch',
      description: 'Read public page or PDF text, find literal text, or list links. Use pageRef and offset to continue the same snapshot without refetching. Snapshots expire after 30 minutes. No browser login state; private addresses and URL credentials are rejected. Configured paid fallback may charge.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' }, pageRef: { type: 'string' },
          action: { type: 'string', enum: ['read', 'find', 'links'] },
          find: { type: 'string', maxLength: 200 },
          offset: { type: 'integer', minimum: 0 },
          maxChars: { type: 'integer', minimum: 500, maximum: 40000 },
          via: { type: 'string', enum: ['local', 'deepseek', 'firecrawl'] },
          refresh: { type: 'boolean' }
        }
      },
      async execute(id, params, signal, _update, ctx) {
        if (!params?.pageRef && !/^https?:\/\//i.test(params?.url ?? '')) return toolText('url must start with http:// or https://, or provide pageRef', {}, true)
        return execute('web_fetch', 'search.fetch', params ?? {}, id, signal, ctx, pageText, (data) => {
          const page = rootOf(data)
          return { search: { action: 'fetch', url: page.finalUrl ?? page.url ?? params?.url, title: take(page.title, 200), fetchedAt: page.fetchedAt, cached: page.cached, sourceTruncated: page.sourceTruncated, truncated: page.truncated, readState: page.action === 'find' || page.action === 'links' || page.sourceTruncated || page.truncated ? 'partial' : 'read' } }
        })
      }
    },
    {
      name: 'web_docs', label: 'Library docs',
      description: 'Query library documentation and examples through Context7. Provide library name or exact libraryId; inspect alternatives for ambiguous names. A configured key may charge.',
      parameters: { type: 'object', properties: { library: { type: 'string' }, libraryId: { type: 'string' }, query: { type: 'string' }, maxChars: { type: 'integer', minimum: 500, maximum: 40000 } }, required: ['query'] },
      async execute(id, params, signal, _update, ctx) {
        return execute('web_docs', 'search.docs', params ?? {}, id, signal, ctx, (data) => {
          const docs = rootOf(data)
          return `Library: ${JSON.stringify(docs.library)}\nAlternatives: ${JSON.stringify(docs.alternatives ?? [])}\nTruncated: ${docs.truncated === true}; total characters: ${docs.totalChars ?? '?'}\n\n${take(docs.text, 40000)}`
        }, () => ({}))
      }
    }
  ]
}
