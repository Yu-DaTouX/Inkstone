import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
import {
  VIRTUAL_PROVIDER,
  VIRTUAL_ID,
  PHYSICAL_ID,
  VIRTUAL_CONTEXT_WINDOW,
  VIRTUAL_MAX_TOKENS
} from './fixtures/virtual-model-extension.mjs'

const PHYSICAL_CONTEXT_WINDOW = 32000
const ROOT = await mkdtemp(join(tmpdir(), 'inkstone-virtual-model-'))
const PI_DIR = join(ROOT, 'pi')
const DATA_DIR = join(ROOT, 'yan')
const SESSIONS_DIR = join(ROOT, 'sessions')
const CODEMODE_SESSIONS_DIR = join(ROOT, 'codemode-sessions')
const EXTENSIONS_DIR = join(PI_DIR, 'extensions')
const HOOK_LOG = join(ROOT, 'hook-events.jsonl')
const CLI = join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js')

const results = { fixture: {}, phases: {}, checks: 0 }
const check = (condition, label) => {
  assert.ok(condition, label)
  results.checks += 1
}
const equal = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label)
  results.checks += 1
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

const CREDENTIAL = /(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|_TOKEN$|^ANTHROPIC_|^OPENAI_|^GEMINI_|^GOOGLE_|^XAI_|^GROK_|^DEEPSEEK_|^OPENROUTER_|^AWS_|^AZURE_|^MISTRAL_|^COHERE_)/i
function isolatedEnv(extra = {}) {
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: PI_DIR,
    YAN_PI_DIR: PI_DIR,
    YAN_DATA_DIR: DATA_DIR,
    YAN_SESSIONS_DIR: SESSIONS_DIR,
    VM_FIXTURE_HOOK_LOG: HOOK_LOG,
    ...extra
  }
  for (const key of Object.keys(env)) if (CREDENTIAL.test(key)) delete env[key]
  return env
}

const requests = []
function chunk(delta, finishReason = null, usage) {
  const body = { id: 'vm-fix', object: 'chat.completion.chunk', created: 0, model: 'vmfix-physical', choices: [{ index: 0, delta, finish_reason: finishReason }] }
  if (usage) body.usage = usage
  return `data: ${JSON.stringify(body)}\n\n`
}
const USAGE = { prompt_tokens: 1200, completion_tokens: 12, total_tokens: 1212 }
const CODEMODE_CODE = 'const r = await tools.bash({ command: "echo vmfixture-inner" }); text("INNER:" + JSON.stringify(r));'
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (part) => { body += part })
  req.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch { }
    requests.push(payload)
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
    const lastIsTool = messages.at(-1)?.role === 'tool'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (/CODEMODE_HOOK/.test(lastUserText) && !lastIsTool) {
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'vm-code-call', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code: CODEMODE_CODE }) } }] }))
      res.write(chunk({}, 'tool_calls'))
    } else if (lastIsTool) {
      res.write(chunk({ role: 'assistant', content: 'CODEMODE-DONE' }))
      res.write(chunk({}, 'stop', USAGE))
    } else {
      res.write(chunk({ role: 'assistant', content: 'VIRTUAL-MODEL-FIXTURE-REPLY' }))
      res.write(chunk({}, 'stop', USAGE))
    }
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const PORT = server.address().port

for (const dir of [PI_DIR, DATA_DIR, SESSIONS_DIR, CODEMODE_SESSIONS_DIR, EXTENSIONS_DIR]) await mkdir(dir, { recursive: true })
await writeFile(join(PI_DIR, 'auth.json'), '{}')
await writeFile(join(PI_DIR, 'models.json'), JSON.stringify({
  providers: {
    [VIRTUAL_PROVIDER]: {
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      api: 'openai-completions',
      apiKey: 'fixture-only',
      models: [{
        id: PHYSICAL_ID,
        name: 'VM fixture physical',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: PHYSICAL_CONTEXT_WINDOW,
        maxTokens: 2048
      }]
    }
  }
}))
await copyFile(resolve('scripts/fixtures/virtual-model-extension.mjs'), join(EXTENSIONS_DIR, 'virtual-model-extension.js'))
await copyFile(resolve('scripts/fixtures/virtual-model-hook.mjs'), join(EXTENSIONS_DIR, 'virtual-model-hook.js'))

const writeSettings = (extra = {}) => writeFile(join(PI_DIR, 'settings.json'), JSON.stringify({
  packages: [],
  defaultProvider: VIRTUAL_PROVIDER,
  defaultModel: `${VIRTUAL_PROVIDER}/${VIRTUAL_ID}`,
  defaultTools: [],
  compaction: { enabled: false },
  ...extra
}))
await writeSettings()

function startPi(args, extraEnv = {}) {
  const child = spawn(process.execPath, [CLI, '--mode', 'rpc', ...args], {
    cwd: ROOT,
    env: isolatedEnv(extraEnv),
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
  rpc.waitSettled = async (after, timeoutMs = 30000) => {
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

const assistantMessages = (rpc) => rpc.frames.filter((frame) => frame.type === 'message_end' && frame.message?.role === 'assistant').map((frame) => frame.message)
const lastAssistant = (rpc) => assistantMessages(rpc).at(-1)
const sessionEntries = async (file) => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))

let proc1, proc2, proc3, procNative, procReadOnly, procUnknown, procCodemode
try {
  proc1 = startPi(['--session-dir', SESSIONS_DIR])
  const ready = await proc1.command('get_state')
  check(ready.success, `phase1 get_state: ${ready.error ?? 'ok'}`)
  results.phases.initialDefaultModel = ready.data.model ?? null
  check(ready.data.model?.api !== 'pi-virtual', 'settings.json defaultModel does not select the registered virtual model (pi falls back to the provider physical model)')

  const available = (await proc1.command('get_available_models')).data.models
  const virtual = available.find((model) => model.provider === VIRTUAL_PROVIDER && model.id === VIRTUAL_ID)
  const physical = available.find((model) => model.provider === VIRTUAL_PROVIDER && model.id === PHYSICAL_ID)
  check(virtual, 'get_available_models lists the virtual provider/id')
  check(physical, 'get_available_models still lists the physical fixture model')
  results.phases.availableVirtual = virtual
  results.phases.availablePhysical = physical
  equal(virtual.api, 'pi-virtual', 'virtual model serializes with api pi-virtual')
  equal(virtual.contextWindow, VIRTUAL_CONTEXT_WINDOW, 'virtual model keeps declared contextWindow')
  equal(virtual.maxTokens, VIRTUAL_MAX_TOKENS, 'virtual model keeps declared maxTokens')

  const set = await proc1.command('set_model', { provider: VIRTUAL_PROVIDER, modelId: VIRTUAL_ID })
  check(set.success, `set_model virtual: ${set.error ?? 'ok'}`)
  equal(set.data?.api, 'pi-virtual', 'set_model returns the virtual model itself')

  const stateVirtual = (await proc1.command('get_state')).data
  equal(stateVirtual.model?.provider, VIRTUAL_PROVIDER, 'get_state keeps virtual provider after selection')
  equal(stateVirtual.model?.id, VIRTUAL_ID, 'get_state keeps virtual id after selection')
  results.phases.stateModelVirtual = stateVirtual.model

  const statsBefore = (await proc1.command('get_session_stats')).data
  results.phases.statsBeforeFirstResponse = statsBefore.contextUsage ?? null
  if (statsBefore.contextUsage && statsBefore.contextUsage.contextWindow) {
    equal(statsBefore.contextUsage.contextWindow, VIRTUAL_CONTEXT_WINDOW, 'before first response: context window comes from the virtual declaration')
  }

  const beforePrompt = proc1.frames.length
  const prompted = await proc1.command('prompt', { message: 'Answer with one short line. No tools.' })
  check(prompted.success, `prompt accepted: ${prompted.error ?? 'ok'}`)
  equal(prompted.data?.disposition, 'started', 'prompt started an agent run')
  await proc1.waitSettled(beforePrompt)

  const reply = lastAssistant(proc1)
  check(reply, 'assistant message_end arrived')
  equal(reply.provider, VIRTUAL_PROVIDER, 'assistant message keeps the provider (physical provider id)')
  equal(reply.model, PHYSICAL_ID, 'assistant message records the physical model, not the virtual id')
  equal(reply.api, 'openai-completions', 'assistant message records the physical api')
  results.phases.assistantMessage = { provider: reply.provider, model: reply.model, api: reply.api, stopReason: reply.stopReason }
  equal(requests.length, 1, 'exactly one fixture request for the no-tool turn')
  equal(requests[0].tools?.length ?? 0, 0, 'fixture request declares no tools at all')

  const messages = (await proc1.command('get_messages')).data.messages
  const assistantProjection = messages.filter((message) => message.role === 'assistant').at(-1)
  equal(assistantProjection?.model, PHYSICAL_ID, 'get_messages projects the physical model')

  const statsAfter = (await proc1.command('get_session_stats')).data
  results.phases.statsAfterFirstResponse = statsAfter.contextUsage ?? null
  check(statsAfter.contextUsage, 'after first response: contextUsage present')
  equal(statsAfter.contextUsage.contextWindow, PHYSICAL_CONTEXT_WINDOW, 'after first response: context window follows the physical model that answered')

  const sessionFile = (await proc1.command('get_state')).data.sessionFile
  check(typeof sessionFile === 'string' && sessionFile.length > 0, 'session file exists for restore checks')
  const entries = await sessionEntries(sessionFile)
  const modelChange = entries.filter((entry) => entry.type === 'model_change').at(-1)
  equal(modelChange?.provider, VIRTUAL_PROVIDER, 'session JSONL model_change records the virtual provider')
  equal(modelChange?.modelId, VIRTUAL_ID, 'session JSONL model_change records the virtual id')
  const storedAssistant = entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant').at(-1)?.message
  equal(storedAssistant?.model, PHYSICAL_ID, 'session JSONL assistant entry stores the physical model')
  results.phases.sessionFile = sessionFile
  await proc1.stop()

  proc2 = startPi(['--session', sessionFile, '--session-dir', SESSIONS_DIR])
  const ready2 = await proc2.command('get_state')
  check(ready2.success, `phase2 get_state: ${ready2.error ?? 'ok'}`)
  equal(ready2.data.model?.provider, VIRTUAL_PROVIDER, 'restore keeps the virtual provider')
  equal(ready2.data.model?.id, VIRTUAL_ID, 'restore keeps the virtual id')
  results.phases.restoredWithExtension = ready2.data.model
  await proc2.stop()

  proc3 = startPi(['--session', sessionFile, '--session-dir', SESSIONS_DIR, '--no-extensions'])
  const ready3 = await proc3.command('get_state')
  check(ready3.success, `phase3 get_state: ${ready3.error ?? 'ok'}`)
  results.phases.restoredWithoutExtension = ready3.data.model ?? null
  equal(ready3.data.model?.provider, VIRTUAL_PROVIDER, 'after uninstall: falls back to the physical provider id')
  equal(ready3.data.model?.id, PHYSICAL_ID, 'after uninstall: falls back to the physical model that answered last')

  const { build } = await import('esbuild')
  const compiled = join(ROOT, 'subagent-pi-launch.mjs')
  await build({ entryPoints: [resolve('src/shared/subagent-pi-launch.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { subagentPiArgs } = await import(pathToFileURL(compiled).href)
  const registeredCheck = join(ROOT, 'registered-model.mjs')
  await build({ entryPoints: [resolve('src/main/subagents/registered-model.ts')], outfile: registeredCheck, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { confirmRegisteredModel } = await import(pathToFileURL(registeredCheck).href)
  const registration = (proc, label, readOnly = false) => confirmRegisteredModel({ command: (type, args, options) => proc.command(type, args, options?.timeoutMs ?? 10000) }, label, { readOnly, expectedApi: 'pi-virtual' })
  const nativeArgs = subagentPiArgs({ sessionDir: SESSIONS_DIR, native: true, readOnly: false, model: `${VIRTUAL_PROVIDER}/${VIRTUAL_ID}` })
  const readOnlyArgs = subagentPiArgs({ sessionDir: SESSIONS_DIR, native: true, readOnly: true, model: `${VIRTUAL_PROVIDER}/${VIRTUAL_ID}` })
  results.phases.subagentArguments = { nativeArgs, readOnlyArgs }
  check(!nativeArgs.includes('--no-extensions'), 'non-read-only subagent args omit --no-extensions (native discovery)')
  check(readOnlyArgs.includes('--no-extensions'), 'read-only subagent args keep --no-extensions')
  check(readOnlyArgs.includes('--no-skills'), 'read-only subagent args keep --no-skills')
  await proc3.stop()

  procNative = startPi(['--session-dir', SESSIONS_DIR, ...nativeArgs])
  const nativeReady = await procNative.command('get_state')
  check(nativeReady.success, `native subagent args get_state: ${nativeReady.error ?? 'ok'}`)
  const nativeModels = (await procNative.command('get_available_models')).data.models
  check(nativeModels.some((model) => model.provider === VIRTUAL_PROVIDER && model.id === VIRTUAL_ID), 'non-read-only subagent sees the discovered virtual model')
  equal(nativeReady.data.model?.id, VIRTUAL_ID, 'non-read-only subagent keeps the requested virtual model (identity match)')
  equal(nativeReady.data.model?.api, 'pi-virtual', 'non-read-only subagent really holds the router (api pi-virtual)')
  equal(await registration(procNative, `${VIRTUAL_PROVIDER}/${VIRTUAL_ID}`), undefined, 'native registered virtual model passes actual set_model lookup')
  await procNative.stop()

  procReadOnly = startPi(['--session-dir', SESSIONS_DIR, ...readOnlyArgs])
  let readOnlyModels = []
  let readOnlyState = null
  let readOnlyFailure = null
  try {
    const readOnlyReady = await procReadOnly.command('get_state', {}, 15000)
    readOnlyState = readOnlyReady.data?.model ?? null
    readOnlyModels = (await procReadOnly.command('get_available_models')).data.models
  } catch (error) {
    readOnlyFailure = String(error.message ?? error)
  }
  results.phases.readOnlySubagent = { state: readOnlyState, virtualVisible: readOnlyModels.some((model) => model.id === VIRTUAL_ID), failure: readOnlyFailure }
  check(!readOnlyModels.some((model) => model.provider === VIRTUAL_PROVIDER && model.id === VIRTUAL_ID), 'read-only subagent cannot see the virtual model')
  check(readOnlyFailure || readOnlyState?.api !== 'pi-virtual', 'read-only subagent never holds the virtual router')
  if (readOnlyState?.id === VIRTUAL_ID && readOnlyState?.api !== 'pi-virtual') {
    results.phases.readOnlyIdentityMismatch = 'get_state reports the virtual id with physical api/contextWindow; modelMismatch (provider/id string compare) would accept it'
  }
  if (!procReadOnly.exited) {
    const registrationError = await registration(procReadOnly, `${VIRTUAL_PROVIDER}/${VIRTUAL_ID}`, true)
    results.phases.readOnlySubagent.registrationError = registrationError ?? null
    check(typeof registrationError === 'string', 'read-only synthetic virtual id fails native registration; no prompt is sent')
    await procReadOnly.stop()
  }

  procUnknown = startPi(['--session-dir', SESSIONS_DIR, '--no-extensions', '--model', `${VIRTUAL_PROVIDER}/does-not-exist`])
  try {
    const unknownReady = await procUnknown.command('get_state', {}, 15000)
    results.phases.unknownModelFallback = unknownReady.data?.model ?? null
    check(typeof await registration(procUnknown, `${VIRTUAL_PROVIDER}/does-not-exist`) === 'string', 'generic unknown synthetic id also fails native registration')
  } catch (error) {
    results.phases.unknownModelFallback = { failure: String(error.message ?? error) }
  }
  if (!procUnknown.exited) await procUnknown.stop()

  await writeSettings({ defaultTools: ['+codemode'] })
  procCodemode = startPi(['--session-dir', CODEMODE_SESSIONS_DIR])
  const codemodeReady = await procCodemode.command('get_state')
  check(codemodeReady.success, `codemode get_state: ${codemodeReady.error ?? 'ok'}`)
  check((await procCodemode.command('get_available_models')).data.models.some((model) => model.id === VIRTUAL_ID), 'codemode session still exposes the virtual model')
  await procCodemode.command('set_model', { provider: VIRTUAL_PROVIDER, modelId: VIRTUAL_ID })
  const beforeCodemode = procCodemode.frames.length
  const codemodePrompt = await procCodemode.command('prompt', { message: 'CODEMODE_HOOK run the harmless inner command.' })
  check(codemodePrompt.success, `codemode prompt accepted: ${codemodePrompt.error ?? 'ok'}`)
  await procCodemode.waitSettled(beforeCodemode)

  const hookEvents = (await readFile(HOOK_LOG, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  results.phases.hookEvents = hookEvents
  const parentCall = hookEvents.find((event) => event.kind === 'tool_call' && event.toolName === 'codemode')
  const innerCall = hookEvents.find((event) => event.kind === 'tool_call' && event.toolName === 'bash')
  const innerResult = hookEvents.find((event) => event.kind === 'tool_result' && event.toolName === 'bash')
  check(parentCall, 'tool_call hook fires for the model-issued codemode call')
  equal(parentCall?.parentToolCallId, null, 'codemode call is a top-level call (no parent)')
  check(innerCall, 'tool_call hook fires for the codemode-nested tools.bash call')
  equal(innerCall?.parentToolCallId, 'vm-code-call', 'nested bash call carries the real parentToolCallId')
  check(/^vm-code-call\/\d+$/.test(innerCall?.toolCallId ?? ''), 'pi assigns <parent id>/<n> to the nested call')
  check(innerResult, 'tool_result hook fires for the nested bash call')
  equal(innerResult?.parentToolCallId, 'vm-code-call', 'nested bash result keeps the same parent identity')
  const innerEnd = hookEvents.find((event) => event.kind === 'tool_execution_end' && event.toolName === 'bash')
  results.phases.nestedBashOutcome = innerEnd ? { isError: innerEnd.isError ?? null } : null
  await procCodemode.stop()

  console.log(`PASS: virtual model native fixture (${results.checks} checks)`)
  console.log(`  virtual serialization : ${JSON.stringify(results.phases.availableVirtual)}`)
  console.log(`  assistant physical    : ${JSON.stringify(results.phases.assistantMessage)}`)
  console.log(`  context window before : ${results.phases.statsBeforeFirstResponse?.contextWindow ?? 'omitted'}`)
  console.log(`  context window after  : ${results.phases.statsAfterFirstResponse?.contextWindow ?? 'omitted'}`)
  console.log(`  restore with/without  : ${results.phases.restoredWithExtension?.id ?? 'none'} / ${results.phases.restoredWithoutExtension?.id ?? 'none'}`)
  console.log(`  subagent native args  : ${JSON.stringify(results.phases.subagentArguments?.nativeArgs)}`)
  console.log(`  subagent read-only    : ${JSON.stringify(results.phases.subagentArguments?.readOnlyArgs)}`)
  console.log(`  read-only outcome     : ${JSON.stringify(results.phases.readOnlySubagent)}`)
  console.log(`  unknown --model      : ${JSON.stringify(results.phases.unknownModelFallback)}`)
  console.log(`  codemode inner hook   : ${JSON.stringify(hookEvents)}`)
} catch (error) {
  console.error('\n=== RESULTS (before failure) ===')
  console.error(JSON.stringify(results, null, 2))
  throw error
} finally {
  for (const proc of [proc1, proc2, proc3, procNative, procReadOnly, procUnknown, procCodemode]) {
    if (proc && !proc.exited) await proc.stop().catch(() => {})
  }
  server.closeAllConnections()
  if (server.listening) await new Promise((done) => server.close(done))
  await rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
