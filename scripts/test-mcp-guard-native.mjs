import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
import { GUARD_TOOLS } from './fixtures/mcp-guard-server.mjs'

const SERVER_NAME = 'guardfixture'
const PROVIDER = 'mcpguard-fixture'
const MODEL = 'mcpguard-physical'
const CODEMODE_TOOL = 'codemode'

const results = { checks: 0, turns: [], observed: {}, sourceCheck: {} }
const check = (condition, label) => {
  assert.ok(condition, label)
  results.checks += 1
}

const EXPECTED = [
  { tool: 'read_ok', expectAsk: false, decision: null, expectExecuted: true },
  { tool: 'no_annotations', expectAsk: true, decision: 'allow', expectExecuted: true },
  { tool: 'destructive_op', expectAsk: true, decision: 'deny', expectExecuted: false },
  { tool: 'read_destructive', expectAsk: true, decision: 'deny', expectExecuted: false },
  { tool: 'safe_local', expectAsk: false, decision: null, expectExecuted: true }
]
const fixtureByName = new Map(GUARD_TOOLS.map((tool) => [tool.name, tool]))

const ROOT = await mkdtemp(join(tmpdir(), 'inkstone-mcp-guard-'))
const PI_DIR = join(ROOT, 'pi')
const DATA_DIR = join(ROOT, 'yan')
const SESSIONS_DIR = join(ROOT, 'sessions')
const EXT_DIR = join(PI_DIR, 'extensions')
const MARKER = join(ROOT, 'mcp-calls.log')
const PROBE_LOG = join(ROOT, 'probe.jsonl')
const runtimeDir = selectedPiRuntime(resolve('resources/pi-runtime'))
const CLI = join(runtimeDir, 'dist/bundle/cli.js')

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(',')}}`
}

const CREDENTIAL = /(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|_TOKEN$|^ANTHROPIC_|^OPENAI_|^GEMINI_|^GOOGLE_|^XAI_|^GROK_|^DEEPSEEK_|^OPENROUTER_|^AWS_|^AZURE_|^MISTRAL_|^COHERE_)/i
function isolatedEnv(extra = {}) {
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: PI_DIR,
    YAN_PI_DIR: PI_DIR,
    YAN_DATA_DIR: DATA_DIR,
    YAN_SESSIONS_DIR: SESSIONS_DIR,
    PI_OFFLINE: '1',
    MCP_GUARD_MARKER: MARKER,
    MCP_GUARD_PROBE_LOG: PROBE_LOG,
    ...extra
  }
  for (const key of Object.keys(env)) if (CREDENTIAL.test(key)) delete env[key]
  delete env.YAN_DANGER_GUARD
  env.YAN_CLI_URL = hostUrl
  env.YAN_CLI_TOKEN = 'fixture-token'
  env.YAN_SESSION_ID = 'fixture-session'
  env.YAN_PROJECT_ID = 'fixture-project'
  return env
}

const hostRequests = []
const DENY_NAMES = new Set(['destructive_op', 'read_destructive'])
const hostServer = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch { }
    if (payload?.command !== 'danger.prefs') hostRequests.push(payload)
    const tool = String(payload?.params?.tool ?? '')
    const deny = [...DENY_NAMES].some((name) => tool.endsWith(`__${name}`))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload?.command === 'danger.confirm'
      ? { ok: true, summary: { kind: 'danger-confirm', allowed: !deny, decision: deny ? 'deny' : 'allow' } }
      : payload?.command === 'danger.prefs'
        ? { ok: true, summary: { mode: 'danger', outsideWrites: true, allowRoots: [] } }
        : { ok: true, summary: {} }))
  })
})
await new Promise((ready) => hostServer.listen(0, '127.0.0.1', ready))
const hostUrl = `http://127.0.0.1:${hostServer.address().port}`

const turn = { tool: null, callId: null }
const providerRequests = []
const USAGE = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
function sseChunk(delta, finishReason = null, usage) {
  const body = { id: 'mcpguard-fix', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finishReason }] }
  if (usage) body.usage = usage
  return `data: ${JSON.stringify(body)}\n\n`
}
function codemodeSource(toolName) {
  return [
    'try {',
    `  const r = await tools[${JSON.stringify(toolName)}]({})`,
    '  text("MCPGUARD_OK:" + JSON.stringify(r))',
    '} catch (error) {',
    '  text("MCPGUARD_ERR:" + String((error && error.message) || error))',
    '}'
  ].join('\n')
}
const providerServer = createServer((req, res) => {
  let body = ''
  req.on('data', (part) => { body += part })
  req.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch { }
    providerRequests.push(payload)
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const last = messages.at(-1)
    const lastIsTool = last?.role === 'tool'
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (/MCP_GUARD_TURN/.test(lastUserText) && !lastIsTool) {
      const args = JSON.stringify({ code: codemodeSource(turn.tool) })
      res.write(sseChunk({ role: 'assistant', tool_calls: [{ index: 0, id: turn.callId, type: 'function', function: { name: CODEMODE_TOOL, arguments: args } }] }))
      res.write(sseChunk({}, 'tool_calls'))
    } else if (lastIsTool) {
      res.write(sseChunk({ role: 'assistant', content: 'MCP-GUARD-DONE' }))
      res.write(sseChunk({}, 'stop', USAGE))
    } else {
      res.write(sseChunk({ role: 'assistant', content: 'MCP-GUARD-IDLE' }))
      res.write(sseChunk({}, 'stop', USAGE))
    }
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((ready) => providerServer.listen(0, '127.0.0.1', ready))
const providerPort = providerServer.address().port

for (const dir of [PI_DIR, DATA_DIR, SESSIONS_DIR, EXT_DIR]) await mkdir(dir, { recursive: true })
await writeFile(join(PI_DIR, 'auth.json'), '{}')
await writeFile(join(PI_DIR, 'models.json'), JSON.stringify({
  providers: {
    [PROVIDER]: {
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      api: 'openai-completions',
      apiKey: 'fixture-only',
      models: [{
        id: MODEL,
        name: 'MCP guard physical fixture',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 2048
      }]
    }
  }
}))
await writeFile(join(PI_DIR, 'settings.json'), JSON.stringify({
  packages: [],
  defaultProvider: PROVIDER,
  defaultModel: `${PROVIDER}/${MODEL}`,
  defaultTools: ['+codemode'],
  compaction: { enabled: false }
}))
await writeFile(join(DATA_DIR, 'desktop.json'), JSON.stringify({ permissionMode: 'danger' }))
await writeFile(join(PI_DIR, 'mcp.json'), JSON.stringify({
  autoEnableCodemode: true,
  mcpServers: {
    [SERVER_NAME]: {
      command: process.execPath,
      args: [resolve('scripts/fixtures/mcp-guard-server.mjs')],
      env: { MCP_GUARD_MARKER: MARKER },
      description: '合集05 原生 MCP 注解审批夹具',
      exposure: 'codemode'
    }
  }
}))
await copyFile(resolve('scripts/fixtures/mcp-guard-probe.mjs'), join(EXT_DIR, '0-mcp-guard-probe.js'))
await copyFile(resolve('resources/pi-extensions/danger-guard.js'), join(EXT_DIR, '9-danger-guard.js'))

function startPi() {
  const child = spawn(process.execPath, [CLI, '--mode', 'rpc', '--session-dir', SESSIONS_DIR], {
    cwd: ROOT,
    env: isolatedEnv(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const rpc = { child, frames: [], stderr: '', pending: new Map(), seq: 0, exited: null, buffer: '' }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (part) => {
    rpc.buffer += part
    let index
    while ((index = rpc.buffer.indexOf('\n')) >= 0) {
      const line = rpc.buffer.slice(0, index)
      rpc.buffer = rpc.buffer.slice(index + 1)
      if (!line.trim()) continue
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      rpc.frames.push(frame)
      if (frame.type === 'response') {
        const pending = rpc.pending.get(String(frame.id))
        if (pending) { rpc.pending.delete(String(frame.id)); clearTimeout(pending.timer); pending.resolve(frame) }
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (part) => { rpc.stderr += part })
  child.on('exit', (code, signal) => {
    rpc.exited = { code, signal }
    for (const pending of rpc.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`pi exited (${code}) while waiting: ${rpc.stderr.slice(-800)}`))
    }
    rpc.pending.clear()
  })
  rpc.command = (type, params = {}, timeoutMs = 30000) => new Promise((resolveCommand, rejectCommand) => {
    if (rpc.exited) return rejectCommand(new Error(`pi already exited (${rpc.exited.code})`))
    const id = String(++rpc.seq)
    const timer = setTimeout(() => {
      rpc.pending.delete(id)
      rejectCommand(new Error(`RPC timeout: ${type}: ${rpc.stderr.slice(-800)}`))
    }, timeoutMs)
    rpc.pending.set(id, {
      timer,
      resolve: (value) => { clearTimeout(timer); resolveCommand(value) },
      reject: (error) => { clearTimeout(timer); rejectCommand(error) }
    })
    child.stdin.write(`${JSON.stringify({ id, type, ...params })}\n`)
  })
  rpc.waitSettled = async (after, timeoutMs = 60000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (rpc.frames.slice(after).some((frame) => frame.type === 'agent_settled')) return
      if (rpc.exited) throw new Error(`pi exited before settling (${rpc.exited.code}): ${rpc.stderr.slice(-800)}`)
      await delay(20)
    }
    throw new Error(`pi did not settle: ${rpc.stderr.slice(-800)}`)
  }
  rpc.stop = async () => {
    if (rpc.exited) return
    const exited = new Promise((done) => child.once('exit', done))
    try { child.stdin.end() } catch { }
    const timer = setTimeout(() => child.kill(), 3000)
    await exited
    clearTimeout(timer)
  }
  return rpc
}

async function markerCount(toolName) {
  try {
    const text = await readFile(MARKER, 'utf8')
    return text.split('\n').filter((line) => line === `invoked:${toolName}`).length
  } catch {
    return 0
  }
}

let proc
try {
  const chunkDir = join(runtimeDir, 'dist/bundle/chunks')
  const namingNeedle = 'mcp__${server}__${tool}'
  const hintsNeedle = 'ANNOTATION_HINTS=["readOnlyHint","destructiveHint","idempotentHint","openWorldHint"]'
  for (const file of await readdir(chunkDir)) {
    if (!file.endsWith('.js')) continue
    const text = await readFile(join(chunkDir, file), 'utf8')
    if (!results.sourceCheck.namingFile && text.includes(namingNeedle)) results.sourceCheck.namingFile = file
    if (!results.sourceCheck.hintsFile && text.includes(hintsNeedle)) results.sourceCheck.hintsFile = file
  }
  check(results.sourceCheck.namingFile, `源核对：pi 1.2.0 的 MCP 工具名模板是 mcp__\${server}__\${tool}（在 ${results.sourceCheck.namingFile ?? '未找到'}）`)
  check(results.sourceCheck.hintsFile, `源核对：pi 1.2.0 注解白名单含 readOnlyHint/destructiveHint/openWorldHint（在 ${results.sourceCheck.hintsFile ?? '未找到'}）`)

  proc = startPi()
  const ready = await proc.command('get_state')
  check(ready.success, `get_state：${ready.error ?? 'ok'}`)

  const models = (await proc.command('get_available_models')).data.models
  check(models.some((model) => model.provider === PROVIDER && model.id === MODEL), '本机 provider/id 在可用模型里')
  const selected = await proc.command('set_model', { provider: PROVIDER, modelId: MODEL })
  check(selected.success, `set_model 本机模型：${selected.error ?? 'ok'}`)

  const firstTurnTool = `mcp__${SERVER_NAME}__${EXPECTED[0].tool}`
  turn.tool = firstTurnTool
  turn.callId = 'mcpguard-0'
  const beforeWarmup = proc.frames.length
  const warmup = await proc.command('prompt', { message: 'MCP_GUARD_TURN warmup' }, 60000)
  check(warmup.success, `warmup prompt 接受：${warmup.error ?? 'ok'}`)
  await proc.waitSettled(beforeWarmup, 120000)
  const declaredTools = (providerRequests[0]?.tools ?? []).map((tool) => tool?.function?.name)
  results.observed.declaredTools = declaredTools
  check(declaredTools.includes(CODEMODE_TOOL), `模型请求声明了 ${CODEMODE_TOOL}（否则无法发起原生嵌套调用）`)

  const firstTurn = {
    ...EXPECTED[0],
    expectedName: firstTurnTool,
    asked: hostRequests.length > 0,
    hostRequests: hostRequests.slice(0),
    executed: (await markerCount(EXPECTED[0].tool)) > 0,
    callId: turn.callId
  }
  results.turns.push(firstTurn)

  for (let index = 1; index < EXPECTED.length; index += 1) {
    const spec = EXPECTED[index]
    const expectedName = `mcp__${SERVER_NAME}__${spec.tool}`
    turn.tool = expectedName
    turn.callId = `mcpguard-${index}`
    const beforeHost = hostRequests.length
    const beforeMarker = await markerCount(spec.tool)
    const beforeFrames = proc.frames.length
    const prompted = await proc.command('prompt', { message: `MCP_GUARD_TURN ${spec.tool}` }, 60000)
    check(prompted.success, `${spec.tool}：prompt 接受（${prompted.error ?? 'ok'}）`)
    await proc.waitSettled(beforeFrames, 120000)
    const requests = hostRequests.slice(beforeHost)
    results.turns.push({
      ...spec,
      expectedName,
      asked: requests.length > 0,
      hostRequests: requests,
      executed: (await markerCount(spec.tool)) > beforeMarker,
      callId: turn.callId
    })
  }

  for (const observed of results.turns) {
    const fixture = fixtureByName.get(observed.tool)
    check(fixture, `夹具定义了工具 ${observed.tool}`)
    check(observed.asked === observed.expectAsk, `${observed.tool}：${observed.expectAsk ? '应当询问用户' : '不应询问'}（实际 ${observed.asked ? '询问了' : '没问'}）`)
    check(observed.executed === observed.expectExecuted, `${observed.tool}：server 执行状态应为 ${observed.expectExecuted}（实际 ${observed.executed}）`)
    if (observed.decision === 'deny') {
      check(observed.executed === false, `${observed.tool}：用户拒绝后 server 侧没有被执行`)
    } else {
      check(observed.executed === true, `${observed.tool}：放行 / 不问时 server 侧确实执行了`)
    }
    if (observed.expectAsk) {
      check(observed.hostRequests.length === 1, `${observed.tool}：恰好一次审批请求`)
      const request = observed.hostRequests[0] ?? {}
      check(request.command === 'danger.confirm', `${observed.tool}：审批走 danger.confirm`)
      check(request.params?.tool === observed.expectedName, `${observed.tool}：审批请求带真实工具名`)
      const reasons = request.params?.reasons ?? []
      check(reasons.some((reason) => reason.includes('MCP 工具可能修改数据或对外操作')), `${observed.tool}：审批理由写明 MCP 工具`)
      check(reasons.some((reason) => reason.includes(`${SERVER_NAME} / ${observed.tool}`)), `${observed.tool}：审批理由写明服务 / 工具`)
    } else {
      check(hostRequests.every((request) => request.params?.tool !== observed.expectedName), `${observed.tool}：不问的调用不产生审批请求`)
    }
  }

  const probe = (await readFile(PROBE_LOG, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const mcpRecords = probe.filter((record) => typeof record.toolName === 'string' && record.toolName.startsWith('mcp__'))
  const observedNames = [...new Set(mcpRecords.map((record) => record.toolName))].sort()
  results.observed.mcpToolNames = observedNames
  results.observed.probeCount = probe.length

  for (const observed of results.turns) {
    const records = mcpRecords.filter((record) => record.toolName === observed.expectedName)
    check(records.length > 0, `${observed.tool}：真实内部事件出现该工具名（观测到的 mcp__ 名：${observedNames.join(', ') || '无'}）`)
    const nested = records.filter((record) => typeof record.parentToolCallId === 'string')
    check(nested.length > 0, `${observed.tool}：走的是 codemode 原生嵌套调用（有真实 parentToolCallId）`)
    check(nested.every((record) => record.parentToolCallId === observed.callId), `${observed.tool}：parentToolCallId 等于模型发出的 codemode 调用 id（${observed.callId}）`)
    check(nested.some((record) => new RegExp(`^${observed.callId}/\\d+$`).test(record.toolCallId ?? '')), `${observed.tool}：嵌套调用 id 由 pi 分配为 <parent>/<n>`)
    const meta = records.map((record) => record.tool).find((tool) => tool && tool.name) ?? null
    check(meta, `${observed.tool}：真实 getAllTools() 里有该工具项`)
    const observedAnnotations = meta?.annotations ?? null
    const expectedAnnotations = fixtureByName.get(observed.tool)?.annotations ?? null
    results.observed[observed.tool] = { name: meta?.name ?? null, annotations: observedAnnotations }
    check(canonical(observedAnnotations) === canonical(expectedAnnotations), `${observed.tool}：getAllTools 注解与夹具一致（期望 ${JSON.stringify(expectedAnnotations)}，实际 ${JSON.stringify(observedAnnotations)}）`)
  }

  const topLevel = probe.find((record) => record.toolName === CODEMODE_TOOL && !record.parentToolCallId && record.toolCallId === 'mcpguard-0')
  check(topLevel, '顶层 codemode 调用被真实内部事件记录（无 parent）')
  check(observedNames.length === EXPECTED.length, `本条服务只多出 ${EXPECTED.length} 个 mcp__ 工具（观测：${observedNames.join(', ')}）`)

  console.log(`PASS: 原生 MCP 注解审批夹具（${results.checks} 项检查）`)
  console.log(`  源核对工具名模板        : ${results.sourceCheck.namingFile}`)
  console.log(`  源核对注解白名单        : ${results.sourceCheck.hintsFile}`)
  console.log(`  模型请求声明的 codemode : ${results.observed.declaredTools?.includes(CODEMODE_TOOL)}`)
  console.log(`  真实 mcp__ 工具名       : ${observedNames.join(', ')}`)
  for (const observed of results.turns) {
    const meta = results.observed[observed.tool]
    console.log(`  ${observed.tool.padEnd(17)} name=${meta?.name} annotations=${JSON.stringify(meta?.annotations)} asked=${observed.asked} executed=${observed.executed}`)
  }
} catch (error) {
  console.error('\n=== RESULTS (before failure) ===')
  console.error(JSON.stringify(results, null, 2))
  try {
    const probeText = await readFile(PROBE_LOG, 'utf8')
    console.error('=== PROBE LOG ===')
    console.error(probeText.trim() || '(empty)')
  } catch {
    console.error('=== PROBE LOG: missing ===')
  }
  console.error('=== HOST REQUESTS ===')
  console.error(JSON.stringify(hostRequests, null, 2))
  console.error('=== PROVIDER REQUESTS (tools declared) ===')
  console.error(JSON.stringify(providerRequests.map((request) => ({ tools: (request.tools ?? []).map((tool) => tool?.function?.name), lastRole: request.messages?.at(-1)?.role })), null, 2))
  console.error('=== PI STDERR (tail) ===')
  console.error(proc?.stderr?.slice(-4000) ?? '(none)')
  console.error('=== RPC FRAME TYPES ===')
  const counts = new Map()
  for (const frame of proc?.frames ?? []) counts.set(frame.type, (counts.get(frame.type) ?? 0) + 1)
  console.error(JSON.stringify(Object.fromEntries(counts), null, 2))
  console.error('=== RPC FRAMES mentioning error/guard/extension ===')
  for (const frame of proc?.frames ?? []) {
    const text = JSON.stringify(frame)
    if (/error|guard|extension/i.test(text)) console.error(text.slice(0, 900))
  }
  throw error
} finally {
  if (proc && !proc.exited) await proc.stop().catch(() => {})
  hostServer.closeAllConnections()
  providerServer.closeAllConnections()
  if (hostServer.listening) await new Promise((done) => hostServer.close(done))
  if (providerServer.listening) await new Promise((done) => providerServer.close(done))
  await rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
