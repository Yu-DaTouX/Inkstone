/** Execute production IPC handlers with isolated ports: no models or user files. */
import assert from 'node:assert/strict'
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'

const source = await readFile('src/main/index.ts', 'utf8')
const temp = await mkdtemp(join(tmpdir(), 'inkstone-hotpaths-'))
const previous = process.env.YAN_DATA_DIR
process.env.YAN_DATA_DIR = temp
let checks = 0
const check = (condition, label) => { assert(condition, label); checks++ }
try {
  const compileHandler = async (name, end, ports) => {
    const start = source.indexOf(`  handle('yan:${name}',`)
    assert(start >= 0)
    const text = source.slice(start, source.indexOf(end, start))
    const { transform } = await import('esbuild')
    const js = await transform(text, { loader: 'ts', target: 'es2022' })
    let callback
    vm.runInNewContext(js.code, { ...ports, handle: (_channel, handler) => { callback = handler } })
    return callback
  }
  let sent, captured = 0, aborted = 0
  const agent = { running: true, getState: () => ({ sessionId: 'session-a' }), workingDirectory: temp,
    send: (...args) => { sent = args; return { ok: true } }, abort: async () => { aborted++; return { steering: ['queued'], followUp: [] } } }
  const ports = { runners: { activeRunnerId: 'a', agentOf: id => id === 'a' ? agent : undefined }, handoffPending: new Map(),
    getSettings: async () => ({ checkpointsEnabled: true }), captureCheckpoint: async () => { captured++ }, ac: () => agent,
    startAgent: async () => { throw Error('unexpected restart') }, abandonHandoff: async () => {} }
  const send = await compileHandler('send', "  handle('yan:steer'", ports)
  check((await send('normal message')).ok && sent[0] === 'normal message', '普通发送无需旧目标/模式存储即可到达当前实例')
  check(captured === 1, '普通发送保留检查点')
  await send('steer message', undefined, 'steer')
  check(captured === 1 && sent[2] === 'steer', '插话不创建检查点且保留发送模式')
  agent.getState = () => ({ sessionId: 'session-a', isAgentRunning: true })
  await send('queued message')
  check(captured === 1, '忙碌会话发送保持队列语义')
  const abort = await compileHandler('abort', '  /*\n   * 放弃目标', ports)
  const cleared = await abort()
  check(aborted === 1 && cleared.steering[0] === 'queued', '停止直接终止当前实例，并返回排队文本')
  check((await readdir(temp)).length === 0, '发送与停止不会创建任何旧模式/目标文件')
  const bundle = async (file, name) => {
    const out = join(temp, name + '.mjs')
    await build({ entryPoints: [resolve(file)], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'isolated-electron', setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getPath:()=>${JSON.stringify(temp)},getLocale:()=> 'zh-CN'};` }))
      } }] })
    return import(pathToFileURL(out).href)
  }
  const coordinator = await bundle('src/main/goal-coordinator.ts', 'coordinator')
  const messages = []
  coordinator.configureGoalCoordinator({ pushFrom: (id, msg) => messages.push({ id, ...msg }) })
  coordinator.goals.load = async () => { throw Error('ordinary compatibility push must not load goals') }
  await coordinator.pushWorkMode('a'); await coordinator.pushAgentProfile('b')
  check(messages[0].id === 'a' && messages[0].payload.mode === 'standard', '模式兼容推送保持运行身份且不读目标')
  check(messages[1].id === 'b' && messages[1].payload.activity === 'answer', '档案兼容推送保持运行身份且不生成快照')
  check(!(await readdir(temp)).some(name => ['work-mode', 'agent-profile', 'goals.json'].includes(name)), '兼容推送不生成旧领域文件')
  const catalog = await bundle('src/main/capabilities/catalog.ts', 'catalog')
  const built = catalog.buildCatalog([])
  check(!built.capabilities.some(c => /^builtin:(goal|knowledge|follow|research)\./.test(c.id)), '默认模型目录不再推荐已退出的领域流程')
  check(built.capabilities.some(c => c.id === 'builtin:subagent.start' && c.source.location.includes('--model')), '保留指定模型子任务的可执行指引')
  console.log(`PASS: light hotpaths ${checks} checks; no inference`)
} finally {
  if (previous === undefined) delete process.env.YAN_DATA_DIR; else process.env.YAN_DATA_DIR = previous
  await rm(temp, { recursive: true, force: true })
}
