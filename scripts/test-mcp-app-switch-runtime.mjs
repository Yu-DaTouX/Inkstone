import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-app-switch-runtime-'))
const agentDir = join(root, 'pi-agent')
const dataDir = join(root, 'yan')
const hostConfigFile = join(dataDir, 'mcp-servers.json')
const projectCwd = join(root, 'project')
const otherCwd = join(root, 'other')
const nativeGlobal = join(agentDir, 'mcp.json')
const nativeProject = join(projectCwd, '.pi', 'mcp.json')
const missingPi = join(root, 'no-such-pi')

process.env.YAN_PI_DIR = agentDir
process.env.YAN_DATA_DIR = dataDir
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

const outfile = join(root, 'bundle.mjs')
await build({
  stdin: {
    contents:
      "export { RunnerRegistry } from './src/main/runners';" +
      "export { registerMcpAppIpc, mcpAppHoldersFor, mayHoldMcpApp } from './src/main/ipc/mcp-app-ipc';" +
      "export { captureNativeStartupWitness } from './src/main/mcp/app-native-witness';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning'
})
const m = await import(pathToFileURL(outfile).href)

const HOST_GLOBAL = {
  servers: [
    {
      id: 'weather',
      title: '天气',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'secret' }
    }
  ]
}
const HOST_PROJECT = {
  servers: [{ id: 'weather', title: '天气', transport: 'stdio', command: 'node', projectScope: 'p1' }]
}
const NATIVE_GLOBAL = { mcpServers: { weather: { command: 'node', args: ['server.js'], env: { API_KEY: 'secret' } } } }
const NATIVE_PROJECT = { mcpServers: { weather: { command: 'node', args: ['server.js'] } } }

const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

async function resetFiles({ project = false } = {}) {
  await mkdir(agentDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeJson(hostConfigFile, project ? HOST_PROJECT : HOST_GLOBAL)
  if (project) {
    await writeJson(nativeProject, NATIVE_PROJECT)
    await writeJson(nativeGlobal, { mcpServers: {} })
  } else {
    await writeJson(nativeGlobal, NATIVE_GLOBAL)
    await rm(nativeProject, { force: true }).catch(() => undefined)
  }
}

let sessionSeq = 0
function makeFakeAgent({ cwd }) {
  const state = {
    sessionId: `sess-${++sessionSeq}`,
    sessionFile: join(root, `sess-${sessionSeq}.jsonl`),
    cwd,
    isAgentRunning: false,
    isStreaming: false,
    isCompacting: false
  }
  let live = true
  let connection = 'ready'
  let projectId = null
  let legacyMcpServices = []
  const calls = { start: 0, stop: 0, switchSession: 0, newSession: 0, reloadMcpServers: 0 }
  return {
    getState: () => state,
    getConn: () => ({ state: connection, detail: '' }),
    get running() {
      return live
    },
    get capabilityProjectId() {
      return projectId
    },
    setRunnerGeneration() {},
    getLegacyMcpHolderSnapshot: () => ({ services: legacyMcpServices.map((service) => ({ ...service })) }),
    setLegacyMcpServices(next) {
      legacyMcpServices = Array.isArray(next) ? next : []
    },
    hasRunningBash: () => false,
    getPendingUiCount: () => 0,
    hasWrittenThisRun: () => false,
    async start() {
      calls.start++
      live = true
      connection = 'ready'
      return { ok: true }
    },
    async stop() {
      calls.stop++
      live = false
      connection = 'exited'
      return undefined
    },
    async switchSession() {
      calls.switchSession++
      return { ok: true }
    },
    async newSession() {
      calls.newSession++
      return { ok: true }
    },
    async reloadMcpServers() {
      calls.reloadMcpServers++
      return undefined
    },
    calls,
    setRuntime(nextLive, nextConn) {
      live = nextLive
      connection = nextConn
    },
    setProjectId(next) {
      projectId = next
    }
  }
}

function newRegistry() {
  const agents = new Map()
  const registry = new m.RunnerRegistry({
    limit: 5,
    createAgent: (id, cwd) => {
      const agent = makeFakeAgent({ cwd })
      agents.set(id, agent)
      return agent
    }
  })
  return { registry, agents }
}

const callTotals = (agents) => {
  const total = { start: 0, stop: 0, switchSession: 0, newSession: 0, reloadMcpServers: 0 }
  for (const agent of agents.values()) {
    for (const key of Object.keys(total)) total[key] += agent.calls[key]
  }
  return total
}

const state = { registry: null, agents: new Map() }
const deps = {
  currentAgent: () => state.registry?.active() ?? undefined,
  registry: () => state.registry,
  settings: async () => ({ projects: [{ id: 'p1', cwd: projectCwd }], piBin: missingPi }),
  isProjectTrusted: async () => true
}
const handlers = new Map()
m.registerMcpAppIpc(
  { handle: (channel, fn) => handlers.set(channel, fn), rawHandle: (channel, fn) => handlers.set(channel, fn) },
  deps
)
const call = (channel, ...args) => handlers.get(channel)(...args)

function useRegistry(registry, agents) {
  state.registry = registry
  state.agents = agents
}

async function selectActive(registry, { cwd = projectCwd, projectId = null, live = true, conn = 'ready' } = {}) {
  const result = await registry.select({ cwd, activate: true })
  ok(result.ok, '测试夹具：创建 active runner 成功', result.error)
  const agent = registry.active()
  agent.setProjectId(projectId)
  agent.setRuntime(live, conn)
  return { id: result.id, agent }
}

async function addHidden(registry, agents, { cwd = otherCwd, projectId = null, live = true, conn = 'ready' } = {}) {
  const result = await registry.select({ cwd, hidden: true, activate: false })
  ok(result.ok, '测试夹具：创建 hidden runner 成功', result.error)
  const agent = agents.get(result.id)
  agent.setProjectId(projectId)
  agent.setRuntime(live, conn)
  return { id: result.id, agent }
}

async function assertSingleOwner(name, expected) {
  const host = await readJson(hostConfigFile)
  const server = host.servers.find((entry) => entry.id === 'weather')
  const managed = server.ownedBy === 'inkstone' && Boolean(server.appHost)
  const hasNative = async (path) => {
    try {
      const text = await readFile(path, 'utf8')
      return Object.prototype.hasOwnProperty.call(JSON.parse(text).mcpServers ?? {}, 'weather')
    } catch {
      return false
    }
  }
  const native = (await hasNative(nativeGlobal)) || (await hasNative(nativeProject))
  const count = (managed ? 1 : 0) + (native ? 1 : 0)
  ok(count === 1, `${name}: 恰有一个 owner`, `managed=${managed} native=${native} count=${count}`)
  ok(
    (expected === 'inkstone') === managed && (expected === 'pi') === native,
    `${name}: owner 方向符合预期（${expected}）`
  )
}

{
  const exited = { processRunning: false, conn: 'exited' }
  const alive = { processRunning: true, conn: 'ready' }
  ok(!m.mayHoldMcpApp(exited, { serverId: 'weather', scope: 'global' }), '已退出实例不算持有（global）')
  ok(m.mayHoldMcpApp(alive, { serverId: 'weather', scope: 'global' }), '存活实例对 global 算可能持有')
  ok(
    m.mayHoldMcpApp({ ...alive, projectId: null }, { serverId: 'weather', scope: 'project', projectId: 'p1' }),
    '项目服务下未绑定 project 的实例按可能持有'
  )
  ok(
    m.mayHoldMcpApp({ ...alive, projectId: 'p1' }, { serverId: 'weather', scope: 'project', projectId: 'p1' }),
    '项目服务下同项目实例算持有'
  )
  ok(
    !m.mayHoldMcpApp({ ...alive, projectId: 'p2' }, { serverId: 'weather', scope: 'project', projectId: 'p1' }),
    '项目服务下已知其它项目实例不算持有'
  )
}

try {
  await resetFiles()
  const { registry, agents } = newRegistry()
  useRegistry(registry, agents)
  const active = await selectActive(registry, { projectId: null, live: false, conn: 'exited' })
  ok(active.id === 'r1', 'active runner id 稳定')

  const preview1 = await call('yan:mcpApp:prepareSwitch', 'weather')
  ok(preview1.ok && preview1.preview.blocked === false, '仅一个已退出实例时预览不阻断')

  const hidden = await addHidden(registry, agents, { cwd: otherCwd, projectId: null, live: true, conn: 'ready' })
  ok(hidden.agent && hidden.agent.running === true, 'hidden runner 确实存活')
  const statuses = registry.statuses()
  ok(!statuses.some((item) => item.id === hidden.id), 'hidden 实例不在 statuses() 里（证明没有用 statuses）')
  const snapshotIds = registry.mcpHolderSnapshots().map((item) => item.runnerId)
  ok(snapshotIds.includes(hidden.id), '内部窄快照包含 hidden 实例')
  const holders = await m.mcpAppHoldersFor(registry, { serverId: 'weather', scope: 'global' })
  ok(holders.some((item) => item.runnerId === hidden.id), 'mcpAppHoldersFor 返回 hidden 持有者')

  const commit1 = await call('yan:mcpApp:commitSwitch', preview1.preview.token)
  ok(commit1.ok === true && commit1.result.ok === false, 'hidden 实例使提交被拒')
  ok(commit1.result.steps.native === 'skipped', 'hidden 阻断时未写盘')
  ok(commit1.result.notice.includes('运行实例'), '拒绝原因说明是运行实例', commit1.result.notice)
  await assertSingleOwner('hidden 阻断后', 'pi')

  await registry.stopByCwd(otherCwd)
  const beforeCommit2 = callTotals(agents)
  const preview2 = await call('yan:mcpApp:prepareSwitch', 'weather')
  ok(preview2.ok && preview2.preview.blocked === false, '移除 hidden 后预览不阻断')
  const commit2 = await call('yan:mcpApp:commitSwitch', preview2.preview.token)
  ok(commit2.ok === true && commit2.result.ok === true, '无存活实例时切换成功', commit2.result?.notice)
  const afterCommit2 = callTotals(agents)
  eq(
    {
      start: afterCommit2.start - beforeCommit2.start,
      stop: afterCommit2.stop - beforeCommit2.stop,
      switchSession: afterCommit2.switchSession - beforeCommit2.switchSession,
      newSession: afterCommit2.newSession - beforeCommit2.newSession,
      reloadMcpServers: afterCommit2.reloadMcpServers - beforeCommit2.reloadMcpServers
    },
    { start: 0, stop: 0, switchSession: 0, newSession: 0, reloadMcpServers: 0 },
    '成功后不自动重启 / 不重载其它 runner（fake agent 调用增量全 0）'
  )
  ok(
    commit2.result.warnings.some((line) => line.includes('新会话') || line.includes('手动重载')),
    '成功后如实提示新会话 / 手动重载后生效'
  )
  await assertSingleOwner('无存活实例切换后', 'inkstone')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
}

try {
  await rejects(
    () => m.mcpAppHoldersFor(null, { serverId: 'weather', scope: 'global' }),
    'holders_unavailable',
    '注册表缺失时 mcpAppHoldersFor 抛 holders_unavailable'
  )
  const broken = {
    mcpHolderSnapshots() {
      throw new Error('registry boom')
    }
  }
  await rejects(
    () => m.mcpAppHoldersFor(broken, { serverId: 'weather', scope: 'global' }),
    'holders_unavailable',
    '快照读取异常时抛 holders_unavailable'
  )

  await resetFiles()
  useRegistry(null, new Map())
  const ownership = await call('yan:mcpApp:ownership')
  ok(ownership.servers.length === 1, '注册表缺失时 ownership 仍返回一个服务视图')
  ok(ownership.servers[0].canSwitch === false, '注册表缺失时该服务不可切换')
  ok(
    String(ownership.servers[0].blockedReason ?? '').includes('fail-closed'),
    '注册表缺失时 blockedReason 明确 fail-closed',
    ownership.servers[0].blockedReason
  )
} finally {
  useRegistry(null, new Map())
}

try {
  await resetFiles({ project: true })
  const { registry, agents } = newRegistry()
  useRegistry(registry, agents)
  await selectActive(registry, { cwd: projectCwd, projectId: 'p1', live: false, conn: 'exited' })
  const unbound = await addHidden(registry, agents, { cwd: projectCwd, projectId: null, live: true, conn: 'ready' })
  ok(unbound.agent.capabilityProjectId === null, 'hidden 实例未绑定 project')

  const holders = await m.mcpAppHoldersFor(registry, { serverId: 'weather', scope: 'project', projectId: 'p1' })
  ok(holders.some((item) => item.runnerId === unbound.id), '同 cwd 未绑定 project 的实例按可能持有返回')

  const preview3 = await call('yan:mcpApp:prepareSwitch', 'weather')
  ok(preview3.ok && preview3.preview.blocked === true, '项目服务下未绑定实例使预览 blocked')
  const before3 = await readFile(hostConfigFile, 'utf8')
  const commit3 = await call('yan:mcpApp:commitSwitch', preview3.preview.token)
  ok(commit3.ok === true && commit3.result.ok === false, '项目服务下未绑定实例使提交被拒')
  ok(commit3.result.steps.native === 'skipped', '项目服务阻断时未写盘')
  eq(await readFile(hostConfigFile, 'utf8'), before3, '项目服务阻断时砚配置未动')
  await assertSingleOwner('项目服务阻断后', 'pi')

  await registry.stopByCwd(projectCwd)
  await selectActive(registry, { cwd: projectCwd, projectId: 'p1', live: false, conn: 'exited' })
  const other = await addHidden(registry, agents, { cwd: otherCwd, projectId: 'p2', live: true, conn: 'ready' })
  const holdersOther = await m.mcpAppHoldersFor(registry, { serverId: 'weather', scope: 'project', projectId: 'p1' })
  ok(!holdersOther.some((item) => item.runnerId === other.id), '已知其它项目的实例不算本项目持有者')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
}

try {
  await resetFiles()
  const { registry, agents } = newRegistry()
  useRegistry(registry, agents)
  await selectActive(registry, { projectId: null, live: false, conn: 'exited' })
  const preview4 = await call('yan:mcpApp:prepareSwitch', 'weather')
  ok(preview4.ok, '预览成功')
  const before4 = { host: await readFile(hostConfigFile, 'utf8'), native: await readFile(nativeGlobal, 'utf8') }

  await registry.select({ cwd: otherCwd, activate: true })
  const commit4 = await call('yan:mcpApp:commitSwitch', preview4.preview.token)
  ok(commit4.ok === false && commit4.code === 'runner_changed', '预览后切换 runner 使提交被拒', commit4.code)
  eq(await readFile(hostConfigFile, 'utf8'), before4.host, '切 runner 后砚配置未动')
  eq(await readFile(nativeGlobal, 'utf8'), before4.native, '切 runner 后 pi 配置未动')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
}

try {
  await resetFiles()
  const { registry, agents } = newRegistry()
  useRegistry(registry, agents)
  const active = await selectActive(registry, { projectId: null, live: false, conn: 'exited' })
  const agent = agents.get(active.id)
  agent.setLegacyMcpServices([{ serverId: 'weather', status: 'ready' }])
  const holders = await m.mcpAppHoldersFor(registry, { serverId: 'weather', scope: 'global' })
  ok(holders.some((item) => item.runnerId === active.id), 'pi exited 但 legacy ready：仍视为持有者')
  const preview5 = await call('yan:mcpApp:prepareSwitch', 'weather')
  ok(preview5.ok && preview5.preview.blocked === true, 'legacy ready 使 to-inkstone 预览 blocked')
  agent.setLegacyMcpServices([{ serverId: 'weather', status: 'connecting' }])
  const holdersConnecting = await m.mcpAppHoldersFor(registry, { serverId: 'weather', scope: 'global' })
  ok(holdersConnecting.some((item) => item.runnerId === active.id), 'legacy connecting（关闭悬挂）：仍视为持有者')
  agent.setLegacyMcpServices([{ serverId: 'weather', status: 'disconnected' }])
  const holdersAfter = await m.mcpAppHoldersFor(registry, { serverId: 'weather', scope: 'global' })
  ok(!holdersAfter.some((item) => item.runnerId === active.id), 'legacy disconnected：不算持有')
  agent.getLegacyMcpHolderSnapshot = () => null
  const holdersUnknown = await m.mcpAppHoldersFor(registry, { serverId: 'weather', scope: 'global' })
  ok(holdersUnknown.some((item) => item.runnerId === active.id), 'legacy 事实缺失（null）：按可能持有')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
}

try {
  await resetFiles({ project: true })
  await rm(join(otherCwd, '.pi', 'mcp.json'), { force: true }).catch(() => undefined)
  const captured = await m.captureNativeStartupWitness({ agentDir, cwd: otherCwd, bootId: 'boot-witness', generation: 1 })
  ok(captured.ok === true, '见证：采集启动见证成功', captured.reason)
  const snapshotOf = (witness) => ({
    mcpHolderSnapshots: () => [
      {
        runnerId: 'r-witness',
        generation: 1,
        projectId: null,
        cwd: otherCwd,
        processRunning: true,
        conn: 'ready',
        busy: false,
        nativeWitness: witness,
        legacyMcpServices: null
      }
    ]
  })
  const proven = await m.mcpAppHoldersFor(snapshotOf(captured.witness), { serverId: 'weather', scope: 'global' })
  ok(proven.length === 0, '见证证明启动时未加载：不算持有者（与宿主路径同一标准）')
  const stillLoaded = await m.mcpAppHoldersFor(snapshotOf({ ...captured.witness, servers: ['weather'] }), {
    serverId: 'weather',
    scope: 'global'
  })
  ok(stillLoaded.length === 1, '启动见证里仍有该服务：仍算持有者')
  await writeJson(nativeGlobal, NATIVE_GLOBAL)
  const fileChanged = await m.mcpAppHoldersFor(snapshotOf(captured.witness), { serverId: 'weather', scope: 'global' })
  ok(fileChanged.length === 1, '见证之后配置又变了：复核失败，仍算持有者')
} finally {
  await state.registry?.stopAll().catch(() => undefined)
}

console.log(`\n全部通过：${checks} 项断言`)
