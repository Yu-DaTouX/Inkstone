import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

const GIT_ACTIONS = ['diff', 'log', 'show', 'status', 'blame']
const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const OUTPUT_MAX_CHARS = 60_000
const ARGS_MAX = 40
const ARG_MAX_CHARS = 500
const HOST_TIMEOUT_MS = 90_000
const DETAIL_TITLE_MAX = 200
const DETAIL_SNIPPET_MAX = 240
const DETAIL_ITEMS_MAX = 12
const FORBIDDEN_GIT_ARG = /^(--output|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|--open-files-in-pager|--config-env|--git-dir|--work-tree|--namespace|--super-prefix|--paginate|-p$|-o|-O)/
const GIT_GLOBALS = ['-c', 'core.quotepath=false', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '--no-pager', '--no-optional-locks']
const NO_DRIVERS = { diff: ['--no-ext-diff', '--no-textconv'], show: ['--no-ext-diff', '--no-textconv'], log: ['--no-ext-diff', '--no-textconv'], status: [], blame: [] }

function text(value, details = {}, isError = false) {
  return { content: [{ type: 'text', text: value }], details, ...(isError ? { isError: true } : {}) }
}

function clip(value) {
  if (value.length <= OUTPUT_MAX_CHARS) return value
  return `${value.slice(0, OUTPUT_MAX_CHARS)}\n… [output truncated: ${value.length - OUTPUT_MAX_CHARS} more characters; narrow with paths, -n, --stat or a revision range]`
}

export function gitInspectArgs(action, args = []) {
  if (!GIT_ACTIONS.includes(action)) return { error: `action must be one of ${GIT_ACTIONS.join(', ')}` }
  if (!Array.isArray(args) || args.length > ARGS_MAX) return { error: `args must be an array of at most ${ARGS_MAX} strings` }
  let afterSeparator = false
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg || arg.length > ARG_MAX_CHARS || arg.includes('\0')) return { error: 'every arg must be a non-empty string without NUL' }
    if (arg === '--') {
      afterSeparator = true
      continue
    }
    if (!afterSeparator && FORBIDDEN_GIT_ARG.test(arg)) return { error: `option not allowed in read-only mode: ${arg}` }
  }
  return { argv: [...GIT_GLOBALS, action, ...NO_DRIVERS[action], ...args] }
}

function runGit(argv, cwd, signal) {
  return new Promise((resolve) => {
    execFile('git', argv, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, signal, env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error && typeof error.code !== 'number' ? String(error.message ?? error) : '' })
    })
  })
}

function readResult(path) {
  if (typeof path !== 'string' || !path) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function callHost(command, params, signal, env = process.env) {
  if (!env.YAN_CLI_URL || !env.YAN_CLI_TOKEN || !env.YAN_SESSION_ID || !env.YAN_PROJECT_ID) return { ok: false, error: 'Inkstone host endpoint is not available' }
  const timeout = AbortSignal.timeout(HOST_TIMEOUT_MS)
  try {
    const response = await fetch(env.YAN_CLI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.YAN_CLI_TOKEN}` },
      body: JSON.stringify({ apiVersion: 1, command, params, sessionId: env.YAN_SESSION_ID, projectId: env.YAN_PROJECT_ID }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    const payload = await response.json()
    if (!payload?.ok) return { ok: false, error: String(payload?.error ?? 'host error') }
    return { ok: true, summary: payload.summary ?? {}, data: readResult(payload.resultFile) }
  } catch (error) {
    return { ok: false, error: signal?.aborted ? 'cancelled' : String(error?.message ?? error) }
  }
}

function searchText(data) {
  const outcome = data?.data ?? data
  const queries = Array.isArray(outcome?.queries) ? outcome.queries : [outcome]
  const lines = []
  for (const query of queries) {
    if (queries.length > 1 && query?.query) lines.push(`## ${query.query}`)
    for (const [index, item] of (Array.isArray(query?.items) ? query.items : []).entries()) {
      const quality = item.quality?.provider === 'deepseek' ? `\n   DeepSeek quality: ${JSON.stringify(item.quality)} (provider-specific; do not compare across sources)` : ''
      lines.push(`${index + 1}. ${item.title ?? ''}\n   ${item.url ?? ''}${item.source ? `\n   Source: ${item.source}${item.published ? `; published: ${item.published}` : ''}` : ''}${item.summary ? `\n   ${String(item.summary).slice(0, 3000)}` : item.snippet ? `\n   ${String(item.snippet).replace(/\s+/g, ' ').slice(0, 400)}` : ''}${item.content ? `\n   ${String(item.content).slice(0, 3000)}` : ''}${quality}`)
    }
  }
  return lines.length ? lines.join('\n') : JSON.stringify(outcome ?? {}).slice(0, OUTPUT_MAX_CHARS)
}

function pageText(data) {
  const page = data?.data ?? data
  const body = typeof page?.text === 'string' ? page.text : typeof page?.content === 'string' ? page.content : JSON.stringify(page ?? {})
  return `${page?.title ? `# ${page.title}\n` : ''}${page?.url ? `${page.url}\n\n` : ''}${body}`
}

function detailText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

function searchDetailItems(data) {
  const outcome = data?.data ?? data
  const lists = []
  if (Array.isArray(outcome?.items)) lists.push(outcome.items)
  for (const query of Array.isArray(outcome?.queries) ? outcome.queries : []) {
    if (Array.isArray(query?.items)) lists.push(query.items)
  }
  const items = []
  const seen = new Set()
  for (const list of lists) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const url = typeof entry.url === 'string' ? entry.url.trim() : ''
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
      seen.add(url)
      items.push({ title: detailText(entry.title, DETAIL_TITLE_MAX), url, snippet: detailText(entry.snippet, DETAIL_SNIPPET_MAX) })
      if (items.length >= DETAIL_ITEMS_MAX) return items
    }
  }
  return items
}

function fetchSearchDetail(data, fallbackUrl) {
  const page = data?.data ?? data
  const candidates = [page?.finalUrl, page?.url, fallbackUrl]
  const url = candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()))
  return { action: 'fetch', url: typeof url === 'string' ? url.trim() : fallbackUrl, title: detailText(page?.title, DETAIL_TITLE_MAX) }
}

export const GIT_INSPECT_TOOL = {
  name: 'git_inspect',
  label: 'Git (read-only)',
  description: 'Read-only git in the working directory: diff, log, show, status or blame. args are passed as separate argv entries (no shell); options that write files or run external programs are rejected. Use paths after "--" to narrow output.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: GIT_ACTIONS },
      args: { type: 'array', items: { type: 'string' }, maxItems: ARGS_MAX, description: 'Extra arguments, e.g. ["151429f5..HEAD", "--stat"] or ["HEAD~3", "--", "src/main/agent.ts"]' }
    },
    required: ['action']
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const built = gitInspectArgs(params?.action, params?.args ?? [])
    if (built.error) return text(built.error, {}, true)
    const result = await runGit(built.argv, ctx?.cwd ?? process.cwd(), signal)
    if (result.error) return text(`git failed: ${result.error}`, { code: result.code }, true)
    const body = result.stdout || (result.code === 0 ? '(no output)' : '')
    const stderr = result.stderr.trim() ? `\n[stderr]\n${result.stderr.trim().slice(0, 4000)}` : ''
    return text(clip(`${body}${stderr}`), { code: result.code }, result.code !== 0)
  }
}

export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  label: 'Web search',
  description: 'Search the web through Inkstone. Returns ranked titles, URLs, sources, snippets and available longer summaries. Configured paid sources may incur charges. Results may be cached for 10 minutes; use refresh for a fresh search. Use web_fetch to read a result page.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      recent: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Best-effort time filter; some sources may include older or undated results.' },
      site: { type: 'string', description: 'Comma-separated domains, at most 5; use this when a required domain must be enforced.' },
      withContent: { type: 'boolean', description: 'Request longer source content when the configured DeepSeek search source supports it. Output is bounded; read important pages with web_fetch.' },
      refresh: { type: 'boolean', description: 'Skip the 10-minute result cache.' }
    },
    required: ['query']
  },
  async execute(_toolCallId, params, signal) {
    const query = typeof params?.query === 'string' ? params.query.trim() : ''
    if (!query) return text('query is required', {}, true)
    const result = await callHost('search.query', { queryText: query, ...(params.recent ? { recent: params.recent } : {}), ...(params.site ? { site: params.site } : {}), ...(params.withContent === true ? { withContent: true } : {}), ...(params.refresh === true ? { refresh: true } : {}) }, signal)
    if (!result.ok) return text(`web_search failed: ${result.error}`, {}, true)
    return text(clip(searchText(result.data)), { summary: result.summary, search: { action: 'query', query, items: searchDetailItems(result.data) } })
  }
}

export const WEB_FETCH_TOOL = {
  name: 'web_fetch',
  label: 'Web fetch',
  description: 'Read a public http(s) page as text through Inkstone. Does not share the user browser login state; local and intranet addresses and URLs containing credentials are rejected. May use configured paid fallback sources. Results may be cached for 10 minutes; use refresh to bypass the cache.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      maxChars: { type: 'number', minimum: 500, maximum: 40000 },
      refresh: { type: 'boolean', description: 'Skip the 10-minute result cache.' }
    },
    required: ['url']
  },
  async execute(_toolCallId, params, signal) {
    const url = typeof params?.url === 'string' ? params.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) return text('url must start with http:// or https://', {}, true)
    const result = await callHost('search.fetch', { url, ...(typeof params.maxChars === 'number' ? { maxChars: params.maxChars } : {}), ...(params.refresh === true ? { refresh: true } : {}) }, signal)
    if (!result.ok) return text(`web_fetch failed: ${result.error}`, {}, true)
    return text(clip(pageText(result.data)), { summary: result.summary, search: fetchSearchDetail(result.data, url) })
  }
}

export default function readOnlyToolsExtension(pi) {
  pi.registerTool(GIT_INSPECT_TOOL)
  pi.registerTool(WEB_SEARCH_TOOL)
  pi.registerTool(WEB_FETCH_TOOL)
}
