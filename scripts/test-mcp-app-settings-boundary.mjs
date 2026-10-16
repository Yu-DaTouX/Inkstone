import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  createAccess,
  createFakeAppHost,
  createFakeLegacyManager,
  managedConfig,
  piConfig
} from './fixtures/mcp-app-settings-boundary-fixture.mjs'

const root = await mkdtemp(join(process.cwd(), '.tmp', 'mcp-settings-boundary-'))
const configFile = join(root, 'mcp-servers.json')
process.env.YAN_MCP_SERVERS_FILE = configFile
process.env.YAN_DATA_DIR = join(root, 'yan')

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
const throwsCode = (work, code, message) => {
  let thrown
  try {
    work()
  } catch (error) {
    thrown = error
  }
  ok(Boolean(thrown) && thrown.code === code, message, thrown ? `${thrown.code}: ${thrown.message}` : '没有抛错')
}
const rejectsCode = async (work, code, message) => {
  let thrown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  ok(Boolean(thrown) && thrown.code === code, message, thrown ? `${thrown.code}: ${thrown.message}` : '没有抛错')
}

async function bundle(contents, name) {
  const outfile = join(root, name)
  await build({
    stdin: { contents, resolveDir: process.cwd(), sourcefile: `${name}.ts` },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

const ipcMod = await bundle(
  "export { registerMcpAppIpc } from './src/main/ipc/mcp-app-ipc';",
  'main-ipc.mjs'
)
const helper = await bundle(
  "export * from './src/main/mcp/settings-safe-access';\nexport * from './src/shared/mcp-app-switch';",
  'settings-safe-access.mjs'
)
const renderer = await bundle(
  "export * from './src/renderer/src/features/settings/capabilities/mcp-app-ownership';",
  'renderer-ownership.mjs'
)

const { registerMcpAppIpc } = ipcMod
const {
  disconnectManagedServer,
  managedConfigOf,
  managedRuntimeFacts,
  probeManagedServer,
  reconcileLegacyManaged,
  verifyManagedServer
} = helper
const { parseMcpAppOwnershipResponse } = renderer

function captureIpc() {
  const handlers = new Map()
  return {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn)
    },
    rawHandle(channel, fn) {
      handlers.set(channel, fn)
    }
  }
}

function registerWithDeps({ agent = { capabilityProjectId: null }, registry = () => null } = {}) {
  const ipc = captureIpc()
  registerMcpAppIpc(ipc, {
    currentAgent: () => agent,
    registry,
    settings: async () => ({ projects: [] }),
    isProjectTrusted: async () => true
  })
  return ipc.handlers.get('yan:mcpApp:ownership')
}

await writeFile(
  configFile,
  JSON.stringify([{ id: 'svc-a', transport: 'stdio', command: 'node', args: ['x.js'] }])
)
const realHandler = registerWithDeps()
const handlerOutput = await realHandler()
ok(handlerOutput && !Array.isArray(handlerOutput) && Array.isArray(handlerOutput.servers), 'ownership handler 返回 { servers } 对象，不是数组')
eq(handlerOutput.servers.length, 1, 'ownership handler 从真实砚配置产出 1 条视图')
const parsedReal = parseMcpAppOwnershipResponse(handlerOutput)
ok(parsedReal.ok === true, '真实 handler 输出经解析 helper 解包成功')
eq(parsedReal.views.map((view) => view.serverId), ['svc-a'], '解析得到视图数组（serverId）')

await writeFile(configFile, '{ not json')
const brokenOutput = await registerWithDeps()()
ok(typeof brokenOutput.error === 'string' && brokenOutput.error.length > 0, '配置损坏时 handler 返回可展示的 error')
const parsedBroken = parseMcpAppOwnershipResponse(brokenOutput)
ok(parsedBroken.ok === false && parsedBroken.code === 'backend_error', '后端 error 被解析为失败（backend_error）')

for (const [label, payload] of [
  ['null', null],
  ['数组', [managedConfig('a')]],
  ['缺 servers', { error: '' }],
  ['servers 非数组', { servers: { 0: managedConfig('a') } }],
  ['条目缺 serverId', { servers: [{ ownedBy: 'pi', managed: false }] }],
  ['条目缺 ownedBy', { servers: [{ serverId: 'a', managed: false }] }]
]) {
  const parsed = parseMcpAppOwnershipResponse(payload)
  ok(parsed.ok === false && parsed.code === 'ownership_response_invalid', `拒绝畸形响应：${label}`)
}
const parsedEmpty = parseMcpAppOwnershipResponse({ servers: [] })
ok(parsedEmpty.ok === true && parsedEmpty.views.length === 0, 'servers:[] 无 error 是正常空状态')

{
  const log = []
  const legacy = createFakeLegacyManager(['A'], log)
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A')], managers: [legacy], host, log })
  const facts = await verifyManagedServer(access, 'A', 'proj-1')
  eq(facts.toolCount, 2, '托管检查用 host.listToolsWithMeta 的工具数')
  ok(log.includes('legacy.disconnect:A'), '托管检查前 await 断开旧 legacy 的该 server')
  ok(log.includes('host.reconcile:A'), '托管检查先 host.reconcile')
  ok(log.includes('host.listToolsWithMeta:A:proj-1'), '托管检查传真实 caller 项目身份')
  ok(!log.some((line) => line.startsWith('legacy.listToolsCached')), '托管检查不走 legacy listToolsCached')
}

{
  const log = []
  const legacy = createFakeLegacyManager(['A'], log)
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A')], managers: [legacy], host, log })
  await verifyManagedServer(access, 'A', 'proj-1')
  ok(!log.includes('legacy.listToolsCached:A'), 'pi→inkstone 后旧 client 不再被用来连 A')
  ok(log.filter((line) => line === 'legacy.disconnect:A').length === 1, '旧 client 的 A 恰好被断开一次')
}

{
  const log = []
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A')], managers: [], host, log })
  const status = managedRuntimeFacts(access, 'A')
  eq(status.status, 'disconnected', '托管状态读 host.statusOf')
  ok(!log.some((line) => line.startsWith('host.reconcile') || line.startsWith('host.listToolsWithMeta')), '只读 status 不 reconcile / 不连接')
}

{
  const log = []
  const host = createFakeAppHost(log, {
    reconcile: async () => {
      throw new Error('status must not reconcile')
    },
    listToolsWithMeta: async () => {
      throw new Error('status must not connect')
    },
    disconnect: async () => {
      throw new Error('status must not disconnect')
    }
  })
  const access = createAccess({ servers: [managedConfig('A')], managers: [], host, log })
  const status = managedRuntimeFacts(access, 'A')
  ok(status.toolCount === null, '读状态不连接（host 连接方法未被调用）')
}

{
  const log = []
  const legacy = createFakeLegacyManager(['A', 'B'], log)
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A'), managedConfig('B')], managers: [legacy], host, log })
  await disconnectManagedServer(access, 'A', 'proj-1')
  ok(log.includes('host.disconnect:A'), '断开托管 A 只调用 host.disconnect:A')
  ok(!log.includes('host.disconnect:B'), '断开 A 不碰 B')
  ok(!log.includes('host.close'), '断开 A 不 close 整个连接池')
  ok(!log.includes('legacy.disconnect:B'), '断 A 不误断 legacy B')
}

{
  const log = []
  const legacy = createFakeLegacyManager(['A'], log)
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [piConfig('A')], managers: [legacy], host, log })
  ok(managedConfigOf(access, 'A', 'proj-1') === null, 'pi 原生配置判为非托管')
  const decision = await reconcileLegacyManaged(access, 'A', 'proj-1')
  ok(decision.managed === false && decision.legacyHeld === false, '非托管对账不动 legacy')
  ok(log.length === 0, '非托管对账不产生任何连接 / 断开调用')
  await rejectsCode(() => probeManagedServer(access, 'A', 'proj-1'), 'not-managed', '非托管 probe 不走托管路径')
}

{
  const log = []
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A', { projectScope: 'proj-1' })], managers: [], host, log })
  await rejectsCode(
    () => probeManagedServer(access, 'A', undefined),
    'managed-project-required',
    '托管 probe 无调用者项目身份时明确拒绝'
  )
  const result = await probeManagedServer(access, 'A', 'proj-2')
  eq(result.tools, ['toolA', 'toolB'], '跨项目 probe 仍从 host 拿工具表')
  ok(
    log.includes('host.listToolsWithMeta:A:proj-2') && !log.includes('host.listToolsWithMeta:A:proj-1'),
    'probe 传真实 caller 身份（proj-2），不拿 config.projectScope（proj-1）冒充'
  )
}

{
  const log = []
  const legacy = createFakeLegacyManager(['A'], log)
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A')], managers: [legacy], host, log })
  const result = await probeManagedServer(access, 'A', 'proj-1')
  eq(result.tools, ['toolA', 'toolB'], '登记 probe 从 host 单例拿工具表')
  ok(log.includes('legacy.disconnect:A') && !log.some((line) => line.startsWith('legacy.listToolsCached')), '登记 probe 不经旧 client 连接')
}

const read = (path) => readFile(resolve(path), 'utf8')
const agentSrc = await read('src/main/agent.ts')
ok(agentSrc.includes("from './mcp/settings-safe-access'"), 'agent.ts 导入 settings-safe-access helper')
for (const symbol of ['reconcileLegacyForManaged(', 'verifyManagedServer(', 'disconnectManagedServer(', 'managedRuntimeFacts(']) {
  ok(agentSrc.includes(symbol), `agent.ts 使用 helper：${symbol}`)
}
ok(agentSrc.includes('getLegacyMcpHolderSnapshot('), 'agent.ts 提供 getLegacyMcpHolderSnapshot 只读事实 getter')

const registrationSrc = await read('src/main/capabilities/registration-service.ts')
ok(registrationSrc.includes('probeManagedServer(') && registrationSrc.includes('managedConfigById('), 'registration-service 走托管 probe helper')
ok(!registrationSrc.includes('mcpAppHost().listToolsWithMeta'), 'registration-service 不再直连 host 单例 listToolsWithMeta')

const preloadSrc = await read('src/preload/index.ts')
ok(preloadSrc.includes("invoke<McpAppOwnershipResponse>('yan:mcpApp:ownership')"), 'preload ownership 按对象契约声明')

const sharedSrc = await read('src/shared/mcp-app-switch.ts')
ok(sharedSrc.includes('interface McpAppOwnershipResponse'), 'shared 定义 McpAppOwnershipResponse')
ok(sharedSrc.includes('ownership(): Promise<McpAppOwnershipResponse>'), 'shared 桥 ownership 返回对象契约')

const rendererComponent = await read('src/renderer/src/features/settings/capabilities/McpAppOwnership.tsx')
ok(rendererComponent.includes('parseMcpAppOwnershipResponse('), 'McpAppOwnership 组件用解析 helper 解包')

await rm(root, { recursive: true, force: true })
console.log(`\n${checks} 项通过（mcp-app-settings-boundary）`)
