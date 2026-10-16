import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createFakeManagerFactory, createFakeAgent } from './fixtures/mcp-app-runtime-ownership-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-runtime-ownership-'))
const piAgentDir = join(root, 'pi-agent')
const yanDir = join(root, 'yan')
const hostConfigFile = join(yanDir, 'mcp-servers.json')
const trustedProject = join(root, 'trusted')
const runnerCwd = join(root, 'runner')
const runnerCwd2 = join(root, 'runner-2')
const piGlobalFile = join(piAgentDir, 'mcp.json')
const trustedPiFile = join(trustedProject, '.pi', 'mcp.json')
const runnerPiFile = join(runnerCwd, '.pi', 'mcp.json')
const runnerPiFile2 = join(runnerCwd2, '.pi', 'mcp.json')

process.env.YAN_DATA_DIR = yanDir
process.env.YAN_MCP_SERVERS_FILE = hostConfigFile

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail !== undefined ? `（${detail}）` : ''}`)
  checks++
  console.log(`✓ ${message}`)
}
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
  console.log(`✓ ${message}`)
}
const rejects = async (work, code, message) => {
  let thrown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  ok(Boolean(thrown) && thrown.code === code, message, thrown ? `${thrown.code}: ${thrown.message}` : '没有抛错')
}
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const bundleDir = join(process.cwd(), 'out', 'test', `mcp-runtime-ownership-${process.pid}`)
await mkdir(bundleDir, { recursive: true })
const outfile = join(bundleDir, 'bundle.mjs')
await build({
  stdin: {
    contents:
      "export * from './src/main/mcp/app-native-witness';" +
      "export * from './src/main/mcp/app-runtime-ownership';" +
      "export * from './src/main/mcp/app-ownership-guard';" +
      "export * from './src/main/mcp/app-host';" +
      "export * from './src/main/runners';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  logLevel: 'silent'
})
const m = await import(pathToFileURL(outfile).href)

const env = { YAN_MCP_SERVERS_FILE: hostConfigFile }
const APP_HOST_MARK = (name, path) => ({
  at: '2026-10-16T00:00:00.000Z',
  natives: [{ path, name, entry: { command: 'saved' }, fingerprint: `fp-${name}` }]
})

async function resetHost(servers) {
  await writeJson(hostConfigFile, { servers })
}
async function resetNative({ globalServers = {}, trustedServers = {}, runnerServers = {}, runner2Servers = {} } = {}) {
  await mkdir(piAgentDir, { recursive: true })
  await writeJson(piGlobalFile, { mcpServers: globalServers })
  await writeJson(trustedPiFile, { mcpServers: trustedServers })
  await writeJson(runnerPiFile, { mcpServers: runnerServers })
  await writeJson(runnerPiFile2, { mcpServers: runner2Servers })
}

const sessionSeq = { value: 0 }
function newRegistry() {
  const agents = new Map()
  const registry = new m.RunnerRegistry({
    limit: 5,
    createAgent: (id, cwd, generation) => {
      const agent = createFakeAgent({ cwd, generation, sessionSeq })
      agents.set(id, agent)
      return agent
    }
  })
  return { registry, agents }
}
async function addRunner(registry, agents, { cwd, projectId = null, live = true, conn = 'ready' }) {
  const result = await registry.select({ cwd, hidden: true, activate: false })
  ok(result.ok, `夹具：创建 runner（${cwd}）`, result.error)
  const agent = agents.get(result.id)
  agent.setProjectId(projectId)
  agent.setRuntime(live, conn)
  return { id: result.id, agent, generation: result.generation }
}
async function captureWitness(agent, { cwd, generation, projectId = null }) {
  const captured = await m.captureNativeStartupWitness({
    agentDir: piAgentDir,
    cwd,
    bootId: m.newBootId(),
    generation,
    projectId
  })
  ok(captured.ok, '夹具：采集启动见证成功', captured.reason)
  agent.setWitness(captured.witness)
  return captured.witness
}

const state = { registry: null }
function makeFacts({ projects = () => [{ id: 'trusted', cwd: trustedProject }], readNativeConfig } = {}) {
  return m.createMcpAppRuntimeOwnershipFacts({
    registry: () => state.registry,
    agentDir: piAgentDir,
    projects,
    ...(readNativeConfig ? { readNativeConfig } : {})
  })
}
function newAppHost(overrides = {}) {
  const fake = overrides.fake ?? createFakeManagerFactory()
  return {
    fake,
    host: new m.McpAppHost({
      env,
      ownership: overrides.facts ?? makeFacts(),
      createManager: fake.createManager,
      timeoutMs: 5_000
    })
  }
}

{
  const exited = { processRunning: false, conn: 'exited' }
  ok(!m.mayHoldMcpApp(exited, { serverId: 'x', scope: 'global' }), 'A1 进程未跑且 conn=exited：确定不持有')
  ok(
    m.mayHoldMcpApp({ processRunning: false, conn: 'error' }, { serverId: 'x', scope: 'global' }),
    'A2 进程未跑但 conn=error（starting/error 假矛盾）：按可能持有'
  )
  ok(
    m.mayHoldMcpApp({ processRunning: false, conn: 'starting' }, { serverId: 'x', scope: 'global' }),
    'A3 进程未跑但 conn=starting：按可能持有'
  )
  ok(
    m.mayHoldMcpApp({ processRunning: true, conn: 'exited' }, { serverId: 'x', scope: 'global' }),
    'A4 进程仍跑但 conn=exited 矛盾：按可能持有'
  )
  ok(
    m.mayHoldMcpApp({ processRunning: true, conn: 'ready', projectId: null }, { serverId: 'x', scope: 'project', projectId: 'p1' }),
    'A5 项目服务下未绑定 project：按可能持有'
  )
  ok(
    !m.mayHoldMcpApp({ processRunning: true, conn: 'ready', projectId: 'p2' }, { serverId: 'x', scope: 'project', projectId: 'p1' }),
    'A6 项目服务下已知其它项目：不算持有'
  )

  const base = {
    bootId: 'boot-1',
    generation: 7,
    cwd: runnerCwd,
    projectId: null,
    capturedAt: '2026-10-16T00:00:00.000Z',
    sources: [],
    servers: ['alpha', 'alpha-alias']
  }
  const snapshot = { generation: 7, cwd: runnerCwd, processRunning: true, conn: 'ready' }
  const names = new Set(['alpha', 'alpha-alias'])
  ok(
    !m.witnessProvesAbsent({ witness: base, snapshot, names }).proven,
    'A7 启动集合仍含目标 id / 别名：不证明无持有'
  )
  ok(
    m.witnessProvesAbsent({ witness: { ...base, servers: [] }, snapshot, names }).proven,
    'A8 启动集合无目标：证明启动时未加载'
  )
  ok(
    !m.witnessProvesAbsent({ witness: { ...base, servers: [] }, snapshot: { ...snapshot, conn: 'starting' }, names }).proven,
    'A9 conn 不是 ready：不证明'
  )
  ok(
    !m.witnessProvesAbsent({ witness: { ...base, servers: [] }, snapshot: { ...snapshot, processRunning: false }, names }).proven,
    'A10 进程未确认存活：不证明'
  )
  ok(
    !m.witnessProvesAbsent({ witness: { ...base, servers: [] }, snapshot: { ...snapshot, generation: 8 }, names }).proven,
    'A11 过期 generation：不证明'
  )
  ok(
    !m.witnessProvesAbsent({ witness: { ...base, servers: [] }, snapshot: { ...snapshot, cwd: runnerCwd2 }, names }).proven,
    'A12 cwd 不符：不证明'
  )
  ok(
    !m.witnessProvesAbsent({ witness: { ...base, bootId: '', servers: [] }, snapshot, names }).proven,
    'A13 缺 bootId：不证明'
  )
  ok(
    !m.witnessProvesAbsent({ witness: null, snapshot, names }).proven,
    'A14 没有见证（热重载未知）：不证明'
  )
  ok(
    !m.witnessProvesAbsent({
      witness: { ...base, servers: [], cwd: runnerCwd },
      snapshot,
      names,
      projectCwd: trustedProject
    }).proven,
    'A15 项目服务：见证目录不是服务项目目录：不证明'
  )
}

{
  await resetNative({ globalServers: { globalSrv: { command: 'x' } }, runnerServers: { localSrv: { command: 'y' } } })
  const captured = await m.captureNativeStartupWitness({
    agentDir: piAgentDir,
    cwd: runnerCwd,
    bootId: m.newBootId(),
    generation: 3
  })
  eq(captured.ok, true, 'B1 稳定文件可签发见证')
  eq(captured.witness.servers, ['globalSrv', 'localSrv'], 'B2 见证并集包含全局与本 cwd 项目 serverId')
  ok(
    captured.witness.sources.every((source) => !('env' in source) && typeof source.hash === 'string'),
    'B3 见证只含路径 / hash / serverId，不含凭据'
  )
  eq((await m.verifyNativeStartupWitness(captured.witness)).ok, true, 'B4 未变化时复核通过')

  await writeJson(runnerPiFile, { mcpServers: { localSrv: { command: 'changed' } } })
  eq((await m.verifyNativeStartupWitness(captured.witness)).ok, false, 'B5 启动后文件变化：复核失败')
  await writeJson(runnerPiFile, { mcpServers: { localSrv: { command: 'y' } } })

  await writeFile(piGlobalFile, '{ not json', 'utf8')
  eq((await m.verifyNativeStartupWitness(captured.witness)).ok, false, 'B6 坏 JSON：复核失败')
  await writeJson(piGlobalFile, { mcpServers: { globalSrv: { command: 'x' } } })

  const readFail = await m.captureNativeStartupWitness({
    agentDir: piAgentDir,
    cwd: runnerCwd,
    bootId: m.newBootId(),
    generation: 3,
    readNativeConfig: async (path) => {
      if (path === piGlobalFile) throw new Error('boom')
      return null
    }
  })
  eq(readFail.ok, false, 'B7 读失败：不签发见证')

  const noAgentDir = await m.captureNativeStartupWitness({ agentDir: '', cwd: runnerCwd, bootId: 'x', generation: 1 })
  eq(noAgentDir.ok, false, 'B8 缺 agentDir：不签发见证')

  await rm(runnerPiFile, { force: true })
  const absent = await m.captureNativeStartupWitness({ agentDir: piAgentDir, cwd: runnerCwd, bootId: m.newBootId(), generation: 1 })
  eq(absent.ok, true, 'B9 项目文件不存在也算已采集（present:false）')
  await writeJson(runnerPiFile, { mcpServers: {} })
  eq((await m.verifyNativeStartupWitness(absent.witness)).ok, false, 'B10 启动后新增文件：复核失败')
}

try {
  await resetHost([{ id: 'alpha', transport: 'stdio', command: 'node', ownedBy: 'inkstone', appHost: APP_HOST_MARK('alpha', piGlobalFile) }])
  await resetNative()
  const { registry, agents } = newRegistry()
  state.registry = registry
  const runner = await addRunner(registry, agents, { cwd: runnerCwd, projectId: null })
  await captureWitness(runner.agent, { cwd: runnerCwd, generation: runner.generation })
  ok(registry.mcpHolderSnapshots()[0].nativeWitness !== null, 'A7-1a 窄快照带上启动见证引用')

  const { host, fake } = newAppHost()
  const tools = await host.listToolsWithMeta('alpha')
  eq(tools.length, 1, 'A7-1b 新 pi 启动时无该 server：FIX3 真实守卫放行连接')
  eq(fake.forServer('alpha').length, 1, 'A7-1c 真实创建了一条连接（fake manager）')
  eq(host.statusOf('alpha').status, 'ready', 'A7-1d 连接状态 ready')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
  state.registry = null
}

try {
  await resetHost([{ id: 'alpha', transport: 'stdio', command: 'node', ownedBy: 'inkstone', appHost: APP_HOST_MARK('alpha', piGlobalFile) }])
  await resetNative({ runnerServers: { alpha: { command: 'native' } } })
  const { registry, agents } = newRegistry()
  state.registry = registry
  const runner = await addRunner(registry, agents, { cwd: runnerCwd, projectId: null })
  await captureWitness(runner.agent, { cwd: runnerCwd, generation: runner.generation })
  ok(runner.agent.running === true, 'A7-2a hidden runner 存活')
  ok(!registry.statuses().some((item) => item.id === runner.id), 'A7-2b hidden runner 不在 statuses()（走内部窄快照）')
  ok(registry.mcpHolderSnapshots().some((item) => item.runnerId === runner.id), 'A7-2c 内部窄快照包含 hidden runner')

  const { host, fake } = newAppHost()
  await rejects(() => host.listToolsWithMeta('alpha'), 'runtime-holders-active', 'A7-2d 启动时加载过该 server：阻断连接')
  eq(fake.forServer('alpha').length, 0, 'A7-2e 阻断时没有建立连接')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
  state.registry = null
}

try {
  await resetHost([{
    id: 'alpha',
    transport: 'stdio',
    command: 'node',
    ownedBy: 'inkstone',
    appHost: { at: '2999-01-01T00:00:00.000Z', natives: [{ path: piGlobalFile, name: 'alpha', entry: {}, fingerprint: 'fp' }] }
  }])
  await resetNative()
  const { registry, agents } = newRegistry()
  state.registry = registry
  await addRunner(registry, agents, { cwd: runnerCwd, projectId: null })

  const facts = makeFacts()
  const holders = await (await facts()).holdersFor({ serverId: 'alpha', scope: 'global', managedAt: '2999-01-01T00:00:00.000Z' })
  ok(holders.length === 1, 'A7-3a managedAt / appHost.at 再新也不排除无见证 runner')
  const { host } = newAppHost({ facts })
  await rejects(() => host.listToolsWithMeta('alpha'), 'runtime-holders-active', 'A7-3b 假时间戳不能放行连接')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
  state.registry = null
}

try {
  await resetHost([{ id: 'alpha', transport: 'stdio', command: 'node', ownedBy: 'inkstone', appHost: APP_HOST_MARK('alpha', piGlobalFile) }])
  await resetNative()
  const { registry, agents } = newRegistry()
  state.registry = registry
  const runner = await addRunner(registry, agents, { cwd: runnerCwd, projectId: null })
  await captureWitness(runner.agent, { cwd: runnerCwd, generation: runner.generation })

  await writeJson(runnerPiFile, { mcpServers: { unrelated: { command: 'z' } } })
  const afterChange = newAppHost()
  await rejects(() => afterChange.host.listToolsWithMeta('alpha'), 'runtime-holders-active', 'A7-4a 启动后文件变化：阻断')
  await resetNative()

  await writeFile(runnerPiFile, '{ bad json', 'utf8')
  const afterBad = newAppHost()
  await rejects(() => afterBad.host.listToolsWithMeta('alpha'), 'runtime-holders-active', 'A7-4b 原生配置坏 JSON：阻断')
  await resetNative()

  const poisoned = async (path) => {
    if (path === runnerPiFile) throw new Error('injected read failure')
    return m.defaultNativeConfigReader(path)
  }
  const afterReadFail = newAppHost({ facts: makeFacts({ readNativeConfig: poisoned }) })
  await rejects(() => afterReadFail.host.listToolsWithMeta('alpha'), 'runtime-holders-active', 'A7-4c 读取原生配置失败：阻断')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
  state.registry = null
}

try {
  await resetHost([{
    id: 'gamma',
    transport: 'stdio',
    command: 'node',
    projectScope: 'trusted',
    ownedBy: 'inkstone',
    appHost: APP_HOST_MARK('gamma', trustedPiFile)
  }])
  await resetNative()
  const { registry, agents } = newRegistry()
  state.registry = registry
  const unbound = await addRunner(registry, agents, { cwd: runnerCwd, projectId: null })
  await captureWitness(unbound.agent, { cwd: runnerCwd, generation: unbound.generation, projectId: null })
  const u = newAppHost()
  await rejects(() => u.host.listToolsWithMeta('gamma', { projectId: 'trusted' }), 'runtime-holders-active', 'A7-5a 同 cwd 未绑定 project：阻断')

  await registry.stopAll()
  const { registry: r2, agents: a2 } = newRegistry()
  state.registry = r2
  const bound = await addRunner(r2, a2, { cwd: trustedProject, projectId: 'trusted' })
  await captureWitness(bound.agent, { cwd: trustedProject, generation: bound.generation, projectId: 'trusted' })
  const b = newAppHost()
  const tools = await b.host.listToolsWithMeta('gamma', { projectId: 'trusted' })
  eq(tools.length, 1, 'A7-5b 同项目 + 见证证明未加载：放行连接')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
  state.registry = null
}

try {
  await resetHost([
    { id: 'alpha', transport: 'stdio', command: 'node', ownedBy: 'inkstone', appHost: APP_HOST_MARK('alpha', piGlobalFile) },
    { id: 'beta', transport: 'stdio', command: 'node', ownedBy: 'inkstone', appHost: APP_HOST_MARK('beta', piGlobalFile) }
  ])
  await resetNative({ runner2Servers: { beta: { command: 'native' } } })
  const { registry, agents } = newRegistry()
  state.registry = registry
  const clean = await addRunner(registry, agents, { cwd: runnerCwd, projectId: null })
  await captureWitness(clean.agent, { cwd: runnerCwd, generation: clean.generation })
  const dirty = await addRunner(registry, agents, { cwd: runnerCwd2, projectId: null })
  await captureWitness(dirty.agent, { cwd: runnerCwd2, generation: dirty.generation })

  const { host, fake } = newAppHost()
  await host.listToolsWithMeta('alpha')
  const alphaRecord = fake.forServer('alpha').at(-1)
  const closesBefore = alphaRecord.closes
  await rejects(() => host.listToolsWithMeta('beta'), 'runtime-holders-active', 'A7-6a beta 被旧 runner 持有：阻断')
  eq(alphaRecord.closes, closesBefore, 'A7-6b 阻断 beta 没有关闭 alpha 的健康连接')
  eq(host.statusOf('alpha').status, 'ready', 'A7-6c alpha 连接仍然 ready')

  let release
  alphaRecord.gate = new Promise((resolve) => {
    release = resolve
  })
  const connectsBefore = alphaRecord.connects
  const pending = host.callToolWithMeta('alpha', 'tool', {})
  const deadline = Date.now() + 2_000
  while (alphaRecord.connects === connectsBefore && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  ok(alphaRecord.connects > connectsBefore, 'A7-6d0 底层调用已开始（归属检查已通过）')
  dirty.agent.setWitness(null)
  release()
  await rejects(() => pending, 'ownership-changed', 'A7-6d 归属在调用期间变化：迟到结果被丢弃')
  eq(host.statusOf('alpha').status, 'disconnected', 'A7-6e 归属变化后该服务连接已关闭')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
  state.registry = null
}

{
  await resetHost([{ id: 'alpha', transport: 'stdio', command: 'node', ownedBy: 'inkstone', appHost: APP_HOST_MARK('alpha', piGlobalFile) }])
  await resetNative()

  state.registry = null
  const noRegistry = newAppHost()
  await rejects(() => noRegistry.host.listToolsWithMeta('alpha'), 'runtime-unknown', 'A7-7a 注册表缺失：runtime-unknown')

  const { registry } = newRegistry()
  state.registry = registry
  const badProjects = newAppHost({ facts: makeFacts({ projects: async () => { throw new Error('settings down') } }) })
  await rejects(() => badProjects.host.listToolsWithMeta('alpha'), 'runtime-unknown', 'A7-7b 设置 / 项目登记异常：runtime-unknown')

  const brokenRegistry = { mcpHolderSnapshots() { throw new Error('snapshot boom') } }
  state.registry = brokenRegistry
  const brokenFacts = makeFacts()
  let thrown
  try {
    await (await brokenFacts()).holdersFor({ serverId: 'alpha', scope: 'global' })
  } catch (error) {
    thrown = error
  }
  ok(Boolean(thrown), 'A7-7c 快照异常时 holdersFor 抛错')
  const broken = newAppHost({ facts: brokenFacts })
  await rejects(() => broken.host.listToolsWithMeta('alpha'), 'runtime-unknown', 'A7-7d 快照异常：runtime-unknown（不是空数组放行）')
  state.registry = null
}

console.log(`\n全部通过：${checks} 项断言（fake manager / fake agent / 真实 RunnerRegistry / 真实临时原生配置）`)
