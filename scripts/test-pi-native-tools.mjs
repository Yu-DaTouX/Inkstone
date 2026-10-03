import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

// Only a loopback fixture receives requests. No credentials or user history are copied.
const root = await mkdtemp(join(tmpdir(), 'inkstone-native-context-'))
const piDir = join(root, 'pi')
await mkdir(piDir)
const requests = []
const frames = []
const pending = new Map()
let child
let controller
const controllerMode = process.argv.includes('--controller')
const pushes = []
let sequence = 0
let stderr = ''
// Controller probes run sequentially because they compile the same test module.
const nativeSearch = process.argv.includes('--native-search')
const nativeTools = !process.argv.includes('--compact')
const guardProbe = process.argv.includes('--guard')
const profileProbe = process.argv.includes('--profile-blocked')
const onlyMode = process.argv.includes('--only')
const desktopCodemode = process.argv.includes('--desktop-codemode')
const projectPackagePolicy = process.argv.includes('--project-package-policy')
const imageProbe = process.argv.includes('--image')
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
assert(!projectPackagePolicy || controllerMode, 'project package policy must exercise AgentController')
const localTools = process.argv.includes('--no-mcp') || desktopCodemode || imageProbe
const server = createServer((req, res) => {
  let body = ''
  req.on('data', part => { body += part })
  req.on('end', () => {
    const payload = JSON.parse(body)
    requests.push(payload)
    const content = `FIXTURE-${requests.length}: original facts retained`
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'native', choices: [{ index: 0, delta, finish_reason }] })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (nativeTools && requests.length === 1) {
      const name = nativeSearch ? 'tool_search' : 'codemode'
      assert(payload.tools.some(tool => tool.function.name === name))
      if (onlyMode) assert(!payload.tools.some(tool => ['read', 'bash', 'edit', 'write'].includes(tool.function.name)))
      const code = imageProbe
        ? `const values = await Promise.allSettled([tools.read({path:"sample.txt"})]); store("fixture", values); image({ type: "image", data: "${PNG_1PX}", mimeType: "image/png" }); text("IMAGE-SHOWN");`
        : guardProbe
        ? 'text(await tools.powershell({command: \'Write-Output "npm publish"\'}));'
        : localTools
          ? 'const values = await Promise.allSettled([tools.read({path:"sample.txt"}), tools.read({path:"sample.txt"})]); store("fixture", values); text(values);'
          : 'const info = await describeNamespace("fixture"); text(info); const values = await Promise.allSettled([tools.mcp__fixture__echo({text:"NATIVE-MCP-ECHO"}), tools.mcp__fixture__echo({text:"NATIVE-MCP-ECHO"})]); text(values);'
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'native-code', type: 'function', function: { name, arguments: JSON.stringify(nativeSearch ? {query: 'echo', limit: 1} : { code }) } }] }))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`)
    } else if (nativeSearch && requests.length === 2) {
      assert(payload.tools.some(tool => tool.function.name === 'mcp__fixture__echo'), 'native tool search declares the discovered MCP tool')
      res.write(`data: ${JSON.stringify(chunk({role:'assistant',tool_calls:[{index:0,id:'native-echo',type:'function',function:{name:'mcp__fixture__echo',arguments:JSON.stringify({text:'NATIVE-MCP-ECHO'})}}]}))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`)
    } else {
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content }))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
    }
    res.end('data: [DONE]\n\n')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await writeFile(join(piDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fixture-only', models: [{ id: 'native', name: 'Native fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }] } } }))
await writeFile(join(piDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'native', ...(!desktopCodemode ? { defaultTools: nativeSearch ? ['+tool_search'] : ['+codemode', ...(guardProbe ? ['+powershell'] : [])] } : {}), ...(onlyMode ? {codemode:{mode:'only'}} : {}), compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 256 } }))
await writeFile(join(root, 'sample.txt'), 'NATIVE-LOCAL-READ')
if (projectPackagePolicy) {
  await mkdir(join(root, '.pi'))
  for (const name of ['enabled', 'disabled']) {
    const dir = join(root, `package-${name}`)
    await mkdir(dir)
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `native-${name}-fixture`, version: '1.0.0', type: 'module', pi: { extensions: ['./extension.js'] } }))
    await writeFile(join(dir, 'extension.js'), `export default function(pi) { pi.registerCommand('native-${name}-fixture', { description: 'Local package discovery fixture', handler: async () => {} }); }\n`)
  }
  await writeFile(join(root, '.pi', 'settings.json'), JSON.stringify({ packages: [join(root, 'package-enabled'), { source: join(root, 'package-disabled'), extensions: [] }] }))
  await writeFile(join(piDir, 'trust.json'), JSON.stringify({ [root]: true }))
}
const cli = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js'))
if (nativeTools && !localTools && !guardProbe) {
  await writeFile(join(piDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [resolve('scripts/lib/mcp-stdio-fixture.mjs')], exposure: 'codemode', toolExposure: { echo: 'codemode', '*': 'hidden' } } } }))
}
if (profileProbe) {
  await mkdir(join(root, 'yan/agent-profile'), { recursive: true })
  await writeFile(join(root, 'yan/agent-profile/native-fixture.json'), JSON.stringify({ profile: 'daily', activity: 'research', deniedTools: ['mcp__fixture__echo'] }))
}
function command(type, params = {}) {
  if (controller) {
    if (type === 'prompt') return controller.send(params.message).then(result => ({ success: result.ok, error: result.error }))
    if (type === 'compact') return controller.compact().then(result => ({ success: result.ok, error: result.error }))
    return controller.rpc.command(type, params)
  }
  const id = String(++sequence)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${type}; ${stderr.slice(-1500)}`)) }, 20000)
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value) }, reject })
    child.stdin.write(`${JSON.stringify({ id, type, ...params })}\n`)
  })
}
async function settled(after) {
  const end = Date.now() + 20000
  while (Date.now() < end) {
    if (frames.slice(after).some(frame => frame.type === 'agent_settled')) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Agent did not settle: ${stderr.slice(-1500)}`)
}
try {
  if (controllerMode) {
    process.env.YAN_PI_DIR = piDir
    process.env.YAN_DATA_DIR = join(root, 'yan')
    process.env.YAN_SESSIONS_DIR = join(root, 'sessions')
    process.env.YAN_SESSION_ID = 'native-fixture'
    const { build } = await import('esbuild')
    // Browser-backed search is outside this Node/loopback fixture. Fail if invoked.
    await build({ entryPoints: ['src/main/agent.ts'], outfile: 'out/test/native-context-controller.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'unused-electron-search', setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class BrowserWindow { constructor() { throw new Error("Browser search is outside this fixture"); } } export const session = { fromPartition() { throw new Error("Browser search is outside this fixture"); } };', loader: 'js' }))
    } }] })
    const { AgentController } = await import(pathToFileURL(resolve('out/test/native-context-controller.mjs')))
    controller = new AgentController({ cwd: root, piBin: cli, push: event => pushes.push(structuredClone(event)), ...(desktopCodemode ? { codemodeExtension: resolve('resources/pi-extensions/codemode-policy.js'), workModeExtension: resolve('resources/pi-extensions/work-mode.js') } : {}), ...(guardProbe ? { dangerGuardExtension: resolve('resources/pi-extensions/danger-guard.js') } : {}), ...(profileProbe ? { agentProfileExtension: resolve('resources/pi-extensions/profile.js') } : {}), contextExtension: resolve('resources/pi-extensions/context.js'), contextBudgetObserverExtension: resolve('resources/pi-extensions/context-budget-observer.js'), contextBudgetMaintenanceExtension: resolve('resources/pi-extensions/context-budget-maintenance.js'), projectKnowledgeExtension: resolve('resources/pi-extensions/project-knowledge.js'), goalResumeExtension: resolve('resources/pi-extensions/goal-resume.js'), handoffsExtension: resolve('resources/pi-extensions/handoffs.js') })
    // Title generation is a separate UI feature, excluded from this context fixture.
    controller.maybeGenerateTitle = async () => null
    assert.equal((await controller.start()).ok, true)
    controller.rpc.on('event', event => frames.push(event))
    assert.equal(controller.getState().contextPolicy, undefined)
    assert.equal((await controller.requestContextMaintenanceV1()).ok, false)
  } else {
  child = spawn(process.execPath, [cli, '--mode', 'rpc', '--provider', 'fixture', '--model', 'native', '--no-extensions', '--no-skills', ...(nativeTools ? ['--extension', 'builtin:mcp', '--extension', 'builtin:codemode', '--extension', 'builtin:tool-search'] : []), '--session-dir', join(root, 'sessions')], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: piDir, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'pipe' })
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', part => {
    buffer += part
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      const frame = JSON.parse(line)
      frames.push(frame)
      if (frame.type === 'response') { pending.get(String(frame.id))?.resolve(frame); pending.delete(String(frame.id)) }
    }
  })
  child.stderr.on('data', part => { stderr += part })
  }
  const state = await command('get_state')
  assert.equal(state.success, true)
  assert.equal(state.data.autoCompactionEnabled, true)
  if (projectPackagePolicy) {
    const commands = (await command('get_commands')).data.commands
    assert(commands.some(entry => entry.name === 'native-enabled-fixture' && entry.source === 'extension'), 'trusted enabled project package is discovered by native pi')
    assert(!commands.some(entry => entry.name === 'native-disabled-fixture'), 'host must not explicitly reload a project package disabled in native settings')
  }
  if (nativeTools) {
    const before = frames.length
    assert.equal((await command('prompt', { message: 'Call native MCP echo through codemode.' })).success, true)
    await settled(before)
    const toolName = guardProbe ? 'powershell' : localTools ? 'read' : 'mcp__fixture__echo'
    const nested = frames.find(frame => frame.type === 'tool_execution_start' && frame.toolName === toolName)
    assert(nested, JSON.stringify(frames))
    if (!nativeSearch) assert.equal(nested.parentToolCallId, 'native-code')
    const result = frames.find(frame => frame.type === 'tool_execution_end' && frame.toolCallId === nested.toolCallId)
    assert.equal(result.isError, guardProbe || profileProbe)
    if (!guardProbe && !profileProbe) assert(JSON.stringify(result).includes(localTools ? 'NATIVE-LOCAL-READ' : 'NATIVE-MCP-ECHO'))
    const file = (await command('get_state')).data.sessionFile
    const entries = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
    if (!nativeSearch) {
      const recorded = entries.find(entry => entry.message?.role === 'toolResult' && entry.message.toolCallId === 'native-code')?.message.nestedCalls
      assert(recorded?.calls.some(call => call.name === toolName && call.status === (guardProbe || profileProbe ? 'error' : 'ok')))
      const { normalizeHistory } = await import(pathToFileURL(resolve('out/test/pi-compat-normalize.mjs')))
      const history = normalizeHistory(entries.filter(entry => entry.type === 'message').map(entry => entry.message))
      assert(history.some(message => message.toolCalls?.some(call => call.name === toolName && call.parentToolCallId === 'native-code')))
      if (localTools) assert(entries.some(entry => entry.customType === 'codemode-store'))
    }
    if (imageProbe) {
      // Codemode image() output is a top-level image block on the codemode result, in live events and in history.
      const end = frames.find(frame => frame.type === 'tool_execution_end' && frame.toolCallId === 'native-code')
      assert(end?.result?.content?.some(block => block.type === 'image' && block.mimeType === 'image/png' && block.data === PNG_1PX), 'live codemode result carries the image block')
      const stored = entries.find(entry => entry.message?.role === 'toolResult' && entry.message.toolCallId === 'native-code')?.message
      assert(stored?.content?.some(block => block.type === 'image' && block.data === PNG_1PX), 'history keeps the codemode image block')
      const { normalizeHistory } = await import(pathToFileURL(resolve('out/test/pi-compat-normalize.mjs')))
      const history = normalizeHistory(entries.filter(entry => entry.type === 'message').map(entry => entry.message))
      assert(history.some(message => message.toolCalls?.some(call => call.id === 'native-code' && call.images?.length === 1)), 'normalized history attaches the image to the codemode call')
      if (controller) {
        const live = pushes.filter(event => event.ch === 'tool' && event.payload.call.id === 'native-code').at(-1)
        assert.equal(live?.payload.call.images?.length, 1, 'live host projection attaches the image to the codemode call')
      }
    }
    if (controller && !nativeSearch) {
      const parentPush = pushes.find(event => event.ch === 'tool' && event.payload.call.id === 'native-code')
      const nestedPush = pushes.find(event => event.ch === 'tool' && event.payload.call.id === nested.toolCallId)
      assert.equal(nestedPush.payload.msgId, parentPush.payload.msgId, 'nested native tools belong to the parent assistant message')
      assert.equal(nestedPush.payload.call.parentToolCallId, 'native-code')
    }
    if (desktopCodemode) {
      const originalSettings = await readFile(join(piDir, 'settings.json'))
      const desktop = join(root, 'yan', 'desktop.json')
      await mkdir(join(root, 'yan', 'work-mode'), { recursive: true })
      const modeFile = join(root, 'yan', 'work-mode', 'native-fixture.json')
      for (const [enabled, mode, expected] of [[false, 'standard', false], [true, 'standard', true], [true, 'clarify', false], [false, 'standard', false], [true, 'standard', true]]) {
        await writeFile(desktop, JSON.stringify({ codemodeEnabled: enabled }))
        await writeFile(modeFile, JSON.stringify({ mode }))
        const after = frames.length
        assert.equal((await command('prompt', { message: 'Confirm the tool preference for this turn.' })).success, true)
        await settled(after)
        const names = requests.at(-1).tools.map(tool => tool.function.name)
        assert.equal(names.includes('codemode'), expected, `enabled=${enabled}, mode=${mode}`)
        assert(names.includes('read') && names.includes('bash'), 'ordinary tools remain available')
      }
      assert((await readFile(join(piDir, 'settings.json'))).equals(originalSettings), 'desktop preference does not overwrite native pi settings')
    }
    await writeFile(join(root, 'evidence.json'), JSON.stringify({ cli, controller: !!controller, desktopCodemode, nativeMcp: !localTools && !guardProbe, nativeCodemode: !nativeSearch, nativeToolSearch: nativeSearch, guardProbe, profileProbe, onlyMode, localTools, nestedParent: nested.parentToolCallId, requests, frames, pushes }, null, 2))
    console.log(`PASS: native tools, nested identity/history; search=${nativeSearch} guard=${guardProbe} profile=${profileProbe} only=${onlyMode} local=${localTools} projectPackagePolicy=${projectPackagePolicy}\nEvidence: ${root}`)
    process.exitCode = 0
  } else {
  for (const message of [`USER-FACT: project name is Granite\n${'Fixture background material. '.repeat(300)}`, `USER-FACT: output language is Chinese\n${'Fixture recent material. '.repeat(100)}`, 'USER-REQUEST: retain both facts']) {
    const before = frames.length
    assert.equal((await command('prompt', { message })).success, true)
    await settled(before)
  }
  const compact = await command('compact')
  assert.equal(compact.success, true, JSON.stringify(compact))
  const session = (await command('get_state')).data
  const entries = (await readFile(session.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse)
  assert(entries.some(entry => entry.type === 'compaction'), 'pi must persist its native compaction entry')
  assert.equal(entries.filter(entry => entry.type === 'message' && entry.message.role === 'user').length, 3, 'raw user history survives native compaction')
  assert(requests.some(request => JSON.stringify(request).includes('USER-FACT: project name is Granite')), 'native requests contain original user input')
  assert(!requests.some(request => JSON.stringify(request).includes('context budget adjust')), 'host budget instructions must be absent')
  assert(!entries.some(entry => entry.type === 'custom' && /context|handoff/.test(entry.customType ?? '')), 'host context entries must be absent')
  const before = frames.length
  assert.equal((await command('prompt', { message: 'USER-REQUEST: continue after compaction' })).success, true)
  await settled(before)
  assert(requests.length >= 5, 'native compaction and next turn both call the fixture')
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ cli, version: JSON.parse(await readFile(resolve(cli, '../../../package.json'), 'utf8')).version, requests: requests.length, nativeCompaction: true, rawUserMessages: 3, continued: true, sessionFile: session.sessionFile }, null, 2))
  console.log(`PASS: native RPC, three turns, native compaction, preserved raw history, subsequent turn\nEvidence: ${root}`)
  }
} finally {
  await controller?.stop()
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 2000)
    await exited
    clearTimeout(timer)
  }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
