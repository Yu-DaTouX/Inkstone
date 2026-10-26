import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

const envBefore = { ...process.env }
const root = await mkdtemp(join(tmpdir(), 'inkstone-prompt-sections-'))
const compiled = await mkdtemp(resolve('node_modules/.inkstone-prompt-sections-'))
const requests = []
let agent, checks = 0
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++ }
const wait = async (condition, label) => {
  const end = Date.now() + 30000
  while (Date.now() < end) { if (condition()) return; await new Promise(done => setTimeout(done, 25)) }
  throw new Error(`Timeout: ${label}`)
}
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    requests.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0, delta, finish_reason }] })
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'OK' }))}\n\n`)
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`)
    res.end()
  })
})
const systemText = request => {
  const message = (request.messages ?? []).find(m => m.role === 'system' || m.role === 'developer')
  if (!message) return ''
  return typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('')
}
const count = (text, needle) => text.split(needle).length - 1
const ext = name => resolve('resources/pi-extensions', name)

try {
  const pi = join(root, 'pi'), data = join(root, 'data'), sessions = join(root, 'sessions'), cwd = join(root, 'project')
  for (const p of [pi, data, sessions, cwd]) await mkdir(p)
  for (const key of Object.keys(process.env)) if (/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$|^YAN_|^PI_SESSION_|^PI_MODEL$|^PI_PROVIDER$/.test(key)) delete process.env[key]
  delete process.env.ELECTRON_RUN_AS_NODE
  Object.assign(process.env, { YAN_PI_DIR: pi, PI_CODING_AGENT_DIR: pi, YAN_DATA_DIR: data, YAN_SESSIONS_DIR: sessions })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  await writeFile(join(pi, 'auth.json'), '{}')
  await writeFile(join(pi, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: 'fixture', defaultModel: 'model', defaultThinkingLevel: 'off', retry: { enabled: false }, compaction: { enabled: false } }))
  await writeFile(join(pi, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local', models: [{ id: 'model', name: 'model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }] } } }))
  await writeFile(join(pi, 'mcp.json'), JSON.stringify({ mcpServers: { probe_server: { command: process.execPath, args: ['-e', 'setTimeout(()=>{},1)'], exposure: 'deferred', description: 'Fixture server for the system prompt check' } } }))

  const outfile = join(compiled, 'agent.mjs')
  await build({ entryPoints: ['src/main/agent.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'unused-electron', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getLocale:()=> 'en',getPath:()=> ${JSON.stringify(root)}};export class BrowserWindow{};export const session={};`, loader: 'js' }))
  } }] })
  const { AgentController } = await import(pathToFileURL(outfile).href)
  agent = new AgentController({
    cwd,
    piBin: join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js'),
    push: () => {},
    codemodeExtension: ext('codemode-policy.js'),
    questionExtension: ext('question.js'),
    responseDetailExtension: ext('response-detail.js'),
    preambleExtension: ext('preamble.js'),
    languageExtension: ext('language.js'),
    capabilityGuideExtension: ext('capability-guide.js'),
    autoCompactExtension: ext('auto-compact.js'),
    nativeSessionExtension: ext('native-session-bridge.js'),
    mcpAppProxyExtension: ext('mcp-app-proxy.js'),
    repeatGuardExtension: ext('repeat-guard.js'),
    dangerGuardExtension: ext('danger-guard.js')
  })
  agent.maybeGenerateTitle = async () => null
  equal((await agent.start()).ok, true, 'actual bundled pi starts isolated with Inkstone extensions')
  for (const text of ['FIRST', 'SECOND']) {
    const before = requests.length
    equal((await agent.send(text)).ok, true, `${text}: accepted`)
    await wait(() => requests.length > before, `${text}: model request`)
    await wait(() => !agent.getState()?.isAgentRunning && !agent.getState()?.isStreaming, `${text}: settled`)
  }
  const [first, second] = requests.map(systemText)
  const expectations = [
    ['<mcp_servers>', 1, 'pi native MCP section survives Inkstone extensions'],
    ['probe_server', 1, 'configured deferred MCP server is listed'],
    ['You are an assistant operating inside Inkstone', 1, 'Inkstone identity replaces the preamble'],
    ['You are an expert coding assistant operating inside pi', 0, 'pi identity sentence is not sent'],
    ['<inkstone_capabilities>', 1, 'capability guide renders as its own section'],
    ['Inkstone provides local capabilities through the `yan` CLI', 1, 'capability guide appears once'],
    ['<inkstone_environment>', 1, 'environment facts render as their own section'],
    ['Today: ', 1, 'local date appears once'],
    ['Interactive questions use `yan question ask`', 1, 'question guidance appears once'],
    ['Work quietly. Before substantive tool work', 1, 'progress guidance appears once'],
    ['\n- Once the requested change is made and the relevant tests or checks pass, stop and report;', 0, 'no finish rule is added'],
    ['\n- When exploring code, read whole files or large ranges', 1, 'work rules are added to pi rules once'],
    ['<docs>', 0, 'pi docs section is dropped entirely, not just compacted'],
    ['Main documentation', 0, 'docs block content is not sent either']
  ]
  for (const [needle, expected, label] of expectations) equal(count(second, needle), expected, label)
  equal(first, second, 'system prompt is identical across turns')
  console.log(`system-prompt-sections: ${checks} checks passed (actual pi, loopback model, no external credentials)`)
} finally {
  if (agent) await agent.stop().catch(() => {})
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  await rm(compiled, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key]
  Object.assign(process.env, envBefore)
}
