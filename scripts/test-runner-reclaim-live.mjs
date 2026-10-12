/** 真实随包pi的回收/恢复与进程采样；无外部模型，注入时钟推进10分钟。 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
import { sampleProcessTree, remainingProcessIds } from './lib/process-sample.mjs'

const root = await mkdtemp(join(tmpdir(), 'inkstone-runner-reclaim-'))
const compiledDir = await mkdtemp(resolve('node_modules/.inkstone-runner-reclaim-'))
const evidence = resolve(process.env.YAN_RECLAIM_EVIDENCE || `.local-docs/evidence/runner-reclaim-${Date.now()}`)
const pi = join(root, 'pi'), data = join(root, 'data'), sessions = join(root, 'sessions')
const beforeEnv = { ...process.env }
const agents = [], logs = [], setupPending = new Set()
let registry, now = 0, modelRequests = 0, checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++ }
const server = createServer((_req, res) => { modelRequests++; res.writeHead(503); res.end('No model request allowed') })
const allPids = []
try {
  await Promise.all([pi, data, sessions, evidence].map(path => mkdir(path, { recursive: true })))
  Object.assign(process.env, { YAN_PI_DIR: pi, PI_CODING_AGENT_DIR: pi, YAN_DATA_DIR: data, YAN_SESSIONS_DIR: sessions })
  for (const key of Object.keys(process.env)) if (/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(key)) delete process.env[key]
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  await writeFile(join(pi, 'settings.json'), JSON.stringify({ packages: [], enableMcp: false, defaultProvider: 'fixture', defaultModel: 'model', compaction: { enabled: false } }))
  await writeFile(join(pi, 'auth.json'), '{}')
  await writeFile(join(pi, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local',
    models: [{ id: 'model', name: 'model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }]
  } } }))
  const outfile = join(compiledDir, 'reclaim.mjs')
  await build({ stdin: { contents: "export {AgentController} from './src/main/agent'; export {RunnerRegistry} from './src/main/runners'; export * from './src/main/runner-reclaim'", resolveDir: resolve('.') },
    outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'unused-electron', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getLocale:()=> 'en',getPath:()=> ${JSON.stringify(root)}};export class BrowserWindow{};export const session={};`, loader: 'js' }))
    } }] })
  const { AgentController, RunnerRegistry, IDLE_RECLAIM_AFTER_MS: T } = await import(pathToFileURL(outfile).href)
  registry = new RunnerRegistry({ now: () => now, isSessionVisible: () => false, onReclaimed: entry => logs.push(entry), createAgent: (id, cwd, generation) => {
    const agent = new AgentController({ cwd, piBin: join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js'),
      push: () => registry?.noteActivity(id), capability: undefined })
    agent.setRunnerGeneration(generation)
    agent.maybeGenerateTitle = async () => null
    // 只在夹具建3个进程期间阻止已有空闲实例被复用；不发模型任务或改变原生会话。
    const pendingCount = agent.getPendingUiCount.bind(agent)
    agent.getPendingUiCount = () => pendingCount() + (setupPending.has(id) ? 1 : 0)
    agents.push(agent)
    return agent
  } })
  const targets = []
  for (let n = 0; n < 3; n++) {
    const cwd = join(root, `project-${n}`), sessionFile = join(sessions, `fixture-${n}.jsonl`)
    await mkdir(cwd)
    const timestamp = new Date().toISOString()
    const id = `00000000-0000-4000-8000-00000000000${n + 1}`
    await writeFile(sessionFile, [
      { type: 'session', version: 3, id, timestamp, cwd },
      { type: 'message', id: `user000${n}`, parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text: `reclaim-fixture-${n}` }], timestamp: Date.now() } }
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    const target = { cwd, sessionFile, sessionId: id }
    targets.push(target)
    const result = await registry.select(target)
    check(result.ok, result.error ?? 'pi starts and loads saved fixture')
    setupPending.add(result.id)
    check(registry.agentOf(result.id).getState().sessionId === id, '真实pi载入指定会话ID')
    const pid = registry.agentOf(result.id).rpc.child.pid
    allPids.push(pid)
  }
  setupPending.clear()
  check(registry.size === 3, '3个独立真实pi进程登记')
  check(agents.every(agent => !agent.getState().isAgentRunning), '无模型任务且全部空闲')
  const generation = registry.statuses()[0].generation
  const sample = () => process.platform === 'win32' ? sampleProcessTree(process.pid) : null
  const before = sample()
  const piWorkingSet = snapshot => snapshot?.processSamples.filter(item => allPids.includes(item.pid)).reduce((sum, item) => sum + item.workingSetMiB, 0) ?? null
  if (before) check(allPids.every(pid => before.processSamples.some(item => item.pid === pid)), '回收前采样包含3个pi进程')
  now = T - 1
  check(await registry.reclaimIdle() === null, '真实进程阈值前保持')
  now = T
  check(await registry.reclaimIdle() === 'r1' && registry.size === 2, '第一轮关闭1个真实进程')
  check(await registry.reclaimIdle() === 'r2' && registry.size === 1, '第二轮关闭第2个，当前实例保留')
  if (process.platform === 'win32') check(remainingProcessIds(allPids).length === 1, '操作系统只剩当前pi进程，没有回收孤儿')
  const after = sample()
  const activeId = registry.activeRunnerId
  setupPending.add(activeId)
  const restored = await registry.select(targets[0])
  setupPending.clear()
  check(restored.ok && restored.via === 'new', restored.error ?? '回收后切回新建真实进程')
  allPids.push(registry.active().rpc.child.pid)
  check(restored.generation > generation, '恢复代次单调增长')
  check(registry.active().getState().sessionId === targets[0].sessionId, '恢复原会话ID')
  check(JSON.stringify(await registry.active().getMessages()).includes('reclaim-fixture-0'), '恢复原持久化消息')
  check(modelRequests === 0, '回收和切回不发模型请求、不重放任务')
  const result = { checks, clock: 'injected, 10 minutes; no long soak', runtime: 'real bundled pi via Node, not Electron application',
    before, after, piWorkingSetBeforeMiB: piWorkingSet(before), piWorkingSetAfterMiB: piWorkingSet(after),
    piWorkingSetSavedMiB: before && after ? piWorkingSet(before) - piWorkingSet(after) : null, reclaimed: logs, modelRequests }
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  console.log(`runner-reclaim-live: ${checks} checks passed; pi processes 3 -> 1; saved ${result.piWorkingSetSavedMiB?.toFixed(1) ?? 'not sampled'} MiB; model requests ${modelRequests}`)
  console.log(`Evidence: ${evidence}`)
} finally {
  await registry?.stopAll()
  if (process.platform === 'win32' && allPids.length) assert.equal(remainingProcessIds(allPids).length, 0, '夹具收尾无残留pi进程')
  server.closeAllConnections()
  if (server.listening) await new Promise(done => server.close(done))
  for (const key of Object.keys(process.env)) if (!(key in beforeEnv)) delete process.env[key]
  Object.assign(process.env, beforeEnv)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  await rm(compiledDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
