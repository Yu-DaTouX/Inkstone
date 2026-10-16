import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createFakeManagerFactory } from './fixtures/mcp-app-ownership-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-ownership-'))
const yanDir = join(root, 'yan')
const piAgentDir = join(root, 'pi-agent')
const projectDir = join(root, 'project')
const hostConfigFile = join(yanDir, 'mcp-servers.json')
const piGlobalFile = join(piAgentDir, 'mcp.json')
const projectPiFile = join(projectDir, '.pi', 'mcp.json')
process.env.YAN_DATA_DIR = yanDir
process.env.YAN_MCP_SERVERS_FILE = hostConfigFile

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail !== undefined ? `（${detail}）` : ''}`)
  checks++
  console.log(`✓ ${message}`)
}
const fails = async (work, code, message) => {
  let thrown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  ok(
    Boolean(thrown) && thrown.code === code,
    message,
    thrown ? `${thrown.code}: ${thrown.message}` : '没有抛错'
  )
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

const nativeEntry = { command: 'saved-node', args: ['saved.js'] }
const appHostMark = (name, path) => ({
  at: '2026-10-16T00:00:00.000Z',
  natives: [{ path, name, entry: nativeEntry, fingerprint: `fp-${name}` }]
})
const baseServers = () => [
  { id: 'managed', transport: 'stdio', command: 'node', args: ['x.js'], ownedBy: 'inkstone', appHost: appHostMark('managed', piGlobalFile) },
  {
    id: 'managed-project',
    transport: 'stdio',
    command: 'node',
    args: ['y.js'],
    projectScope: 'proj-1',
    ownedBy: 'inkstone',
    appHost: appHostMark('managed-project', projectPiFile)
  },
  { id: 'native', transport: 'stdio', command: 'node', args: ['z.js'], ownedBy: 'pi' },
  { id: 'disabled-managed', transport: 'stdio', command: 'node', args: ['w.js'], enabled: false, ownedBy: 'inkstone', appHost: appHostMark('disabled-managed', piGlobalFile) }
]

async function writeHostConfig(servers) {
  await mkdir(yanDir, { recursive: true })
  await writeFile(hostConfigFile, JSON.stringify({ unknownTop: { keep: true }, servers }, null, 2), 'utf8')
}
async function writePiDoc(file, doc) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(doc), 'utf8')
}
async function clearPiFiles() {
  await rm(piGlobalFile, { force: true })
  await rm(projectPiFile, { force: true })
}

const bundleDir = join(process.cwd(), 'out', 'test', `mcp-ownership-${process.pid}`)
await mkdir(bundleDir, { recursive: true })
const outfile = join(bundleDir, 'bundle.mjs')
await build({
  stdin: {
    contents:
      "export * from './src/main/mcp/app-spec';" +
      "export * from './src/main/mcp/app-host';" +
      "export * from './src/main/mcp/config';",
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
const host = await import(pathToFileURL(outfile).href)

const fake = createFakeManagerFactory()
const env = { YAN_MCP_SERVERS_FILE: hostConfigFile }
const guard = (overrides = {}) =>
  new host.McpAppOwnershipGuard({
    agentDir: piAgentDir,
    projects: [{ id: 'proj-1', cwd: projectDir }],
    holdersFor: async () => [],
    ...overrides
  })
const newAppHost = (overrides = {}) =>
  new host.McpAppHost({
    env,
    ownership: guard(overrides.ownership),
    createManager: fake.createManager,
    timeoutMs: 5_000
  })

try {
  await writeHostConfig(baseServers())
  await clearPiFiles()

  {
    const bare = new host.McpAppHost({ env })
    await fails(() => bare.listToolsWithMeta('managed'), 'path-scope-unknown', '默认未注入：路径范围不明，拒绝连接')

    const noRunner = new host.McpAppHost({
      env,
      ownership: { agentDir: piAgentDir, projects: [], readNativeConfig: async () => null }
    })
    await fails(() => noRunner.listToolsWithMeta('managed'), 'runtime-unknown', '未提供 runner 持有情况：拒绝连接（不默认无旧 runner）')
  }

  const appHost = newAppHost()
  {
    const [a, b] = await Promise.all([appHost.listToolsWithMeta('managed'), appHost.listToolsWithMeta('managed')])
    ok(a.length === 1 && b.length === 1, '显式确认 pi 侧无条目且无旧 runner：允许连接')
    ok(fake.forServer('managed').length === 1, '并发连接去重：同一服务只创建一个 manager')
    ok(appHost.statusOf('managed').status === 'ready', '连接去重后状态为 ready')
  }

  {
    await writePiDoc(piGlobalFile, { mcpServers: { managed: { command: 'still-there' } } })
    const record = fake.forServer('managed').at(-1)
    const closesBefore = record.closes
    await fails(() => appHost.listToolsWithMeta('managed'), 'native-still-present', 'pi 全局配置仍有同名条目：拒绝连接')
    ok(record.closes === closesBefore + 1, '拒绝时已 await 关闭旧池连接（不是先 throw 留旧池）')
    ok(appHost.statusOf('managed').status === 'disconnected', '拒绝后连接状态已清空')
    await rm(piGlobalFile, { force: true })
  }

  {
    await writePiDoc(projectPiFile, { mcpServers: { managed: { command: 'project-copy' } } })
    await fails(() => appHost.listToolsWithMeta('managed'), 'native-still-present', '全局服务在受信项目位置同名：同样拒绝')
    await rm(projectPiFile, { force: true })
  }

  {
    await mkdir(piAgentDir, { recursive: true })
    await writeFile(piGlobalFile, '{ 这不是 JSON', 'utf8')
    await fails(() => appHost.listToolsWithMeta('managed'), 'native-invalid-json', 'pi 配置坏 JSON：拒绝连接')
    await rm(piGlobalFile, { force: true })

    const readFailHost = newAppHost({ ownership: { readNativeConfig: async (path) => { throw new Error(`EACCES ${path}`) } } })
    await fails(() => readFailHost.listToolsWithMeta('managed'), 'native-unreadable', 'pi 配置读失败：拒绝连接')
  }

  {
    const holdersHost = newAppHost({ ownership: { holdersFor: async () => [{ id: 'runner-1' }] } })
    await fails(() => holdersHost.listToolsWithMeta('managed'), 'runtime-holders-active', '旧 runner 未确认退出：拒绝连接')

    const throwHost = newAppHost({ ownership: { holdersFor: async () => { throw new Error('registry boom') } } })
    await fails(() => throwHost.listToolsWithMeta('managed'), 'runtime-unknown', 'runner 持有情况读取失败：拒绝连接')

    const flakyFake = createFakeManagerFactory()
    let explode = false
    const flaky = new host.McpAppHost({
      env,
      createManager: flakyFake.createManager,
      ownership: new host.McpAppOwnershipGuard(async () => {
        if (explode) throw new Error('facts boom')
        return { agentDir: piAgentDir, projects: [{ id: 'proj-1', cwd: projectDir }], holdersFor: async () => [] }
      })
    })
    await flaky.listToolsWithMeta('managed')
    const flakyRecord = flakyFake.forServer('managed').at(-1)
    explode = true
    await fails(() => flaky.listToolsWithMeta('managed'), 'runtime-unknown', '归属事实来源抛错：拒绝连接')
    ok(flakyRecord.closes === 1, '事实来源抛错也先关闭旧池（不留旧连接）')
  }

  {
    await fails(() => appHost.callToolWithMeta('managed-project', 'tool', {}, { projectId: 'other' }), 'project-mismatch', '跨项目调用项目服务：拒绝')
    await fails(() => appHost.callToolWithMeta('managed-project', 'tool', {}), 'project-mismatch', '无项目身份调用项目服务：拒绝')
    const outcome = await appHost.callToolWithMeta('managed-project', 'tool', {}, { projectId: 'proj-1' })
    ok(outcome.text === 'ok', '同项目身份调用项目服务：允许')

    let seenQuery = null
    const queryHost = newAppHost({ ownership: { holdersFor: async (query) => { seenQuery = query; return [] } } })
    await queryHost.listToolsWithMeta('managed')
    ok(
      seenQuery?.serverId === 'managed' && seenQuery?.scope === 'global' && seenQuery?.managedAt === '2026-10-16T00:00:00.000Z',
      'runner 持有查询带上 scope 与托管时间（A7 可据此排除切换后才启动的 runner）',
      JSON.stringify(seenQuery)
    )
  }

  {
    await appHost.listToolsWithMeta('managed')
    await writeHostConfig(baseServers().filter((server) => server.id !== 'managed'))
    const removed = await appHost.reconcile('managed')
    ok(!removed.eligible && removed.closed && removed.code === 'not-managed', '配置里删服务：reconcile 断开并拒绝')
    ok(appHost.statusOf('managed').status === 'disconnected', '删服务后连接状态已清空')

    await writeHostConfig(baseServers())
    await appHost.listToolsWithMeta('managed')
    await writeHostConfig(baseServers().map((server) => (server.id === 'managed' ? { ...server, enabled: false } : server)))
    const disabled = await appHost.reconcile('managed')
    ok(!disabled.eligible && disabled.closed && disabled.code === 'not-managed', '配置禁用：reconcile 断开并拒绝')

    await writeHostConfig(baseServers())
    await appHost.listToolsWithMeta('managed')
    await writeHostConfig(baseServers().map((server) => (server.id === 'managed' ? { ...server, ownedBy: 'pi' } : server)))
    const backToPi = await appHost.reconcile('managed')
    ok(!backToPi.eligible && backToPi.closed && backToPi.code === 'not-managed', '改回 pi：reconcile 断开并拒绝')
  }

  {
    await writeHostConfig(baseServers())
    await appHost.listToolsWithMeta('managed')
    const record = fake.forServer('managed').at(-1)
    let release
    record.gate = new Promise((resolve) => { release = resolve })
    const pending = appHost.callToolWithMeta('managed', 'tool', {})
    await delay(30)
    await writeHostConfig(baseServers().map((server) => (server.id === 'managed' ? { ...server, ownedBy: 'pi' } : server)))
    release()
    const thrown = await pending.then(() => null, (error) => error)
    ok(
      thrown instanceof host.McpAppOwnershipError && thrown.code === 'ownership-changed',
      '调用期间归属变化：迟到结果被丢弃',
      thrown ? String(thrown.code) : '结果被发布了'
    )
    ok(appHost.statusOf('managed').status === 'disconnected', '迟到结果被丢弃后旧池已关闭')
  }

  {
    await writeHostConfig(baseServers())
    await appHost.listToolsWithMeta('managed')
    const before = fake.forServer('managed').length
    await writeHostConfig(baseServers().map((server) => (server.id === 'managed' ? { ...server, command: 'nodejs' } : server)))
    const [x, y] = await Promise.all([appHost.listToolsWithMeta('managed'), appHost.listToolsWithMeta('managed')])
    ok(x.length === 1 && y.length === 1, '配置变更后仍能取到工具表')
    const after = fake.forServer('managed')
    ok(after.length === before + 1, '配置变更串行替换：只新建一条连接', `records=${after.length}`)
    ok(after[after.length - 2].closes === 1, '旧连接已被关闭一次')
    const closeIndex = fake.events.map((event, index) => [event, index]).filter(([event]) => event.startsWith('close:') && event.endsWith(':managed')).at(-1)[1]
    const createIndex = fake.events.map((event, index) => [event, index]).filter(([event]) => event.startsWith('create:') && event.endsWith(':managed')).at(-1)[1]
    ok(closeIndex < createIndex, '旧连接关闭发生在新建连接之前（无重叠窗口）')
    await appHost.reconcileAll()
  }

  await appHost.close()
  ok(true, `全部 ${checks} 项检查通过`)
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(bundleDir, { recursive: true, force: true })
}

console.log(`\nMCP Apps 归属守卫：${checks} 项检查通过（fixture 为 fake manager，非真实服务）`)
