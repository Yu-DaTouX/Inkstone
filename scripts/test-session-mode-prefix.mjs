import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

const envBefore = { ...process.env }
const root = await mkdtemp(join(tmpdir(), 'inkstone-session-mode-'))
const compiled = await mkdtemp(resolve('node_modules/.inkstone-session-mode-'))
const requests = []
const agents = []
let checks = 0
const check = (condition, label, detail = '') => {
  assert.ok(condition, detail ? `${label}: ${detail}` : label)
  checks++
  console.log(`  ✓ ${label}`)
}
const wait = async (condition, label) => {
  const end = Date.now() + 30000
  while (Date.now() < end) { if (condition()) return; await new Promise(done => setTimeout(done, 25)) }
  throw new Error(`Timeout: ${label}`)
}
const textOf = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('')
const systemText = request => textOf((request.messages ?? []).find(m => m.role === 'system' || m.role === 'developer')?.content)
const toolsText = request => JSON.stringify(request.tools ?? [])
const lastUser = request => textOf([...(request.messages ?? [])].reverse().find(m => m.role === 'user' && !textOf(m.content).includes('<yan-reminder>'))?.content)
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const request = JSON.parse(body)
    requests.push(request)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0, delta, finish_reason }] })
    const messages = request.messages ?? []
    const answered = messages.length && messages[messages.length - 1].role === 'tool'
    const prompt = lastUser(request)
    const target = /^WRITE (\S+)$/.exec(prompt)?.[1]
    if (target && !answered) {
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: target, content: 'x\n' }) } }] }))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\ndata: [DONE]\n\n`)
    } else {
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'OK' }))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`)
    }
    res.end()
  })
})

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

  const outfile = join(compiled, 'agent.mjs')
  await build({ entryPoints: ['src/main/agent.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'unused-electron', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getLocale:()=> 'zh-CN',getPath:()=> ${JSON.stringify(root)}};export class BrowserWindow{};export const session={};`, loader: 'js' }))
  } }] })
  const { AgentController } = await import(pathToFileURL(outfile).href)
  const ext = name => resolve('resources/pi-extensions', name)
  const extensions = {
    codemodeExtension: ext('codemode-policy.js'),
    questionExtension: ext('question.js'),
    responseDetailExtension: ext('response-detail.js'),
    preambleExtension: ext('preamble.js'),
    languageExtension: ext('language.js'),
    ultracodeExtension: ext('ultracode.js'),
    capabilityGuideExtension: ext('capability-guide.js'),
    autoCompactExtension: ext('auto-compact.js'),
    nativeSessionExtension: ext('native-session-bridge.js'),
    repeatGuardExtension: ext('repeat-guard.js')
  }
  const startAgent = async (withMode) => {
    const agent = new AgentController({ cwd, piBin: join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js'), push: () => {}, ...extensions, ...(withMode ? { sessionModeExtension: ext('session-mode.js') } : {}) })
    agent.maybeGenerateTitle = async () => null
    agents.push(agent)
    check((await agent.start()).ok, `pi 启动（${withMode ? '加载' : '不加载'} session-mode.js）`)
    return agent
  }
  const turn = async (agent, text) => {
    const before = requests.length
    check((await agent.send(text)).ok, `发送 ${text}`)
    await wait(() => requests.length > before, `${text}: model request`)
    await wait(() => !agent.getState()?.isAgentRunning && !agent.getState()?.isStreaming, `${text}: settled`)
    await new Promise(done => setTimeout(done, 200))
    return requests.slice(before)
  }
  const sizes = request => ({ system: systemText(request).length, tools: toolsText(request).length })
  const rows = []

  const plain = await startAgent(false)
  const [baseline] = await turn(plain, 'FIRST')
  rows.push(['未加载扩展', sizes(baseline)])
  await plain.stop()

  const agent = await startAgent(true)
  const [offRequest] = await turn(agent, 'FIRST')
  rows.push(['加载扩展、模式关闭', sizes(offRequest)])
  check(systemText(offRequest) === systemText(baseline), '加载扩展且模式关闭：系统提示与未加载时逐字节相同')
  check(toolsText(offRequest) === toolsText(baseline), '加载扩展且模式关闭：工具定义与未加载时逐字节相同')
  check(JSON.stringify(offRequest.messages.slice(1)) === JSON.stringify(baseline.messages.slice(1)), '模式关闭：消息列表也与未加载时相同')
  check(!agent.getState()?.sessionMode, '新会话默认没有模式')

  const sameAsBaseline = (request, label) => {
    check(systemText(request) === systemText(baseline), `${label}：系统提示不变`)
    check(toolsText(request) === toolsText(baseline), `${label}：工具定义不变`)
  }
  const reminderCount = (request, needle) => (request.messages ?? []).filter(m => m.role === 'user' && textOf(m.content).includes(needle)).length
  const toolResult = request => textOf([...(request.messages ?? [])].reverse().find(m => m.role === 'tool')?.content)

  check((await agent.setSessionMode('ask')).ok && agent.getState()?.sessionMode === 'ask', '切到只读模式，会话状态带 sessionMode')
  const askTurn = await turn(agent, 'WRITE ask.txt')
  rows.push(['只读模式', sizes(askTurn[0])])
  for (const [index, request] of askTurn.entries()) sameAsBaseline(request, `只读模式第 ${index + 1} 个请求`)
  check(reminderCount(askTurn[0], 'Read-only mode (/ask) is on') === 1, '只读模式加一条隐藏通告（在消息里，不在前缀里）')
  check(!existsSync(join(cwd, 'ask.txt')), '只读模式下 write 被拦，文件没有写出')
  check(toolResult(askTurn.at(-1)).includes('Read-only mode (/ask) is on, so the host blocked this tool call'), '模型收到只读拦截说明')

  check((await agent.setSessionMode('plan')).ok && agent.getState()?.sessionMode === 'plan', '切到计划模式')
  const planTurn = await turn(agent, 'WRITE plan.txt')
  rows.push(['计划模式', sizes(planTurn[0])])
  for (const [index, request] of planTurn.entries()) sameAsBaseline(request, `计划模式第 ${index + 1} 个请求`)
  check(reminderCount(planTurn[0], 'Plan mode (/plan) is on: plan first') === 1, '计划模式加一条隐藏指引')
  check(!existsSync(join(cwd, 'plan.txt')), '计划模式下 write 被拦')
  check(toolResult(planTurn.at(-1)).includes('Approve button'), '模型收到计划拦截说明')

  check((await agent.setSessionMode('approve')).ok && !agent.getState()?.sessionMode, '批准后会话状态不再带模式')
  const runTurn = await turn(agent, 'WRITE run.txt')
  rows.push(['批准后', sizes(runTurn[0])])
  for (const [index, request] of runTurn.entries()) sameAsBaseline(request, `批准后第 ${index + 1} 个请求`)
  check(reminderCount(runTurn[0], 'The user approved the plan') === 1, '批准后加一条按计划执行的通告')
  check(existsSync(join(cwd, 'run.txt')), '批准后 write 正常执行')
  check(!(await agent.setSessionMode('approve')).ok, '不在计划模式时不能批准')

  check((await agent.setSessionMode('ask')).ok, '再次进入只读')
  check((await agent.setSessionMode('off')).ok && !agent.getState()?.sessionMode, '一键退出只读')
  const offTurn = await turn(agent, 'WRITE off.txt')
  check(existsSync(join(cwd, 'off.txt')), '退出后 write 正常执行')
  check(reminderCount(offTurn[0], 'Read-only mode is off') === 0, '没有通告过的模式退出时不加消息')
  sameAsBaseline(offTurn[0], '退出后')

  console.log('\n  字符数（系统提示 / 工具定义）：')
  for (const [label, size] of rows) console.log(`    ${label}：${size.system} / ${size.tools}`)
  console.log(`session-mode-prefix: ${checks} checks passed (actual pi, loopback model)`)
} finally {
  for (const agent of agents) await agent.stop().catch(() => {})
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  await rm(compiled, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key]
  Object.assign(process.env, envBefore)
}
