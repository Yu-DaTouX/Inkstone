import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOCAL_TOOL = 'web_search'
export const ANTHROPIC_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
export const CODEX_SEARCH_TOOL = { type: 'web_search' }

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const yanDir = () => process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
const piDir = () => process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')

export const nativeSearchEnabled = (settings) => settings?.nativeWebSearch === true

export function nativeSearchKind(model, auth) {
  if (model?.provider === 'anthropic' && model?.api === 'anthropic-messages' && auth?.anthropic?.type === 'oauth') return 'anthropic'
  if (model?.provider === 'openai-codex' && model?.api === 'openai-codex-responses') return 'codex'
  return null
}

const isLocalSearch = (tool) => tool?.name === LOCAL_TOOL && (tool.type === undefined || tool.type === 'function' || tool.type === 'custom')

function swapTools(tools, native) {
  if (tools.some((tool) => tool?.type === native.type)) return null
  return [...tools.filter((tool) => !isLocalSearch(tool)), native]
}

export function withNativeSearch(payload, kind) {
  if (!kind || !payload || typeof payload !== 'object') return undefined
  const native = kind === 'anthropic' ? ANTHROPIC_SEARCH_TOOL : CODEX_SEARCH_TOOL
  if (Array.isArray(payload.tools)) {
    const tools = swapTools(payload.tools, native)
    return tools ? { ...payload, tools } : undefined
  }
  if (kind !== 'codex' || !Array.isArray(payload.input)) return undefined
  const at = payload.input.findIndex((item) => item?.type === 'additional_tools' && Array.isArray(item.tools))
  if (at < 0) return undefined
  const input = payload.input.slice()
  input[at] = { ...input[at], tools: input[at].tools.filter((tool) => !isLocalSearch(tool)) }
  return { ...payload, input, tools: [native] }
}

const CITE_LINKS_PER_BLOCK = 3
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function withCitationLinks(message, blocks) {
  const content = message?.content
  if (!Array.isArray(content) || !Array.isArray(blocks) || !blocks.some((block) => block.urls.length)) return undefined
  const texts = content.filter((block) => block?.type === 'text')
  if (texts.length !== blocks.length) return undefined
  let at = 0
  const next = content.map((block) => {
    if (block?.type !== 'text') return block
    const urls = blocks[at++].urls
    if (!urls.length || typeof block.text !== 'string') return block
    const links = urls.map((url) => `[${hostOf(url) || url}](${url})`).join(' ')
    const body = block.text.trimEnd()
    return { ...block, text: `${body} ${links}${block.text.slice(body.length)}` }
  })
  return { ...message, content: next }
}

export function joinCitedText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  const merged = []
  for (const block of content) {
    const last = merged.at(-1)
    if (block?.type === 'text' && last?.type === 'text') merged[merged.length - 1] = { ...last, text: `${last.text ?? ''}${block.text ?? ''}` }
    else merged.push(block)
  }
  return merged.length === content.length ? undefined : { ...message, content: merged }
}

const RECORD_FIELD = 'yanWebSearch'
const MAX_ITEMS = 12
const clip = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function createSearchCollector() {
  const queries = []
  const opened = []
  const results = []
  const cited = []
  const errors = []
  const pendingQuery = new Map()
  const textBlocks = []
  let firstUsage = null
  const addUnique = (list, item, key) => {
    if (list.length < MAX_ITEMS && !list.some((existing) => key(existing) === key(item))) list.push(item)
  }
  const addQuery = (query) => {
    const text = clip(query, 200)
    if (text) addUnique(queries, text, (value) => value)
  }
  const addResult = (item) => {
    if (typeof item?.url === 'string' && item.url) addUnique(results, { title: clip(item.title, 160), url: item.url }, (value) => value.url)
  }
  const addCitation = (item) => {
    if (typeof item?.url === 'string' && item.url) addUnique(cited, { title: clip(item.title, 160), url: item.url, ...(item.cited_text ? { text: clip(item.cited_text, 240) } : {}) }, (value) => `${value.url}\u0000${value.text ?? ''}`)
  }
  return {
    observe(data) {
      if (!data || typeof data !== 'object') return
      if (data.type === 'message_start' && !firstUsage) {
        const usage = data.message?.usage
        if (usage && typeof usage === 'object') firstUsage = { input: Number(usage.input_tokens) || 0, cacheRead: Number(usage.cache_read_input_tokens) || 0, cacheWrite: Number(usage.cache_creation_input_tokens) || 0 }
      }
      if (data.type === 'content_block_start') {
        const block = data.content_block
        if (block?.type === 'text') textBlocks.push({ index: data.index, urls: [] })
        else if (block?.type === 'server_tool_use' && block.name === 'web_search') {
          pendingQuery.set(data.index, '')
          if (block.input?.query) addQuery(block.input.query)
        } else if (block?.type === 'web_search_tool_result') {
          if (Array.isArray(block.content)) block.content.forEach(addResult)
          else if (block.content?.error_code) errors.push(String(block.content.error_code))
        }
        return
      }
      if (data.type === 'content_block_delta') {
        if (data.delta?.type === 'input_json_delta' && pendingQuery.has(data.index)) pendingQuery.set(data.index, pendingQuery.get(data.index) + (data.delta.partial_json ?? ''))
        else if (data.delta?.type === 'citations_delta') {
          addCitation(data.delta.citation)
          const url = data.delta.citation?.url
          const target = textBlocks.findLast((block) => block.index === data.index)
          if (typeof url === 'string' && url && target && target.urls.length < CITE_LINKS_PER_BLOCK && !target.urls.includes(url)) target.urls.push(url)
        }
        return
      }
      if (data.type === 'content_block_stop' && pendingQuery.has(data.index)) {
        try {
          addQuery(JSON.parse(pendingQuery.get(data.index) || '{}').query)
        } catch {
        }
        pendingQuery.delete(data.index)
        return
      }
      if (data.type === 'response.output_item.done' && data.item?.type === 'web_search_call') {
        const action = data.item.action ?? {}
        if (action.type === 'search') (Array.isArray(action.queries) && action.queries.length ? action.queries : [action.query]).forEach(addQuery)
        else if (typeof action.url === 'string') addUnique(opened, action.url, (value) => value)
        if (Array.isArray(action.sources)) action.sources.forEach(addResult)
        return
      }
      if (data.type === 'response.output_text.annotation.added' && data.annotation?.type === 'url_citation') addCitation(data.annotation)
    },
    textCitations: () => textBlocks,
    firstUsage: () => firstUsage,
    record() {
      if (!queries.length && !opened.length && !results.length && !cited.length && !errors.length) return null
      return {
        ...(queries.length ? { queries } : {}),
        ...(opened.length ? { opened } : {}),
        ...(results.length ? { results } : {}),
        ...(cited.length ? { cited } : {}),
        ...(errors.length ? { errors } : {})
      }
    }
  }
}

export function withContextUsage(message, first, searched) {
  const usage = message?.usage
  if (!searched || !first || !usage) return message
  const prompt = first.input + first.cacheRead + first.cacheWrite
  const output = Number(usage.output) || 0
  const results = Math.max(0, (Number(usage.cacheWrite) || 0) - first.cacheWrite)
  const total = prompt + results + output
  if (!(Number(usage.totalTokens) > total)) return message
  return { ...message, usage: { ...usage, totalTokens: total } }
}

export function searchRecordText(record) {
  const lines = ['[Inkstone note: server-side web search ran for this reply. The provider does not keep raw search results in history; this is the recorded summary.]']
  if (record.queries?.length) lines.push(`Queries: ${record.queries.join(' | ')}`)
  if (record.opened?.length) lines.push(`Opened pages: ${record.opened.join(' | ')}`)
  if (record.results?.length) lines.push('Results:', ...record.results.map((item) => `- ${item.title} — ${item.url}`))
  if (record.cited?.length) lines.push('Cited:', ...record.cited.map((item) => `- ${item.text ? `"${item.text}" ` : ''}${item.title ? `(${item.title}) ` : ''}${item.url}`))
  if (record.errors?.length) lines.push(`Search errors: ${record.errors.join(', ')}`)
  return lines.join('\n')
}

export function withSearchRecords(messages) {
  if (!Array.isArray(messages) || !messages.some((message) => message?.role === 'assistant' && message[RECORD_FIELD])) return undefined
  return messages.map((message) => {
    const record = message?.role === 'assistant' ? message[RECORD_FIELD] : null
    if (!record || !Array.isArray(message.content)) return message
    const note = { type: 'text', text: searchRecordText(record) }
    const at = message.content.findIndex((block) => block?.type === 'toolCall')
    const content = at < 0 ? [...message.content, note] : [...message.content.slice(0, at), note, ...message.content.slice(at)]
    return { ...message, content }
  })
}

export default function nativeWebSearch(pi) {
  let anthropicSearch = false
  let collector = null
  pi.on('before_provider_request', (event, ctx) => {
    anthropicSearch = false
    collector = null
    if (!nativeSearchEnabled(readJson(join(yanDir(), 'desktop.json')))) return
    const kind = nativeSearchKind(ctx?.model, readJson(join(piDir(), 'auth.json')))
    const next = withNativeSearch(event?.payload, kind)
    const active = !!next || (kind === 'anthropic' && (event?.payload?.tools ?? []).some((tool) => tool?.type === ANTHROPIC_SEARCH_TOOL.type))
    anthropicSearch = kind === 'anthropic' && active
    if (active) collector = createSearchCollector()
    return next
  })
  pi.on('provider_stream_event', (event) => {
    collector?.observe(event?.data)
  })
  pi.on('message_end', (event) => {
    if (event?.message?.role !== 'assistant') return
    const record = collector?.record() ?? null
    const first = anthropicSearch ? collector?.firstUsage() : null
    const linked = anthropicSearch ? withCitationLinks(event.message, collector?.textCitations()) : undefined
    const joined = anthropicSearch ? joinCitedText(linked ?? event.message) : undefined
    anthropicSearch = false
    collector = null
    if (!record && !joined && !linked) return
    const base = joined ?? linked ?? event.message
    const message = withContextUsage(base, first, !!record)
    return { message: record ? { ...message, [RECORD_FIELD]: record } : message }
  })
  pi.on('context', (event) => {
    const messages = withSearchRecords(event?.messages)
    return messages ? { messages } : undefined
  })
}
