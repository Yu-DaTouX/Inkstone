import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

const root = await mkdtemp(join(tmpdir(), 'inkstone-move-live-'))
const srcDir = join(root, 'proj-a')
const targetDir = join(root, 'proj-b')
let checks = 0
const ok = (value, label) => { assert.ok(value, label); checks++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (condition, label, timeoutMs = 30000) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { if (await condition()) return true; await sleep(50) }
  throw new Error('超时：' + label)
}
const warnings = []

const prompts = []
const model = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    try { prompts.push(JSON.parse(body)) } catch { prompts.push({ raw: body }) }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish = null) => JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0, delta, finish_reason: finish }] })
    res.write(`data: ${chunk({ role: 'assistant', content: '收到，继续处理。' })}\n\n`)
    res.write(`data: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`)
    res.end()
  })
})

const functionsOf = (source, names) => {
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found = []
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
      const text = node.getText(ast)
      found.push(text.startsWith('export ') ? text.slice(7) : text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(found.length, names.length, '宿主函数都能取到')
  return found.join('\n')
}

const controllers = []
const liveAgents = []
let outDir
const cleanupOut = async () => { if (outDir) await rm(outDir, { recursive: true, force: true }).catch(() => undefined) }
try {
  const piDir = join(root, 'pi')
  const dataDir = join(root, 'data')
  const sessions = join(root, 'sessions')
  for (const dir of [piDir, dataDir, sessions, srcDir, targetDir]) await mkdir(dir, { recursive: true })
  for (const key of Object.keys(process.env)) {
    if (/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$|^YAN_|^PI_SESSION_|^PI_MODEL$|^PI_PROVIDER$/.test(key)) delete process.env[key]
  }
  delete process.env.ELECTRON_RUN_AS_NODE
  Object.assign(process.env, { YAN_PI_DIR: piDir, PI_CODING_AGENT_DIR: piDir, YAN_DATA_DIR: dataDir, YAN_SESSIONS_DIR: sessions })

  await new Promise(done => model.listen(0, '127.0.0.1', done))
  await writeFile(join(piDir, 'auth.json'), '{}')
  await writeFile(join(piDir, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: 'fixture', defaultModel: 'model', defaultThinkingLevel: 'off', retry: { enabled: false }, compaction: { enabled: false } }))
  await writeFile(join(piDir, 'models.json'), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        api: 'openai-completions',
        apiKey: 'local',
        models: [{ id: 'model', name: 'model', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }]
      }
    }
  }))

  outDir = await mkdtemp(resolve('node_modules/.inkstone-move-live-'))
  const electronStub = {
    name: 'stub-electron',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app={getLocale:()=>"en",getPath:()=>"",getVersion:()=>"0"};export class BrowserWindow{};export const shell={};export const ipcMain={};export const nativeImage={createFromBuffer:()=>({isEmpty:()=>false})};export const session={};', loader: 'js' }))
    }
  }
  const bundle = async (entry, name) => {
    const outfile = join(outDir, name)
    await build({ entryPoints: [entry], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub] })
    return import(pathToFileURL(outfile).href)
  }
  const { AgentController } = await bundle('src/main/agent.ts', 'agent.mjs')
  const { RunnerRegistry } = await bundle('src/main/runners.ts', 'runners.mjs')
  const { sameRuntimeEnvelope } = await bundle('src/core/run-state.ts', 'run-state.mjs')
  const { rewriteSessionCwd, movedSessionContinuationPrompt } = await bundle('src/main/session-move.ts', 'session-move.mjs')

  const hostCode = functionsOf(await readFile('src/main/index.ts', 'utf8'),
    ['requestSessionMove', 'moveSessionWhenIdle', 'continueMovedSession', 'pinSendTarget', 'pinnedTargetMatches', 'normalizeCwdForIdentity'])
  const transpiled = ts.transpileModule(`const pendingSessionMoves = new Map();\nglobalThis.moveJobs = pendingSessionMoves;\n${hostCode}\nglobalThis.host = { requestSessionMove, moveSessionWhenIdle, continueMovedSession }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

  const piBin = join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js')
  const events = []
  const makeRegistry = (hooks = {}) => {
    const created = []
    const registry = new RunnerRegistry({
      limit: 3,
      createAgent: (id, cwd, generation) => {
        const agent = new AgentController({ cwd, piBin, push: event => events.push({ id, ...event }) })
        agent.maybeGenerateTitle = async () => null
        agent.setRunnerGeneration?.(generation)
        created.push({ id, cwd, agent })
        liveAgents.push(agent)
        return agent
      },
      onChanged: () => {}
    })
    const context = {
      runners: registry,
      shuttingDown: false,
      sameRuntimeEnvelope,
      movedSessionContinuationPrompt,
      resolve, isAbsolute,
      validateCwd: async cwd => ({ ok: true, cwd }),
      approvals: { ask: async () => { await hooks.approval?.(context); return { choice: hooks.choice ?? 'once' } } },
      getSettings: async () => ({ projects: [{ id: 'p-b', name: 'b', cwd: targetDir }], recentCwds: [] }),
      patchSettings: async patch => { warnings.push('patchSettings 被调用：' + JSON.stringify(patch)); return { projects: [], recentCwds: [] } },
      rewriteSessionCwd,
      moveSessionLayout: async () => {},
      push: event => events.push({ internal: true, ...event }),
      pushRunners: () => {},
      reportMainError: (...args) => warnings.push('reportMainError: ' + args.map(String).join(' ')),
      sessionHost: { rememberRunnerSession: async () => {}, pushRunnerSnapshot: () => {} }
    }
    vm.runInNewContext(transpiled, context)
    return { registry, context, created, jobs: context.moveJobs }
  }

  const openSession = async (registry, cwd, text) => {
    const selected = await registry.select({ cwd, scope: 'global' })
    ok(selected.ok, '真实 pi 实例在 ' + cwd + ' 启动')
    const agent = registry.agentOf(selected.id)
    await waitFor(async () => {
      const state = agent.getState()
      return !!(state?.sessionFile && state?.sessionId) || selected.sessionId
    }, '会话文件落地')
    await agent.send(text)
    await waitFor(() => prompts.length > 0, '回环模型收到首个请求')
    const state = agent.getState()
    return { id: selected.id, agent, sessionFile: state?.sessionFile, sessionId: state?.sessionId }
  }

  {
    const { registry, context, created } = makeRegistry()
    const started = await openSession(registry, srcDir, '第一轮：先看一下这个项目')
    await waitFor(async () => !started.agent.getState()?.isAgentRunning, '首轮结束')
    const beforePrompts = prompts.length
    const answer = await context.host.requestSessionMove({ sessionId: started.sessionId, sessionFile: started.sessionFile, cwd: srcDir, dir: targetDir, reason: '夹具' })
    ok(answer.decision === 'approved', '批准返回，不要求用户再说继续')
    await waitFor(() => events.some(e => e.ch === 'session-moved'), '宿主发出移动结果')
    const moved = events.find(e => e.ch === 'session-moved').payload
    ok(moved.ok && moved.continued, '移动成功并在新目录续接（真实 pi）')
    const raw = await readFile(started.sessionFile, 'utf8')
    ok(JSON.parse(raw.split('\n')[0]).cwd === targetDir, '会话文件头 cwd 已改写为目标目录')
    ok(raw.split('\n').filter(Boolean).length > 1, '改写没有丢掉会话正文')
    await waitFor(() => prompts.length > beforePrompts, '续接提示到达回环模型')
    const continuation = prompts[prompts.length - 1]
    const lastUser = (continuation.messages ?? []).filter(m => m.role === 'user').at(-1)
    const lastText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
    ok(JSON.stringify(continuation).includes('砚宿主通知'), '续接内容来自宿主通知')
    ok(lastText.includes('砚宿主通知'), '最后一条用户消息就是宿主通知')
    ok(!lastText.includes('第一轮：先看一下这个项目'), '宿主通知不是原请求的拷贝')
    const restored = registry.statuses().find(s => s.sessionId === started.sessionId)
    ok(!!restored && restored.cwd === targetDir, '实例在新目录持有同一会话')
    ok(restored.runId !== started.id, '续接用的是新实例（原实例已关闭）')
    const restartedAgent = registry.agentOf(restored.runId)
    await waitFor(async () => !restartedAgent.getState()?.isAgentRunning, '续接回合结束')
    await registry.stopAll()
    ok(true, 'A 段收尾：实例全部关闭')
  }

  {
    const { registry, context, created } = makeRegistry({ approval: ctx => { const live = ctx.runners.statuses()[0]; const agent = live && ctx.runners.agentOf(live.runId); if (agent) agent.loopGuardContinuationVersion += 1 } })
    const started = await openSession(registry, srcDir, '第二轮：先说个计划')
    await waitFor(async () => !started.agent.getState()?.isAgentRunning, '第二轮结束')
    const beforePrompts = prompts.length
    const answer = await context.host.requestSessionMove({ sessionId: started.sessionId, sessionFile: started.sessionFile, cwd: srcDir, dir: targetDir, reason: '夹具' })
    ok(answer.decision === 'approved', '人工停止场景同样先批准')
    await waitFor(() => events.some(e => e.ch === 'session-moved' && e.payload.sessionFile === started.sessionFile), '宿主发出移动结果')
    const moved = events.filter(e => e.ch === 'session-moved').at(-1).payload
    ok(moved.ok && !moved.continued, '人工停止时只移动、不自动续接')
    ok(prompts.length === beforePrompts, '人工停止后没有向模型发出任何续接请求')
    await registry.stopAll()
    ok(true, 'B 段收尾：实例全部关闭')
  }

  console.log(`session-move-continuation-live: ${checks} assertions passed（真实随包 pi + 回环模型 + Node 宿主，不调外部模型）`)
  if (warnings.length) console.log('提示：' + warnings.join(' | '))
} finally {
  for (const agent of liveAgents) await agent.stop().catch(() => undefined)
  model.close()
  await cleanupOut()
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
