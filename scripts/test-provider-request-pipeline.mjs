import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { zstdDecompressSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

const REPO = resolve(import.meta.dirname, '..')
const BASELINE = join(REPO, 'scripts', 'fixtures', 'provider-request-baseline.json')
const argv = process.argv.slice(2)
const option = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
const REF = option('--ref')
const UPDATE = argv.includes('--update')
const ONLY = option('--only')
const LOAD_ORDER = ['commandcode.js', 'provider-diagnostics.js', 'anthropic-progress-updates.js', 'cache-retention.js', 'parallel-tool-calls.js', 'native-web-search.js', 'fast-mode.js', 'prompt-suggestion.js', 'context-compact.js', 'context-usage.js']
const CLI = join(selectedPiRuntime(join(REPO, 'resources', 'pi-runtime')), 'dist', 'bundle', 'cli.js')
const FAR_FUTURE = 4102444800000

const USER_EXTENSION = `export default function fixtureUser(pi) {
  pi.registerTool({ name: 'web_search', label: 'web_search', description: 'Fixture local search tool.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, async execute() { return { content: [{ type: 'text', text: 'none' }], details: {} } } })
  pi.on('before_provider_request', (event) => {
    const payload = event?.payload
    if (!payload || typeof payload !== 'object') return
    return { ...payload, fixture_user_saw: Object.keys(payload).join(',') }
  })
}
`

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const CODEX_TOKEN = `${base64url({ alg: 'none' })}.${base64url({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_fixture' } })}.c2ln`

const model = (id, extra = {}) => ({ id, name: id, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16000, ...extra })

const completions = (port) => ({ fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local', models: [model('model')] } })
const responses = (port) => ({ fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-responses', apiKey: 'local', models: [model('gpt-fixture', { reasoning: true }), model('gpt-6-luna', { reasoning: true })] } })
const anthropic = (port) => ({ anthropic: { baseUrl: `http://127.0.0.1:${port}`, api: 'anthropic-messages', apiKey: 'local', models: [model('claude-opus-5-5', { reasoning: true }), model('claude-haiku-5-5', { reasoning: true })] } })
const codex = (port) => ({ 'openai-codex': { baseUrl: `http://127.0.0.1:${port}`, api: 'openai-codex-responses', apiKey: CODEX_TOKEN, models: [model('gpt-6-sol', { reasoning: true }), model('gpt-6-luna', { reasoning: true })] } })

const rejectOnce = (test, status, error) => {
  let left = 1
  return (body) => (left > 0 && test(body) ? (left--, { status, error }) : null)
}
const rejectTimes = (count, test, status, error) => {
  let left = count
  return (body) => (left > 0 && test(body) ? (left--, { status, error }) : null)
}

const SCENARIOS = [
  { name: 'completions', providers: completions, defaultModel: ['fixture', 'model'], thinking: 'off', desktop: {}, steps: ['ONE', 'TWO', 'compact'] },
  { name: 'completions-suggest-off', providers: completions, defaultModel: ['fixture', 'model'], thinking: 'off', desktop: { promptSuggestions: false }, steps: ['ONE'] },
  { name: 'completions-parallel-rejected', providers: completions, defaultModel: ['fixture', 'model'], thinking: 'off', desktop: {}, steps: ['ONE', 'TWO', 'THREE'],
    reject: () => rejectOnce((body) => 'parallel_tool_calls' in body, 400, { error: { message: 'Unrecognized request argument supplied: parallel_tool_calls', type: 'invalid_request_error' } }) },
  { name: 'responses-reasoning', providers: responses, defaultModel: ['fixture', 'gpt-fixture'], thinking: 'medium', desktop: {}, steps: ['ONE', 'TWO', 'compact'] },
  { name: 'anthropic-updates', providers: anthropic, defaultModel: ['anthropic', 'claude-opus-5-5'], thinking: 'medium', desktop: { thinkingDisplay: 'updates' }, steps: ['ONE', 'TWO', 'compact'] },
  { name: 'anthropic-updates-rejected', providers: anthropic, defaultModel: ['anthropic', 'claude-opus-5-5'], thinking: 'medium', desktop: { thinkingDisplay: 'updates', promptSuggestions: false }, steps: ['ONE', 'TWO', 'THREE', 'FOUR'],
    reject: () => rejectTimes(2, (body) => body?.thinking?.display === 'updates', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'thinking.display: unsupported value "updates"' } }) },
  { name: 'anthropic-oauth-search', providers: anthropic, defaultModel: ['anthropic', 'claude-opus-5-5'], thinking: 'medium', desktop: { nativeWebSearch: true }, auth: { anthropic: { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: FAR_FUTURE } }, steps: ['ONE', 'compact'] },
  { name: 'anthropic-oauth-search-off', providers: anthropic, defaultModel: ['anthropic', 'claude-opus-5-5'], thinking: 'off', desktop: { nativeWebSearch: false, thinkingDisplay: 'updates' }, auth: { anthropic: { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: FAR_FUTURE } }, steps: ['ONE'] },
  { name: 'codex-fast-search', providers: codex, defaultModel: ['openai-codex', 'gpt-6-sol'], thinking: 'medium', desktop: { fastMode: true, nativeWebSearch: true }, steps: ['ONE', 'TWO', 'compact'] },
  { name: 'anthropic-oauth-search-updates', providers: anthropic, defaultModel: ['anthropic', 'claude-opus-5-5'], thinking: 'high', desktop: { nativeWebSearch: true, thinkingDisplay: 'updates', fastMode: true }, auth: { anthropic: { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: FAR_FUTURE } }, steps: ['ONE', 'TWO', 'compact'] },
  { name: 'codex-plain', providers: codex, defaultModel: ['openai-codex', 'gpt-6-sol'], thinking: 'medium', desktop: { fastMode: false, nativeWebSearch: false }, steps: ['ONE'] },
  { name: 'subagent-load-set', providers: completions, defaultModel: ['fixture', 'model'], thinking: 'off', desktop: {}, load: LOAD_ORDER.filter((name) => name !== 'prompt-suggestion.js' && name !== 'context-usage.js'), steps: ['ONE', 'TWO', 'compact'] },
  { name: 'title-load-set', providers: codex, defaultModel: ['openai-codex', 'gpt-6-sol'], thinking: 'medium', desktop: { fastMode: true, nativeWebSearch: true }, load: LOAD_ORDER.slice(0, 7), steps: ['ONE'] },
  { name: 'diagnostics-http-error', providers: completions, defaultModel: ['fixture', 'model'], thinking: 'off', desktop: { promptSuggestions: false }, steps: ['ONE', 'TWO'],
    reject: () => rejectOnce(() => true, 500, { error: { message: 'fixture upstream failure', type: 'server_error' } }) }
].filter((scenario) => !ONLY || ONLY.split(',').includes(scenario.name))

function sse(res, events, named) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_fixture' })
  for (const event of events) res.write(named ? `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n` : `data: ${JSON.stringify(event)}\n\n`)
  if (!named) res.write('data: [DONE]\n\n')
  res.end()
}

const REPLY = 'Fixture reply.'

function answer(path, res) {
  if (path.endsWith('/chat/completions')) {
    const chunk = (delta, finish = null, usage) => ({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })
    return sse(res, [chunk({ role: 'assistant', content: REPLY }), chunk({}, 'stop', { prompt_tokens: 120, completion_tokens: 4, total_tokens: 124 })], false)
  }
  if (path.endsWith('/messages')) {
    return sse(res, [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'fixture', stop_reason: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' }
    ], true)
  }
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: REPLY, annotations: [] }] }
  return sse(res, [
    { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: REPLY },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: REPLY },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 120, output_tokens: 4, total_tokens: 124, input_tokens_details: { cached_tokens: 0 } } } }
  ], true)
}

async function startServer() {
  const state = { records: [], reject: null }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const bytes = Buffer.concat(chunks)
      const raw = (req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString('utf8')
      let body = null
      try { body = JSON.parse(raw) } catch {}
      state.records.push({ kind: 'request', path: `${req.method} ${req.url}`, raw })
      const rejected = state.reject?.(body)
      if (rejected) {
        res.writeHead(rejected.status, { 'content-type': 'application/json', 'x-request-id': 'req_rejected' })
        res.end(JSON.stringify(rejected.error))
        return
      }
      answer((req.url ?? '').split('?')[0], res)
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { server, state, port: server.address().port }
}

function extensionDir(root, ref) {
  if (!ref) return join(REPO, 'resources', 'pi-extensions')
  const dir = join(root, `ext-${ref.replace(/[^a-zA-Z0-9]/g, '')}`)
  mkdirSync(dir, { recursive: true })
  const prefix = 'resources/pi-extensions/'
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, prefix], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const name of names) {
    const target = join(dir, name.slice(prefix.length))
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, execFileSync('git', ['show', `${ref}:${name}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }))
  }
  return dir
}

function rpcClient(child, sink) {
  let buffer = ''
  let seq = 0
  const pending = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '')
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.type === 'response' && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      } else sink(message)
    }
  })
  return (type, payload = {}, timeoutMs = 60000) => new Promise((done, fail) => {
    const id = `ab-${++seq}`
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${type} timed out`)) }, timeoutMs)
    pending.set(id, (message) => { clearTimeout(timer); done(message) })
    child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`)
  })
}

async function runScenario(scenario, root, extDir, server) {
  const dirs = Object.fromEntries(['agent', 'data', 'home', 'cwd', 'sessions', 'tmp', 'user'].map((name) => [name, join(root, 'run', name)]))
  rmSync(join(root, 'run'), { recursive: true, force: true })
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dirs.user, 'fixture-user.js'), USER_EXTENSION)
  writeFileSync(join(dirs.agent, 'models.json'), JSON.stringify({ providers: scenario.providers(server.port) }))
  writeFileSync(join(dirs.agent, 'auth.json'), JSON.stringify(scenario.auth ?? {}))
  writeFileSync(join(dirs.agent, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: scenario.defaultModel[0], defaultModel: scenario.defaultModel[1], defaultThinkingLevel: scenario.thinking, retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 }, cacheWarming: 'off', transport: 'sse' }))
  writeFileSync(join(dirs.data, 'desktop.json'), JSON.stringify(scenario.desktop))
  server.state.records = []
  server.state.reject = scenario.reject?.() ?? null
  const systemRoot = process.env.SystemRoot || 'C:/Windows'
  const env = {
    SystemRoot: systemRoot, windir: process.env.windir || systemRoot, COMSPEC: process.env.COMSPEC || join(systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD', PATH: process.env.PATH ?? '',
    TEMP: dirs.tmp, TMP: dirs.tmp, HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.home, LOCALAPPDATA: dirs.home,
    PI_CODING_AGENT_DIR: dirs.agent, YAN_DATA_DIR: dirs.data, NO_COLOR: '1', PI_OFFLINE: '1',
    NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost'
  }
  const args = [CLI, '--mode', 'rpc', '--no-extensions', ...(scenario.load ?? LOAD_ORDER).flatMap((name) => ['--extension', join(extDir, name)]), '--extension', join(dirs.user, 'fixture-user.js'), '--session-dir', dirs.sessions]
  const child = spawn(process.execPath, args, { cwd: dirs.cwd, env, windowsHide: true })
  const events = []
  let lastActivity = Date.now()
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    for (const line of chunk.split('\n')) if (line.startsWith('[Inkstone/provider-error]')) server.state.records.push({ kind: 'diagnostic', raw: line.trim() })
  })
  const command = rpcClient(child, (message) => {
    lastActivity = Date.now()
    events.push(message)
    if (message.type === 'extension_ui_request' && message.method === 'setStatus') server.state.records.push({ kind: 'status', raw: JSON.stringify({ key: message.statusKey, text: message.statusText ?? null }) })
    if (message.type === 'extension_error') server.state.records.push({ kind: 'extension-error', raw: JSON.stringify({ event: message.event, error: message.error }) })
  })
  const quiet = async () => {
    const seen = () => server.state.records.length
    let count = seen()
    let since = Date.now()
    const end = Date.now() + 60000
    while (Date.now() < end) {
      await new Promise((done) => setTimeout(done, 50))
      if (seen() !== count) { count = seen(); since = Date.now() }
      if (Date.now() - since > 900 && Date.now() - lastActivity > 900) return
    }
    throw new Error(`${scenario.name}: never went quiet`)
  }
  try {
    const state = await command('get_state', {}, 30000).catch((error) => { throw new Error(`${scenario.name}: ${error.message}\n${stderr.slice(-3000)}`) })
    assert.ok(state.success, `${scenario.name}: pi did not start: ${stderr.slice(-2000)}`)
    for (const step of scenario.steps) {
      if (step === 'compact') {
        const result = await command('compact', {}, 90000)
        server.state.records.push({ kind: 'compact', raw: JSON.stringify({ success: result.success, path: result.data?.details?.path ?? null, fastError: result.data?.details?.fastError ?? null, error: result.error ?? null }) })
      } else {
        const before = events.length
        const sent = await command('prompt', { message: step })
        assert.ok(sent.success, `${scenario.name}: prompt ${step} rejected: ${JSON.stringify(sent)}`)
        const end = Date.now() + 60000
        while (!events.slice(before).some((event) => event.type === 'agent_end') && Date.now() < end) await new Promise((done) => setTimeout(done, 25))
      }
      await quiet()
    }
  } finally {
    child.kill()
    if (argv.includes('--verbose')) console.log(stderr.slice(-4000), JSON.stringify(events.filter((event) => /error|message_end/.test(event.type ?? '')).map((event) => event.message?.errorMessage ?? event.error ?? event.type)))
    await new Promise((done) => setTimeout(done, 300))
  }
  for (const file of readdirSync(dirs.sessions, { recursive: true }).filter((name) => String(name).endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dirs.sessions, String(file)), 'utf8').split('\n')) {
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      if (entry?.type === 'custom' && entry.customType === 'inkstone-provider-error') server.state.records.push({ kind: 'entry', raw: JSON.stringify({ customType: entry.customType, data: entry.data }) })
    }
  }
  return server.state.records.map((record) => ({ ...record }))
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
function canonicalIds(text, ids) {
  return text.replace(UUID, (id) => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`)
    return ids.get(id)
  })
}
function rootForms(root) {
  const forward = root.replaceAll('\\', '/')
  const back = root.replaceAll('/', '\\')
  return [JSON.stringify(back).slice(1, -1), back, forward].filter((form, index, all) => all.indexOf(form) === index)
}
function stable(records, root) {
  const ids = new Map()
  return records.map((record) => {
    let raw = canonicalIds(record.raw, ids)
    for (const form of rootForms(root)) raw = raw.split(form).join('<root>')
    for (const form of rootForms(REPO)) raw = raw.split(form).join('<repo>')
    if (record.kind === 'status') raw = raw.replace(/\\"prompt\\":\d+/, '\\"prompt\\":<n>')
    raw = raw.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    return { ...record, raw }
  })
}
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24)
function summary(record) {
  if (record.kind !== 'request') return record.raw.slice(0, 160)
  let body
  try { body = JSON.parse(record.raw) } catch { return `${record.path} unparsed` }
  const tools = Array.isArray(body.tools) ? body.tools.map((tool) => [tool.name ?? tool.function?.name, ['function', 'custom', undefined].includes(tool.type) ? '' : tool.type].filter(Boolean).join(':')).join('|') : '-'
  const marks = [
    body.service_tier ? `service_tier=${body.service_tier}` : '',
    'parallel_tool_calls' in body ? `parallel=${body.parallel_tool_calls}` : '',
    body.thinking ? `thinking=${JSON.stringify(body.thinking)}` : '',
    Array.isArray(body.betas) ? `betas=${body.betas.join('|')}` : '',
    body.tool_choice ? `tool_choice=${JSON.stringify(body.tool_choice)}` : '',
    body.reasoning ? `reasoning=${JSON.stringify(body.reasoning)}` : '',
    body.reasoning_effort ? `reasoning_effort=${body.reasoning_effort}` : '',
    body.fixture_user_saw ? `user_saw=${body.fixture_user_saw}` : ''
  ].filter(Boolean)
  return `${record.path} tools=${tools} ${marks.join(' ')}`.trim()
}
const digest = (records) => records.map((record) => `${record.kind} ${record.raw.length} ${sha(record.raw)} :: ${summary(record)}`)

async function loadChain(extDir, settingsDir) {
  const handlers = []
  const statuses = []
  const listeners = new Map()
  const events = {
    emit: (channel, data) => { for (const listener of listeners.get(channel) ?? []) listener(data) },
    on: (channel, listener) => { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); return () => {} }
  }
  const tools = [{ name: 'read', description: 'Read', parameters: {} }, { name: 'mcp__srv__x', description: 'MCP', parameters: {}, namespace: 'srv' }]
  for (const name of LOAD_ORDER) {
    const { default: factory } = await import(`${pathToFileURL(join(extDir, name)).href}?chain=${encodeURIComponent(settingsDir)}`)
    factory({
      on: (event, handler) => { if (event === 'before_provider_request') handlers.push(handler) },
      events, getAllTools: () => tools, appendEntry: () => {}, registerCommand: () => {}, registerTool: () => {}
    })
  }
  const ui = { setStatus: (key, text) => statuses.push([key, text ?? null]) }
  return {
    statuses,
    run(payload, model) {
      const ctx = { model, ui, getSystemPrompt: () => 'system', sessionManager: { getSessionId: () => 'S' } }
      let current = payload
      for (const handler of handlers) {
        try {
          const result = handler({ type: 'before_provider_request', payload: current }, ctx)
          if (result !== undefined) current = result
        } catch (error) {
          console.error(`[handler] ${error.message}`)
        }
      }
      return current
    },
    count: handlers.length
  }
}

async function hookLevelCompare(referenceDir, currentDir, settingsRoot) {
  const models = [
    { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-6-sol', baseUrl: 'https://chatgpt.com/backend-api' },
    { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-5-mini', baseUrl: 'https://chatgpt.com/backend-api' },
    { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com' },
    { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-sonnet-4-5', baseUrl: 'https://api.anthropic.com' },
    { provider: 'openai', api: 'openai-responses', id: 'gpt-6-luna', baseUrl: 'https://api.openai.com/v1' },
    { provider: 'fixture', api: 'openai-completions', id: 'model', baseUrl: 'http://127.0.0.1/v1' },
    { provider: 'fixture', api: 'azure-openai-responses', id: 'model', baseUrl: 'http://127.0.0.1/v1' },
    undefined
  ]
  const local = { type: 'function', name: 'web_search', parameters: {} }
  const payloads = [
    { model: 'x', input: [{ role: 'user', content: 'hi' }], tools: [local, { type: 'function', name: 'read' }], reasoning: { effort: 'high' } },
    { model: 'x', input: [{ type: 'additional_tools', tools: [local, { name: 'read' }] }], reasoning: { effort: 'high' } },
    { model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [local, { type: 'web_search_20250305', name: 'web_search' }], thinking: { type: 'adaptive', display: 'summarized' }, betas: ['other'] },
    { model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [], thinking: { type: 'enabled', budget_tokens: 1024 } },
    { model: 'x', messages: [], tools: [{ type: 'function', function: { name: 'read' } }], parallel_tool_calls: false, service_tier: 'priority' },
    { model: 'x', input: [], tools: { not: 'array' } },
    null
  ]
  const desktops = [{}, { fastMode: true, nativeWebSearch: true, thinkingDisplay: 'updates' }, { fastMode: true, promptSuggestions: false }, { nativeWebSearch: true }]
  const auths = [{}, { anthropic: { type: 'oauth' } }]
  const yanDir = join(settingsRoot, 'hook-data')
  const piDir = join(settingsRoot, 'hook-pi')
  mkdirSync(yanDir, { recursive: true })
  mkdirSync(piDir, { recursive: true })
  const saved = { YAN_DATA_DIR: process.env.YAN_DATA_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }
  process.env.YAN_DATA_DIR = yanDir
  process.env.PI_CODING_AGENT_DIR = piDir
  const consoleError = console.error
  const errors = []
  console.error = (...args) => errors.push(args.join(' '))
  let cases = 0
  let mismatches = 0
  try {
    const before = await loadChain(referenceDir, 'reference')
    const after = await loadChain(currentDir, 'current')
    assert.equal(after.count, 1, '改后只有一个 before_provider_request 处理器')
    for (const desktop of desktops) for (const auth of auths) {
      writeFileSync(join(yanDir, 'desktop.json'), JSON.stringify(desktop))
      writeFileSync(join(piDir, 'auth.json'), JSON.stringify(auth))
      for (const model of models) for (const payload of payloads) {
        for (let round = 0; round < 2; round++) {
          cases++
          let left
          let right
          try { left = JSON.stringify(before.run(structuredClone(payload), model)) ?? 'undefined' } catch (error) { left = `throw ${error.message}` }
          try { right = JSON.stringify(after.run(structuredClone(payload), model)) ?? 'undefined' } catch (error) { right = `throw ${error.message}` }
          if (left !== right) {
            mismatches++
            if (mismatches <= 5) console.log(`    钩子差异 ${JSON.stringify({ desktop, auth, model: model?.id, payload: JSON.stringify(payload)?.slice(0, 80) })}\n      ${REF}=${left.slice(0, 200)}\n      当前=${right.slice(0, 200)}`)
          }
        }
      }
    }
    if (JSON.stringify(before.statuses) !== JSON.stringify(after.statuses)) {
      mismatches++
      console.log(`    状态推送不同：${before.statuses.length} 对 ${after.statuses.length}`)
    }
  } finally {
    console.error = consoleError
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value)
  }
  return { cases, mismatches, errors: errors.length }
}

const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'inkstone-provider-request-'))
const { server, state, port } = await startServer()
const results = {}
const referenceResults = {}
let failures = 0
try {
  const current = extensionDir(root, null)
  const reference = REF ? extensionDir(root, REF) : null
  if (reference) {
    const hooks = await hookLevelCompare(reference, current, root)
    if (hooks.mismatches) failures++
    console.log(`  ${hooks.mismatches ? '✗' : '✓'} 钩子层对拍：${hooks.cases} 组输入，${hooks.mismatches} 处不同（两边共 ${hooks.errors} 条钩子报错日志）`)
  }
  for (const scenario of SCENARIOS) {
    const now = stable(await runScenario(scenario, root, current, { state, port }), root)
    results[scenario.name] = digest(now)
    if (option('--dump')) {
      mkdirSync(option('--dump'), { recursive: true })
      now.forEach((record, index) => writeFileSync(join(option('--dump'), `${scenario.name}-${String(index).padStart(2, '0')}-${record.kind}.txt`), `${record.path ?? ''}\n${record.raw}`))
    }
    const requests = now.filter((record) => record.kind === 'request').length
    if (reference) {
      const then = stable(await runScenario(scenario, root, reference, { state, port }), root)
      referenceResults[scenario.name] = digest(then)
      const same = then.length === now.length && then.every((record, index) => record.kind === now[index].kind && record.raw === now[index].raw)
      if (!same) {
        failures++
        console.log(`  ✗ ${scenario.name}: 与 ${REF} 不同`)
        const width = Math.max(then.length, now.length)
        for (let i = 0; i < width; i++) {
          if (then[i]?.raw === now[i]?.raw) continue
          console.log(`    #${i} ${REF}: ${then[i] ? `${then[i].kind} ${summary(then[i])}` : '(无)'}`)
          console.log(`    #${i} 当前: ${now[i] ? `${now[i].kind} ${summary(now[i])}` : '(无)'}`)
          if (then[i] && now[i]) {
            let at = 0
            while (at < then[i].raw.length && then[i].raw[at] === now[i].raw[at]) at++
            console.log(`      首个差异 @${at}: ${REF}=${JSON.stringify(then[i].raw.slice(at, at + 120))} 当前=${JSON.stringify(now[i].raw.slice(at, at + 120))}`)
          }
        }
      } else console.log(`  ✓ ${scenario.name}: ${now.length} 条记录（${requests} 个请求）与 ${REF} 逐字节相同`)
    }
  }
  if (UPDATE) {
    const existing = ONLY ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
    mkdirSync(join(REPO, 'scripts', 'fixtures'), { recursive: true })
    writeFileSync(BASELINE, `${JSON.stringify({ ...existing, ...(REF ? referenceResults : results) }, null, 1)}\n`)
    console.log(`  已写入基线 ${BASELINE}`)
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
    for (const [name, lines] of Object.entries(results)) {
      const expected = baseline[name]
      const same = Array.isArray(expected) && expected.length === lines.length && expected.every((line, index) => line.split(' :: ')[0] === lines[index].split(' :: ')[0])
      if (same) console.log(`  ✓ ${name}: ${lines.length} 条记录与基线哈希一致`)
      else {
        failures++
        console.log(`  ✗ ${name}: 与基线不一致`)
        const width = Math.max(expected?.length ?? 0, lines.length)
        for (let i = 0; i < width; i++) if (expected?.[i]?.split(' :: ')[0] !== lines[i]?.split(' :: ')[0]) console.log(`    #${i} 基线: ${expected?.[i] ?? '(无)'}\n    #${i} 当前: ${lines[i] ?? '(无)'}`)
      }
    }
  }
} finally {
  server.close()
  if (!argv.includes('--keep')) rmSync(root, { recursive: true, force: true })
  else console.log(`  保留目录 ${root}`)
}
if (failures) {
  console.error(`provider-request pipeline: ${failures} 个场景不一致`)
  process.exit(1)
}
console.log(`provider-request pipeline: ${Object.keys(results).length} 个场景通过`)
