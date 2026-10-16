/**
 * HI3 · A7 生产运行时归属整合的隔离集成验收。
 *
 * ── 它证明什么 ──
 *   · 真实 `RunnerRegistry` + 正式 `AgentController`（随包 pi 1.2.0、临时
 *     `PI_AGENT_DIR` / `YAN_DIR`）+ 真实 `McpAppHost` + 合成 stdio MCP 服务，
 *     走完「capture → spawn → RPC ready → nativeBootWitness → runtime facts →
 *     host list/call」的**无模型**生产链；不做任何 LLM 请求、不联网；
 *   · stop 发生在 capture / verify 的 await 期间时，旧回调不 spawn、不签发，
 *     不覆盖新状态；
 *   · legacy 连接事实（`getLegacyMcpHolderSnapshot`）纳入持有者判定：pi 已退出
 *     但 legacy ready/connecting 仍阻断；事实缺失（null）按可能持有；
 *   · `McpConnectionManager` 原地协调成员：A 转托管时 B 保持原连接不重建；
 *     关闭确认 / 未知语义如实回报，不把 Promise 吞错当已释放；
 *   · 原生别名 / 坏文件 / 缺事实一律拒绝；
 *   · 生产接线（index / agent / runners / ipc / host-switch）静态核对。
 *
 * ── 边界 ──
 *   只临时 `PI_AGENT_DIR` / `YAN_*` / `YAN_MCP_SERVERS_FILE` 隔离小测；不启动
 *   Electron 窗口、不碰真实用户数据 / 真实 pi 配置、不调用真实模型或第三方 MCP。
 *   `electron` 用合成 alias 桩（见 fixture 注释），仅为了在纯 Node 里构造真实
 *   AgentController。
 *
 * 命令：node scripts/test-mcp-app-runtime-integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { delayingNativeConfigReader } from './fixtures/mcp-app-runtime-integration-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-runtime-integration-'))
const piAgentDir = join(root, 'pi-agent')
const yanDir = join(root, 'yan')
const projectCwd = join(root, 'project')
const hostConfigFile = join(yanDir, 'mcp-servers.json')
const piGlobalFile = join(piAgentDir, 'mcp.json')
const projectPiFile = join(projectCwd, '.pi', 'mcp.json')
const fixtureServer = resolve('scripts/fixtures/mcp-app-server.mjs')

await mkdir(piAgentDir, { recursive: true })
await mkdir(yanDir, { recursive: true })
await mkdir(join(projectCwd, '.pi'), { recursive: true })
await writeFile(piGlobalFile, '{"mcpServers":{}}\n', 'utf8')
await writeFile(projectPiFile, '{"mcpServers":{}}\n', 'utf8')

/* 必须在 import bundle 前设好：paths.ts 在模块加载时读这些环境变量。 */
process.env.YAN_PI_DIR = piAgentDir
process.env.YAN_DATA_DIR = yanDir
process.env.YAN_MCP_SERVERS_FILE = hostConfigFile
delete process.env.YAN_TEST_MODEL

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
const tick = (ms = 1) => new Promise((resolveTick) => setTimeout(resolveTick, ms))
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
const read = (path) => readFile(resolve(path), 'utf8')

/* ───────────────────────── 编译真实生产模块 ───────────────────────── */
const bundleDir = join(process.cwd(), '.tmp', 'mcp-runtime-integration')
await mkdir(bundleDir, { recursive: true })
const outfile = join(bundleDir, `bundle-${process.pid}.mjs`)
await build({
  stdin: {
    contents:
      "export { AgentController } from './src/main/agent';" +
      "export { RunnerRegistry } from './src/main/runners';" +
      "export * from './src/main/mcp/app-native-witness';" +
      "export * from './src/main/mcp/app-runtime-ownership';" +
      "export * from './src/main/mcp/app-ownership-guard';" +
      "export * from './src/main/mcp/app-host';" +
      "export * from './src/main/mcp/connection-manager';" +
      "export { PI_AGENT_DIR } from './src/main/paths';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  /* 纯 Node 里构造真实 AgentController：只桩掉浏览器窗口依赖，不调用它。 */
  alias: { electron: resolve('scripts/fixtures/mcp-app-runtime-integration-fixture.mjs') },
  logLevel: 'silent'
})
const m = await import(pathToFileURL(outfile).href)

/* ═════════════════ 1. legacy 事实纳入持有者判定（纯判定） ═════════════════ */
{
  const exited = { processRunning: false, conn: 'exited', projectId: null }
  ok(
    !m.mayHoldMcpAppWithLegacy({ ...exited, legacyMcpServices: [] }, { serverId: 'x', scope: 'global' }),
    '1a pi 已退出且 legacy 为空：确定不持有'
  )
  ok(
    m.mayHoldMcpAppWithLegacy(
      { ...exited, legacyMcpServices: [{ serverId: 'x', status: 'ready' }] },
      { serverId: 'x', scope: 'global' }
    ),
    '1b pi 已退出但 legacy ready：仍视为持有者'
  )
  ok(
    m.mayHoldMcpAppWithLegacy(
      { ...exited, legacyMcpServices: [{ serverId: 'x', status: 'connecting' }] },
      { serverId: 'x', scope: 'global' }
    ),
    '1c legacy connecting（关闭悬挂）：仍视为持有者'
  )
  ok(
    !m.mayHoldMcpAppWithLegacy(
      { ...exited, legacyMcpServices: [{ serverId: 'x', status: 'disconnected' }] },
      { serverId: 'x', scope: 'global' }
    ),
    '1d legacy disconnected：不算持有'
  )
  ok(
    m.mayHoldMcpAppWithLegacy({ ...exited, legacyMcpServices: null }, { serverId: 'x', scope: 'global' }),
    '1e legacy 事实缺失（null）：按可能持有'
  )
  ok(
    !m.mayHoldMcpAppWithLegacy({ ...exited, legacyMcpServices: [{ serverId: 'y', status: 'ready' }] }, { serverId: 'x', scope: 'global' }),
    '1f legacy 持有别的 server：目标仍按 pi-exited 排除'
  )
}

/* ═════════════════ 2. 原生别名 / 坏文件（模块级真实文件） ═════════════════ */
{
  const names = m.mcpAppHolderNames('demo-svc', {
    id: 'demo-svc',
    transport: 'stdio',
    command: 'x',
    appHost: { at: '2026-10-16T00:00:00.000Z', natives: [{ path: piGlobalFile, name: 'demo-native', entry: {}, fingerprint: 'fp' }] }
  })
  ok(names.has('demo-native'), '2a 保存的原生别名进入候选名字集合')
  const snapshot = { generation: 1, cwd: projectCwd, processRunning: true, conn: 'ready' }
  const aliasWitness = {
    bootId: 'b',
    generation: 1,
    cwd: projectCwd,
    projectId: null,
    capturedAt: '',
    sources: [],
    servers: ['demo-native']
  }
  ok(
    !m.witnessProvesAbsent({ witness: aliasWitness, snapshot, names }).proven,
    '2b 启动集合含原生别名：不证明无持有'
  )
  await writeFile(projectPiFile, '{ not json', 'utf8')
  const bad = await m.captureNativeStartupWitness({
    agentDir: piAgentDir,
    cwd: projectCwd,
    bootId: m.newBootId(),
    generation: 1
  })
  eq(bad.ok, false, '2c 坏 JSON：不签发启动见证')
  await writeFile(projectPiFile, '{"mcpServers":{}}\n', 'utf8')
}

/* ═════════════════ 3. McpConnectionManager 原地协调 / 关闭确认 ═════════════════ */
{
  const serverConfig = (id) => ({ id, transport: 'stdio', command: process.execPath, args: [fixtureServer, '--stdio'] })
  const manager = new m.McpConnectionManager([serverConfig('svc-A'), serverConfig('svc-B')])
  await manager.listTools('svc-A')
  await manager.listTools('svc-B')
  eq(manager.statusOf('svc-A').status, 'ready', '3a A 连接 ready')
  eq(manager.statusOf('svc-B').status, 'ready', '3b B 连接 ready')
  const releases = manager.syncServers([serverConfig('svc-B')])
  eq(releases.map((entry) => entry.serverId), ['svc-A'], '3c 只摘除 A 的成员（不重建整个 manager）')
  eq(manager.listServerIds(), ['svc-B'], '3d A 已从登记中移除')
  eq(manager.statusOf('svc-B').status, 'ready', '3e B 保持原连接（未重建，无第二条连接）')
  const outcome = await releases[0].release
  ok(outcome.confirmed === true, '3f A 的连接关闭得到确认')
  ok((await manager.disconnect('svc-A')) === false, '3g 摘除后断 A 是 no-op（不影响 B）')
  eq(manager.statusOf('svc-B').status, 'ready', '3h 断 A 不碰 B 的连接')
  eq((await manager.closeConfirmed()).confirmed, true, '3i 关闭确认：全部确认')

  /* 关闭确认的未知语义：内部 close 抛错必须如实回报，不吞成成功。 */
  const failing = new m.McpConnectionManager([])
  failing.connections.set('boom', {
    config: { id: 'boom', transport: 'stdio', command: 'x' },
    client: {
      close: async () => {
        throw new Error('close nope')
      }
    },
    status: 'ready',
    generation: 0
  })
  const failed = await failing.closeConfirmed()
  ok(failed.confirmed === false && failed.unknown === 1, '3j 关闭抛错：confirmed=false / unknown=1（不伪造成功）')
  await assert.doesNotReject(async () => failing.close(), '3k close() 仍尽力回收、不抛错')
}

/* ═════════════════ 4. 真实 pi 无模型启动链（capture → spawn → ready → witness → facts → host） ═════════════════ */
let realReported = false
try {
  await writeJson(hostConfigFile, {
    servers: [
      {
        id: 'demo-svc',
        title: 'demo',
        transport: 'stdio',
        command: process.execPath,
        args: [fixtureServer, '--stdio'],
        enabled: true,
        ownedBy: 'inkstone',
        appHost: {
          at: '2026-10-16T00:00:00.000Z',
          natives: [{ path: piGlobalFile, name: 'demo-native', entry: { command: 'saved' }, fingerprint: 'fp' }]
        }
      }
    ]
  })
  await writeFile(piGlobalFile, '{"mcpServers":{}}\n', 'utf8')
  await writeFile(projectPiFile, '{"mcpServers":{}}\n', 'utf8')

  const registry = new m.RunnerRegistry({
    limit: 3,
    createAgent: (id, cwd) => new m.AgentController({ push: () => {}, cwd })
  })
  const selected = await registry.select({ cwd: projectCwd, activate: true })
  ok(selected.ok, '4a 真实 pi 实例启动成功（无模型请求）', selected.error)
  const agent = registry.active()
  const witness = agent.nativeBootWitness()
  ok(Boolean(witness), '4b ready 后签发启动见证')
  ok(witness.servers.length === 0, '4c 见证证明启动时未加载 demo-svc（含别名）')
  eq(witness.cwd.toLowerCase(), projectCwd.toLowerCase(), '4d 见证 cwd 与 runner 一致')
  eq(witness.generation, selected.generation, '4e 见证 generation 与 runner 一致')

  const facts = m.createMcpAppRuntimeOwnershipFacts({
    registry: () => registry,
    agentDir: piAgentDir,
    projects: async () => [{ id: 'p1', cwd: projectCwd }]
  })
  const factsValue = await facts()
  const holders = await factsValue.holdersFor({ serverId: 'demo-svc', scope: 'global' })
  eq(holders.length, 0, '4f 真实 witness + 空 legacy：没有旧持有者')

  const host = new m.McpAppHost({ env: { YAN_MCP_SERVERS_FILE: hostConfigFile }, ownership: facts })
  try {
    const tools = await host.listToolsWithMeta('demo-svc')
    ok(tools.some((tool) => tool.name === 'read_only_note'), '4g 合法 witness 下 host 真实列出工具表')
    const call = await host.callToolWithMeta('demo-svc', 'read_only_note', {})
    ok(call.isError === false && typeof call.text === 'string', '4h host 真实调用合成工具成功')
    realReported = true
  } finally {
    await host.close().catch(() => undefined)
  }

  /* 旧 boot 不能发布：stop 后见证作废，新实例换 bootId。 */
  const bootA = witness.bootId
  await agent.stop()
  eq(agent.nativeBootWitness(), null, '4i stop 后启动见证立即作废')
  await registry.stopAll().catch(() => undefined)
  const fresh = new m.AgentController({ push: () => {}, cwd: projectCwd })
  const freshStart = await fresh.start()
  ok(freshStart.ok, '4j 新进程重新启动', freshStart.error)
  const bootB = fresh.nativeBootWitness()?.bootId
  ok(Boolean(bootB) && bootB !== bootA, '4k 新 bootId 不同（旧 boot 不能发布）')
  await fresh.stop().catch(() => undefined)
} finally {
  if (!realReported) console.log('（真实 pi 子用例未走完，见上方失败）')
}

/* ═════════════════ 5. stop 竞态：capture / verify 期间不 spawn、不签发 ═════════════════ */
{
  const controller = delayingNativeConfigReader(m.defaultNativeConfigReader, { 1: 500 })
  const agent = new m.AgentController({ push: () => {}, cwd: projectCwd, nativeConfigReader: controller.reader })
  const startPromise = agent.start()
  while (controller.index < 1) await tick(5)
  await tick(80)
  await agent.stop()
  const result = await startPromise
  ok(result.ok === false, '5a stop 打断采集：本次启动失败')
  ok(agent.running === false, '5b 采集期间 stop 后不 spawn（旧进程不复活）')
  eq(agent.nativeBootWitness(), null, '5c 采集期间 stop：旧回调不签发见证')
  await agent.stop().catch(() => undefined)
}
{
  const controller = delayingNativeConfigReader(m.defaultNativeConfigReader, { 3: 400, 4: 400 })
  const agent = new m.AgentController({ push: () => {}, cwd: projectCwd, nativeConfigReader: controller.reader })
  const startPromise = agent.start()
  const deadline = Date.now() + 20_000
  while (!controller.started.has(3) && Date.now() < deadline) await tick(10)
  ok(controller.started.has(3), '5d 已进入 ready 后复核阶段（verify 读取开始）')
  await agent.stop()
  const result = await startPromise
  ok(result.ok === false, '5e stop 打断复核：本次启动失败')
  ok(agent.running === false, '5f 复核期间 stop 后进程已停止')
  eq(agent.nativeBootWitness(), null, '5g 复核期间 stop：旧回调不签发见证')
  await agent.stop().catch(() => undefined)
}

/* ═════════════════ 6. 生产接线静态核对 ═════════════════ */
{
  const agentSrc = await read('src/main/agent.ts')
  ok(agentSrc.includes('captureNativeStartupWitness('), '6a agent.ts spawn 前采集启动见证')
  ok(agentSrc.includes('verifyNativeStartupWitness('), '6b agent.ts ready 后复核启动见证')
  ok(agentSrc.includes('nativeBootWitness()'), '6c agent.ts 暴露只读 nativeBootWitness getter')
  ok(agentSrc.includes('syncServers('), '6d agent.ts 原地协调 manager 成员（不重建）')
  ok(agentSrc.includes('closeConfirmed()'), '6e agent.ts 退出/对账用关闭确认语义')
  const runnersSrc = await read('src/main/runners.ts')
  ok(runnersSrc.includes('legacyMcpServices'), '6f runners 窄快照纳入 legacy 连接事实')
  const indexPath = await read('src/main/index.ts')
  ok(indexPath.includes('configureMcpAppHostOwnership('), '6g index 注入真实归属守卫')
  ok(indexPath.includes('createMcpAppRuntimeOwnershipFacts('), '6h index 用 A7 动态 facts 工厂')
  ok(indexPath.includes('closeMcpAppHost()'), '6i index 退出时关闭宿主连接池')
  const ipcSrc = await read('src/main/ipc/mcp-app-ipc.ts')
  ok(ipcSrc.includes('mcpAppHost().disconnect('), '6j to-pi 按 server 断开（不关整池）')
  const hostSwitchSrc = await read('src/main/mcp/host-switch.ts')
  ok(hostSwitchSrc.includes('disconnectHost?: (serverId: string)'), '6k host-switch 断开回调签名按 serverId')
}

await rm(root, { recursive: true, force: true }).catch(() => undefined)
console.log(`\n全部通过：${checks} 项断言（含隔离真实 pi 1.2.0 无模型启动链）`)
process.exit(0)
