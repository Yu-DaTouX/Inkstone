import fs, { existsSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { createFakeManagerFactory } from './fixtures/mcp-app-ownership-fixture.mjs'
import { createFakeManagerFactory as createFakeManagerFactory__runtimeOwnershipSuite, createFakeAgent } from './fixtures/mcp-app-runtime-ownership-fixture.mjs'
import { delayingNativeConfigReader } from './fixtures/mcp-app-runtime-integration-fixture.mjs'
import { fakeFrame, fakePort, fakeWindow } from './fixtures/mcp-app-cross-contract-boundary.mjs'

async function isolated(run) {
  const savedEnv = { ...process.env }
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
    Object.assign(process.env, savedEnv)
  }
}

async function switchSuite() {
const root = await mkdtemp(join(tmpdir(), 'yan-mcp-app-switch-'))
const agentDir = join(root, 'pi-agent')
const dataDir = join(root, 'yan')
const hostConfigFile = join(dataDir, 'mcp-servers.json')
const projectCwd = join(root, 'project')
const nativeGlobal = join(agentDir, 'mcp.json')
const nativeProject = join(projectCwd, '.pi', 'mcp.json')
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
      "export * from './src/main/mcp/host-switch';" +
      "export * from './src/main/mcp/config';" +
      "export * from './src/main/mcp/native-import';" +
      "export * from './src/shared/mcp-app-switch';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const m = await import(pathToFileURL(outfile).href)

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const ORIGINAL_NATIVE_ENTRY = {
  command: 'node',
  args: ['server.js', '--x'],
  env: { API_KEY: 'secret' },
  description: '天气',
  unknownEntry: { z: 2 }
}
const INITIAL_HOST = {
  unknownTop: { keep: true },
  servers: [
    {
      id: 'weather',
      title: '天气',
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--x'],
      env: { API_KEY: 'secret' },
      effect: 'read',
      customField: { a: 1 }
    }
  ]
}
const INITIAL_NATIVE = { unknownNative: 1, mcpServers: { weather: ORIGINAL_NATIVE_ENTRY } }

async function reset() {
  await writeJson(hostConfigFile, INITIAL_HOST)
  await writeJson(nativeGlobal, INITIAL_NATIVE)
  await rm(nativeProject, { force: true }).catch(() => undefined)
}

let nowMs = 1_700_000_000_000
let tokenSeq = 0
function makeHost(overrides = {}) {
  const disconnectCalls = []
  return {
    agentDir,
    hostConfigFile,
    projects: [{ id: 'p1', cwd: projectCwd }],
    now: () => nowMs,
    generateToken: () => `tok-${++tokenSeq}`,
    holders: { holdersFor: async () => [], runtimeEpoch: () => 'epoch-0' },
    disconnectHost: async (serverId) => {
      disconnectCalls.push(serverId)
    },
    disconnectCalls,
    ...overrides
  }
}

async function assertSingleOwner(name, expected) {
  const host = await readJson(hostConfigFile)
  const server = host.servers.find((entry) => entry.id === 'weather')
  const managed = server.ownedBy === 'inkstone' && Boolean(server.appHost)
  const native = await readFile(nativeGlobal, 'utf8').then(
    (text) => Object.prototype.hasOwnProperty.call(JSON.parse(text).mcpServers ?? {}, 'weather'),
    () => false
  )
  const count = (managed ? 1 : 0) + (native ? 1 : 0)
  ok(count === 1, `${name}: 恰有一个 owner`, `managed=${managed} native=${native} count=${count}`)
  ok(
    (expected === 'inkstone') === managed && (expected === 'pi') === native,
    `${name}: owner 方向符合预期（${expected}）`
  )
}

try {
  await reset()
  const host1 = makeHost({
    verify: async (input) => {
      ok(input.expect === 'absent', 'to-inkstone 复核期望 absent')
      return { ok: true }
    }
  })
  const preview1 = await m.prepareMcpAppSwitch({ host: host1, serverId: 'weather', owner: { id: 'owner-A' } })
  ok(preview1.direction === 'to-inkstone', 'to-inkstone 预览方向正确')
  ok(preview1.blocked === false, '无已加载实例时不阻断')
  ok(preview1.entry.envKeys.includes('API_KEY'), '脱敏摘要含 env 键名')
  ok(!JSON.stringify(preview1).includes('secret'), '预览不泄露 env 值', JSON.stringify(preview1))
  ok(!JSON.stringify(preview1).includes('unknownEntry'), '预览不含原始未知字段')
  const committed1 = await m.commitMcpAppSwitch({ host: host1, token: preview1.token, owner: { id: 'owner-A' } })
  ok(committed1.ok, 'to-inkstone 提交成功', committed1.notice)
  eq(committed1.steps, { native: 'removed', host: 'enrolled', verify: 'passed', hostDisconnect: 'not-needed' }, 'to-inkstone 分步结果')
  const nativeAfter1 = await readJson(nativeGlobal)
  eq(nativeAfter1.unknownNative, 1, 'pi 顶层未知字段保留')
  ok(!('weather' in (nativeAfter1.mcpServers ?? {})), 'pi 条目已移出')
  const hostAfter1 = await readJson(hostConfigFile)
  eq(hostAfter1.unknownTop, { keep: true }, '砚顶层未知字段保留')
  const weather1 = hostAfter1.servers.find((s) => s.id === 'weather')
  eq(weather1.customField, { a: 1 }, '砚条目未知字段保留')
  ok(weather1.ownedBy === 'inkstone' && weather1.enabled === true, '砚条目已启用并声明托管')
  eq(weather1.appHost.natives[0].entry, ORIGINAL_NATIVE_ENTRY, '原 pi 条目逐字保存（值保真）')
  eq(weather1.appHost.natives[0].name, 'weather', '保存了原生名')
  eq(weather1.appHost.natives[0].path, nativeGlobal, '保存了原生路径')
  await assertSingleOwner('to-inkstone 后', 'inkstone')

  const host2 = makeHost({
    verify: async (input) => {
      ok(input.expect === 'present', 'to-pi 复核期望 present')
      return { ok: true }
    }
  })
  const preview2 = await m.prepareMcpAppSwitch({ host: host2, serverId: 'weather', owner: { id: 'owner-A' } })
  ok(preview2.direction === 'to-pi', 'to-pi 预览方向正确')
  const committed2 = await m.commitMcpAppSwitch({ host: host2, token: preview2.token, owner: { id: 'owner-A' } })
  ok(committed2.ok, 'to-pi 提交成功', committed2.notice)
  eq(committed2.steps, { native: 'written', host: 'released', verify: 'passed', hostDisconnect: 'disconnected' }, 'to-pi 分步结果')
  eq(host2.disconnectCalls, ['weather'], 'to-pi 断开的正是目标 server（按 server 断开，不关整池）')
  const nativeAfter2 = await readJson(nativeGlobal)
  eq(nativeAfter2.mcpServers.weather, ORIGINAL_NATIVE_ENTRY, 'pi 条目逐字写回')
  const hostAfter2 = await readJson(hostConfigFile)
  const weather2 = hostAfter2.servers.find((s) => s.id === 'weather')
  ok(weather2.enabled === false && weather2.ownedBy === 'pi', '砚条目已停用并归 pi')
  ok('migratedToNative' in weather2 && !('appHost' in weather2), '写了 migratedToNative 且移除 appHost')
  eq(hostAfter2.unknownTop, { keep: true }, '写回后砚未知字段仍在')
  await assertSingleOwner('to-pi 后', 'pi')

  await reset()
  const host3 = makeHost()
  const preview3 = await m.prepareMcpAppSwitch({ host: host3, serverId: 'weather', owner: { id: 'owner-A' } })
  await writeJson(nativeGlobal, { ...INITIAL_NATIVE, changed: true })
  const committed3 = await m.commitMcpAppSwitch({ host: host3, token: preview3.token, owner: { id: 'owner-A' } })
  ok(!committed3.ok && committed3.remediation === 'not-needed', '目标变更后拒绝且未补救')
  eq(committed3.steps, { native: 'skipped', host: 'skipped', verify: 'skipped', hostDisconnect: 'not-needed' }, '目标变更后无任何写入')
  const hostAfter3 = await readJson(hostConfigFile)
  ok(!hostAfter3.servers[0].ownedBy, '目标变更后砚配置未动')

  await reset()
  const host4 = makeHost()
  const preview4 = await m.prepareMcpAppSwitch({ host: host4, serverId: 'weather', owner: { id: 'owner-A' } })
  await writeJson(hostConfigFile, { ...INITIAL_HOST, touched: 1 })
  const committed4 = await m.commitMcpAppSwitch({ host: host4, token: preview4.token, owner: { id: 'owner-A' } })
  ok(!committed4.ok, '砚配置变更后拒绝')
  const nativeAfter4 = await readJson(nativeGlobal)
  ok('weather' in nativeAfter4.mcpServers, '砚配置变更后 pi 条目未动')

  await reset()
  const host5 = makeHost()
  const preview5 = await m.prepareMcpAppSwitch({ host: host5, serverId: 'weather', owner: { id: 'owner-A' } })
  const savedNow = nowMs
  nowMs = savedNow + 10 * 60_000
  await rejects(
    () => m.commitMcpAppSwitch({ host: host5, token: preview5.token, owner: { id: 'owner-A' } }),
    'token_expired',
    '过期令牌被拒绝'
  )
  nowMs = savedNow
  await reset()
  const host5b = makeHost()
  const preview5b = await m.prepareMcpAppSwitch({ host: host5b, serverId: 'weather', owner: { id: 'owner-A' } })
  await rejects(
    () => m.commitMcpAppSwitch({ host: host5b, token: preview5b.token, owner: { id: 'owner-B' } }),
    'token_owner_mismatch',
    '跨 owner 令牌被拒绝'
  )

  await reset()
  await writeJson(nativeProject, { mcpServers: { weather: { command: 'node' } } })
  const host6 = makeHost()
  await rejects(
    () => m.prepareMcpAppSwitch({ host: host6, serverId: 'weather', owner: { id: 'owner-A' } }),
    'native_name_conflict',
    '项目位置同名冲突被拒绝'
  )

  await reset()
  const holder = { runnerId: 'r1', generation: 3, busy: true }
  const host7 = makeHost({ holders: { holdersFor: async () => [holder] } })
  const preview7 = await m.prepareMcpAppSwitch({ host: host7, serverId: 'weather', owner: { id: 'owner-A' } })
  ok(preview7.blocked === true && preview7.holders.length === 1, '存活 runner 使预览标记 blocked')
  const committed7 = await m.commitMcpAppSwitch({ host: host7, token: preview7.token, owner: { id: 'owner-A' } })
  ok(!committed7.ok, '存活 runner 时提交被拒')
  eq(committed7.steps.native, 'skipped', '存活 runner 时未写 pi 配置')
  ok(committed7.notice.includes('运行实例'), '拒绝原因说明是运行实例')
  await assertSingleOwner('存活 runner 拒绝后', 'pi')

  await reset()
  await writeJson(hostConfigFile, {
    servers: [
      ...INITIAL_HOST.servers,
      { id: 'windows-mcp', title: '电脑操作', transport: 'stdio', command: 'uvx', args: ['windows-mcp'] }
    ]
  })
  const host8 = makeHost()
  await rejects(
    () => m.prepareMcpAppSwitch({ host: host8, serverId: 'windows-mcp', owner: { id: 'owner-A' } }),
    'unsupported',
    'windows-mcp 拒绝托管'
  )

  await reset()
  const originalNativeText = await readFile(nativeGlobal, 'utf8')
  const host9 = makeHost({
    writeText: async (path, text, fingerprint) => {
      if (path === hostConfigFile) throw new Error('disk full')
      return m.atomicWrite(path, text, fingerprint)
    }
  })
  const preview9 = await m.prepareMcpAppSwitch({ host: host9, serverId: 'weather', owner: { id: 'owner-A' } })
  const committed9 = await m.commitMcpAppSwitch({ host: host9, token: preview9.token, owner: { id: 'owner-A' } })
  ok(!committed9.ok, '砚配置写失败时提交返回失败')
  eq(committed9.steps, { native: 'removed', host: 'failed', verify: 'skipped', hostDisconnect: 'not-needed' }, '写一半失败分步')
  eq(committed9.remediation, 'restored', '写一半失败已按原值恢复')
  eq(await readFile(nativeGlobal, 'utf8'), originalNativeText, '恢复后 pi 文件逐字回到原样')
  const hostAfter9 = await readJson(hostConfigFile)
  ok(!hostAfter9.servers[0].ownedBy, '砚配置保持原状')
  await assertSingleOwner('写一半失败恢复后', 'pi')

  await reset()
  let hostWriteAttempted = false
  const host10 = makeHost({
    writeText: async (path, text, fingerprint) => {
      if (path === hostConfigFile) {
        hostWriteAttempted = true
        throw new Error('disk full')
      }
      if (hostWriteAttempted) throw new Error('restore also failed')
      return m.atomicWrite(path, text, fingerprint)
    }
  })
  const preview10 = await m.prepareMcpAppSwitch({ host: host10, serverId: 'weather', owner: { id: 'owner-A' } })
  const committed10 = await m.commitMcpAppSwitch({ host: host10, token: preview10.token, owner: { id: 'owner-A' } })
  ok(!committed10.ok, '恢复失败时仍如实返回失败')
  eq(committed10.remediation, 'remediation-failed', '恢复失败明确标注 remediation-failed')
  ok(committed10.notice.includes('恢复失败') || committed10.notice.includes('手动修复'), '恢复失败给出修复入口')
  const backupPath = /另存到 (.+?)，/.exec(committed10.notice)?.[1]
  ok(!!backupPath && fs.existsSync(backupPath), '恢复失败时原 pi 配置另存到备份文件', committed10.notice)
  if (backupPath) fs.rmSync(backupPath, { force: true })

  await reset()
  const setupHost = makeHost()
  const setupPreview = await m.prepareMcpAppSwitch({ host: setupHost, serverId: 'weather', owner: { id: 'owner-A' } })
  await m.commitMcpAppSwitch({ host: setupHost, token: setupPreview.token, owner: { id: 'owner-A' } })
  const host11 = makeHost({
    disconnectHost: async () => {
      throw new Error('close failed')
    }
  })
  const hostSnapshot = await readFile(hostConfigFile, 'utf8')
  const preview11 = await m.prepareMcpAppSwitch({ host: host11, serverId: 'weather', owner: { id: 'owner-A' } })
  const committed11 = await m.commitMcpAppSwitch({ host: host11, token: preview11.token, owner: { id: 'owner-A' } })
  ok(!committed11.ok, '断连失败时提交被拒')
  eq(committed11.steps.hostDisconnect, 'failed', '断连失败如实标注')
  eq(committed11.steps.native, 'skipped', '断连失败时未写 pi 配置')
  eq(await readFile(hostConfigFile, 'utf8'), hostSnapshot, '断连失败时砚配置未动')
  await assertSingleOwner('断连失败后', 'inkstone')

  await reset()
  const before12 = await readFile(hostConfigFile, 'utf8')
  const nativeBefore12 = await readFile(nativeGlobal, 'utf8')
  const noGuard = makeHost({ holders: undefined })
  await rejects(
    () => m.prepareMcpAppSwitch({ host: noGuard, serverId: 'weather', owner: { id: 'owner-A' } }),
    'holders_unavailable',
    '缺运行时守卫时预览拒绝（不当作无人持有）'
  )
  const throwingGuard = makeHost({
    holders: {
      holdersFor: async () => {
        throw new Error('registry boom')
      },
      runtimeEpoch: () => 'e'
    }
  })
  await rejects(
    () => m.prepareMcpAppSwitch({ host: throwingGuard, serverId: 'weather', owner: { id: 'owner-A' } }),
    'holders_unavailable',
    '运行时守卫抛错时预览拒绝'
  )
  const guardHost12 = makeHost()
  const preview12 = await m.prepareMcpAppSwitch({ host: guardHost12, serverId: 'weather', owner: { id: 'owner-A' } })
  const commitNoGuard12 = makeHost({ holders: undefined })
  const committed12 = await m.commitMcpAppSwitch({
    host: commitNoGuard12,
    token: preview12.token,
    owner: { id: 'owner-A' }
  })
  ok(!committed12.ok, 'commit 缺运行时守卫时被拒')
  eq(committed12.steps.native, 'skipped', 'commit 缺运行时守卫时未写 pi')
  eq(await readFile(hostConfigFile, 'utf8'), before12, 'commit 缺运行时守卫时砚配置未动')
  eq(await readFile(nativeGlobal, 'utf8'), nativeBefore12, 'commit 缺运行时守卫时 pi 配置未动')

  await reset()
  const setup12 = makeHost()
  const p12 = await m.prepareMcpAppSwitch({ host: setup12, serverId: 'weather', owner: { id: 'owner-A' } })
  const c12 = await m.commitMcpAppSwitch({ host: setup12, token: p12.token, owner: { id: 'owner-A' } })
  ok(c12.ok, '缺断开回调用例：先建立砚托管状态')
  const hostSnapshot12 = await readFile(hostConfigFile, 'utf8')
  const nativeSnapshot12 = await readFile(nativeGlobal, 'utf8')
  const noDisconnect = makeHost({ disconnectHost: undefined })
  const preview12b = await m.prepareMcpAppSwitch({ host: noDisconnect, serverId: 'weather', owner: { id: 'owner-A' } })
  const committed12b = await m.commitMcpAppSwitch({ host: noDisconnect, token: preview12b.token, owner: { id: 'owner-A' } })
  ok(!committed12b.ok, 'to-pi 缺断开回调时提交被拒')
  eq(committed12b.steps.hostDisconnect, 'skipped', '缺断开回调如实标注 skipped')
  eq(committed12b.steps.native, 'skipped', '缺断开回调时未写 pi')
  eq(await readFile(hostConfigFile, 'utf8'), hostSnapshot12, '缺断开回调时砚配置未动')
  eq(await readFile(nativeGlobal, 'utf8'), nativeSnapshot12, '缺断开回调时 pi 配置未动')
  await assertSingleOwner('缺断开回调拒绝后', 'inkstone')

  await reset()
  let epoch13 = 'epoch-a'
  const host13 = makeHost({ holders: { holdersFor: async () => [], runtimeEpoch: () => epoch13 } })
  const preview13 = await m.prepareMcpAppSwitch({ host: host13, serverId: 'weather', owner: { id: 'owner-A' } })
  ok(preview13.blocked === false, 'epoch 变化前无持有者时不阻断')
  epoch13 = 'epoch-b'
  const hostBefore13 = await readFile(hostConfigFile, 'utf8')
  const nativeBefore13 = await readFile(nativeGlobal, 'utf8')
  const committed13 = await m.commitMcpAppSwitch({ host: host13, token: preview13.token, owner: { id: 'owner-A' } })
  ok(!committed13.ok, 'epoch 变化后提交被拒')
  eq(committed13.steps.native, 'skipped', 'epoch 变化时未写 pi')
  ok(committed13.notice.includes('运行时'), 'epoch 变化原因可读', committed13.notice)
  eq(await readFile(hostConfigFile, 'utf8'), hostBefore13, 'epoch 变化时砚配置未动')
  eq(await readFile(nativeGlobal, 'utf8'), nativeBefore13, 'epoch 变化时 pi 配置未动')
  await assertSingleOwner('epoch 变化拒绝后', 'pi')
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

console.log(`\n全部通过：${checks} 项断言`)
}

async function switchRuntimeSuite() {
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
}

async function ownershipSuite() {
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
    await fails(() => appHost.callToolWithMeta('managed-project', 'tool', {}, { projectId: 'other' }), 'not-managed', '跨项目调用项目服务：拒绝')
    await fails(() => appHost.callToolWithMeta('managed-project', 'tool', {}), 'not-managed', '无项目身份调用项目服务：拒绝')
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
}

async function runtimeOwnershipSuite() {
const createFakeManagerFactory = createFakeManagerFactory__runtimeOwnershipSuite
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
}

async function runtimeIntegrationSuite() {
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
  alias: { electron: resolve('scripts/fixtures/mcp-app-runtime-integration-fixture.mjs') },
  logLevel: 'silent'
})
const m = await import(pathToFileURL(outfile).href)

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
}

async function cancelIsolationSuite() {
const root = await mkdtemp(join(tmpdir(), 'yan-mcp-cancel-iso-'))
const fixture = resolve('scripts/fixtures/mcp-app-cancel-isolation-server.mjs')
const logPath = join(root, 'cancel.log')

const outfile = join(process.cwd(), 'out', 'test', 'mcp-cancel-isolation-bundle.mjs')
await build({
  stdin: {
    contents: "export * from './src/main/mcp/connection-manager';",
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
const { McpConnectionManager } = await import(pathToFileURL(outfile).href)

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail !== undefined ? `（${detail}）` : ''}`)
  checks++
  console.log(`✓ ${message}`)
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const logText = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
const rejectOf = (promise) => promise.then(() => undefined, (error) => error)

const isRequestCancelled = (error) => error?.code === 'request-cancelled'

const unhandled = []
const onUnhandled = (reason) => unhandled.push(reason)
process.on('unhandledRejection', onUnhandled)

const managers = []
const stdioConfig = (id, extraEnv = {}) => ({
  id,
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  env: { YAN_CANCEL_FIXTURE_LOG: logPath, ...extraEnv }
})
const newManager = (configs, timeoutMs = 5000) => {
  const manager = new McpConnectionManager(configs, timeoutMs)
  managers.push(manager)
  return manager
}
const assertConnected = (manager, id, label) =>
  ok(manager.statusOf(id).status === 'ready', label, manager.statusOf(id).status)

const netPort = async (port) => {
  const net = await import('node:net')
  for (let i = 0; i < 80; i++) {
    const up = await new Promise((done) => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); done(true) })
      socket.once('error', () => { socket.destroy(); done(false) })
    })
    if (up) return true
    await delay(100)
  }
  return false
}

let httpChild
try {

  {
    const manager = newManager([stdioConfig('iso')])
    await manager.callTool('iso', 'echo', { text: 'warm' })
    assertConnected(manager, 'iso', 'stdio 取消：连接就绪')

    const controller = new AbortController()
    let aState = 'pending'
    const a = manager.callTool('iso', 'slow', {}, { signal: controller.signal }).then(
      () => (aState = 'resolved'),
      () => (aState = 'rejected')
    )
    await delay(120)
    const b = await manager.callTool('iso', 'echo', { text: 'b' })
    ok(b?.structuredContent?.echo === 'b', 'stdio 取消：同连接并发的 B 成功')
    controller.abort()
    await a
    ok(aState === 'rejected', 'stdio 取消：A 以失败结束（不会迟到成功）')
    await delay(150)
    ok(logText().includes('cancelled'), 'stdio 取消：服务端确实收到并处理了取消')
    assertConnected(manager, 'iso', 'stdio 取消：连接仍是 ready（没被 A 拆掉）')
    const after = await manager.callTool('iso', 'echo', { text: 'after' })
    ok(after?.structuredContent?.echo === 'after', 'stdio 取消：之后同一连接继续可用')
  }

  {
    const manager = newManager([stdioConfig('iso-t')])
    await manager.callTool('iso-t', 'echo', { text: 'warm' })
    const a = rejectOf(manager.callTool('iso-t', 'slow', {}, { timeoutMs: 120 }))
    const b = await manager.callTool('iso-t', 'echo', { text: 'b' })
    ok(b?.structuredContent?.echo === 'b', 'stdio 超时：同连接并发的 B 成功')
    const aErr = await a
    ok(isRequestCancelled(aErr) && /超时/.test(aErr.message), 'stdio 超时：A 是调用级超时错误', aErr?.message)
    assertConnected(manager, 'iso-t', 'stdio 超时：连接仍是 ready')
    const after = await manager.callTool('iso-t', 'echo', { text: 'after' })
    ok(after?.structuredContent?.echo === 'after', 'stdio 超时：之后同一连接继续可用')
  }

  {
    const manager = newManager([stdioConfig('iso-e')])
    await manager.callTool('iso-e', 'echo', { text: 'warm' })
    const aErrPromise = rejectOf(manager.callTool('iso-e', 'fail', {}))
    const b = await manager.callTool('iso-e', 'echo', { text: 'b' })
    ok(b?.structuredContent?.echo === 'b', 'stdio 错误：同连接并发的 B 成功')
    const aErr = await aErrPromise
    ok(aErr instanceof Error && !isRequestCancelled(aErr), 'stdio 错误：A 是请求级错误（非取消）', aErr?.message)
    assertConnected(manager, 'iso-e', 'stdio 错误：健康连接被保留（没有一律拆连接）')
    const after = await manager.callTool('iso-e', 'echo', { text: 'after' })
    ok(after?.structuredContent?.echo === 'after', 'stdio 错误：之后同一连接继续可用')
  }

  {
    const manager = newManager([stdioConfig('iso-die')], 5000)
    await manager.callTool('iso-die', 'echo', { text: 'warm' })
    const dying = manager.callTool('iso-die', 'die', {})
    const inFlight = manager.callTool('iso-die', 'slow', {})
    const [dieErr, slowErr] = await Promise.all([rejectOf(dying), rejectOf(inFlight)])
    ok(dieErr instanceof Error && slowErr instanceof Error, 'transport 死亡：连接上所有请求都失败')
    ok(
      manager.statusOf('iso-die').status === 'disconnected' || manager.statusOf('iso-die').status === 'needs-auth',
      'transport 死亡：状态如实反映为非 ready',
      manager.statusOf('iso-die').status
    )
    const revived = await manager.callTool('iso-die', 'echo', { text: 'revived' })
    ok(revived?.structuredContent?.echo === 'revived', 'transport 死亡：之后按需重连成功')
    assertConnected(manager, 'iso-die', 'transport 死亡：重连后连接 ready')
  }

  {
    const manager = newManager([stdioConfig('iso-idle')])
    await manager.callTool('iso-idle', 'echo', { text: 'warm' })
    assertConnected(manager, 'iso-idle', '空闲断线：先连上')
    await manager.callTool('iso-idle', 'exit', {})
    await delay(400)
    ok(
      manager.statusOf('iso-idle').status === 'disconnected',
      '空闲断线：服务退出后 onclose 及时把状态改为 disconnected',
      manager.statusOf('iso-idle').status
    )
    const revived = await manager.callTool('iso-idle', 'echo', { text: 'revived' })
    ok(revived?.structuredContent?.echo === 'revived', '空闲断线：随后的单次调用即重连成功（不先失败一次）')
    assertConnected(manager, 'iso-idle', '空闲断线：重连后连接 ready')
    await manager.disconnect('iso-idle')
    ok(manager.statusOf('iso-idle').status === 'disconnected', '显式 disconnect：立即变为 disconnected')
    const afterDisconnect = await manager.callTool('iso-idle', 'echo', { text: 'after-disconnect' })
    ok(afterDisconnect?.structuredContent?.echo === 'after-disconnect', '显式 disconnect：之后可重新握手')
  }

  {
    const manager = newManager([stdioConfig('iso-page', { YAN_CANCEL_FIXTURE_PAGE2_DELAY_MS: '350' })])
    const warm = await manager.listTools('iso-page')
    ok(warm.map((tool) => tool.name).join(',') === 'echo,slow,fail,die', '分页：完整分页拿到全部工具')
    const controller = new AbortController()
    const pending = manager.listTools('iso-page', { signal: controller.signal })
    await delay(120)
    controller.abort()
    const err = await rejectOf(pending)
    ok(isRequestCancelled(err), '分页取消：整次分页以调用级取消结束', err?.message)
    assertConnected(manager, 'iso-page', '分页取消：连接仍是 ready')
    const again = await manager.listTools('iso-page')
    ok(again.length === 4, '分页取消：之后同连接能重新完整分页')
  }

  {
    const manager = newManager([stdioConfig('iso-pre')])
    const controller = new AbortController()
    controller.abort()
    const err = await rejectOf(manager.callTool('iso-pre', 'echo', {}, { signal: controller.signal }))
    ok(isRequestCancelled(err), 'abort 前已取消：调用被拒', err?.message)
    ok(manager.statusOf('iso-pre').status === 'disconnected', 'abort 前已取消：没有为取消的调用建立连接')
  }

  {
    const manager = newManager([
      { id: 'raw', transport: 'stdio', command: process.execPath, args: [fixture, '--raw'], env: { YAN_CANCEL_FIXTURE_LOG: logPath, YAN_CANCEL_FIXTURE_RAW_DELAY_MS: '300' } }
    ])
    await manager.callTool('raw', 'echo', { text: 'warm' })
    const controller = new AbortController()
    let aState = 'pending'
    const a = manager.callTool('raw', 'slow', {}, { signal: controller.signal }).then(
      () => (aState = 'resolved'),
      () => (aState = 'rejected')
    )
    await delay(100)
    const b = await manager.callTool('raw', 'echo', { text: 'b' })
    ok(b?.structuredContent?.raw === true, 'raw：无视取消的服务端上，B 仍成功')
    controller.abort()
    await a
    ok(aState === 'rejected', 'raw：A 以取消结束')
    await delay(450)
    ok(aState === 'rejected', 'raw：迟到成功结果不会把已取消的调用变回成功')
    ok(logText().includes('cancelled-ignored') && logText().includes('late-result-sent'), 'raw：确实发生了「无视取消 + 迟到结果」')
    assertConnected(manager, 'raw', 'raw：迟到结果没有拆掉连接')
    const after = await manager.callTool('raw', 'echo', { text: 'after' })
    ok(after?.structuredContent?.raw === true, 'raw：之后同一连接继续可用')
  }

  {
    const manager = newManager([
      { id: 'raw-app', transport: 'stdio', command: process.execPath, args: [fixture, '--raw'], env: { YAN_CANCEL_FIXTURE_LOG: logPath, YAN_CANCEL_FIXTURE_RAW_DELAY_MS: '250' } }
    ])
    const warm = await manager.callTool('raw-app', 'echo', { text: 'warm' })
    const bPromise = manager.callTool('raw-app', 'slow', {}).then(
      (value) => ({ resolved: true, value }),
      (error) => ({ resolved: false, error })
    )
    await delay(30)
    const aErr = await rejectOf(manager.callTool('raw-app', 'app-error', {}))
    ok(
      aErr?.code === -32000 && /application error/.test(String(aErr?.message)),
      '应用 -32000：A 收到服务端应用错误（码值恰为 -32000）',
      aErr?.message
    )
    const b = await bPromise
    ok(
      b.resolved && b.value?.content?.[0]?.text === 'raw-late-done',
      '应用 -32000：并发的 B 没被拆，正常返回',
      b.resolved ? JSON.stringify(b.value).slice(0, 200) : b.error?.message
    )
    assertConnected(manager, 'raw-app', '应用 -32000：连接仍是 ready（没有仅凭码值判死）')
    const c = await manager.callTool('raw-app', 'echo', { text: 'c' })
    ok(
      c?.structuredContent?.raw === true && c.structuredContent.pid === warm?.structuredContent?.pid,
      '应用 -32000：随后 C 仍在同一 client（同进程）上正常调用',
      `warmPid=${warm?.structuredContent?.pid} cPid=${c?.structuredContent?.pid}`
    )
  }

  {
    const port = 39800 + Math.floor(Math.random() * 500)
    httpChild = spawn(process.execPath, [fixture, '--http'], {
      stdio: 'ignore',
      env: { ...process.env, YAN_CANCEL_FIXTURE_HTTP_PORT: String(port), YAN_CANCEL_FIXTURE_LOG: logPath }
    })
    ok(await netPort(port), 'HTTP：合成服务器真监听上了')
    const manager = newManager([{ id: 'iso-http', transport: 'http', url: `http://127.0.0.1:${port}/mcp` }])
    await manager.callTool('iso-http', 'echo', { text: 'warm' })
    const controller = new AbortController()
    let aState = 'pending'
    const a = manager.callTool('iso-http', 'slow', {}, { signal: controller.signal }).then(
      () => (aState = 'resolved'),
      () => (aState = 'rejected')
    )
    await delay(120)
    const b = await manager.callTool('iso-http', 'echo', { text: 'b' })
    ok(b?.structuredContent?.echo === 'b', 'HTTP 取消：同连接并发的 B 成功')
    controller.abort()
    await a
    ok(aState === 'rejected', 'HTTP 取消：A 以失败结束')
    assertConnected(manager, 'iso-http', 'HTTP 取消：连接仍是 ready')
    const after = await manager.callTool('iso-http', 'echo', { text: 'after' })
    ok(after?.structuredContent?.echo === 'after', 'HTTP 取消：之后同一连接继续可用')
    httpChild.kill('SIGTERM')
    httpChild = undefined
  }

  await delay(700)
  ok(unhandled.length === 0, '全程没有未处理的 Promise rejection', unhandled.map((e) => String(e?.message ?? e)).join(' | '))
  console.log(`\n按调用取消隔离：${checks} 项检查通过`)
} finally {
  process.off('unhandledRejection', onUnhandled)
  await Promise.all(managers.map((manager) => manager.close().catch(() => undefined)))
  if (httpChild) httpChild.kill('SIGTERM')
  await delay(200)
  await rm(root, { recursive: true, force: true })
}
}

async function crossContractSuite() {
let checks = 0
const failures = []
const ok = (condition, message, detail) => {
  checks += 1
  if (!condition) {
    failures.push(message)
    console.log(`✗ ${message}${detail !== undefined ? `（${detail}）` : ''}`)
  } else {
    console.log(`✓ ${message}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-app-cross-contract-'))
process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_PI_DIR = join(root, 'pi-agent')

async function loadTsBundle(contents, external = []) {
  const bundled = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    external,
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}

async function loadTsBundleFromFile(contents, external = []) {
  const dir = resolve('.tmp/A6R-cross-contract')
  await mkdir(dir, { recursive: true })
  const outfile = join(dir, `bundle-${Buffer.from(contents).toString('hex').slice(0, 16)}.mjs`)
  const bundled = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    external,
    logLevel: 'silent'
  })
  await writeFile(outfile, bundled.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(outfile).href)
}

const main = await loadTsBundle(
  "export * from './src/main/mcp/app-view-service';" +
    "export * from './src/main/mcp/app-view-audit';" +
    "export * from './src/main/mcp/app-resource-store';" +
    "export * from './src/main/mcp/app-view-trust';" +
    "export * from './src/shared/mcp-app-preview';"
)
const renderer = await loadTsBundle(
  "export * from './src/renderer/src/features/artifacts/mcp-app-frame-model';" +
    "export * from './src/renderer/src/features/artifacts/mcp-app-channel';" +
    "export * from './src/renderer/src/features/artifacts/model';"
)

const { McpAppViewService, McpAppViewAuditStore, mcpServerIdentityFingerprint } = main
const { McpAppChannel } = renderer

const tick = () => new Promise((done) => setTimeout(done, 60))
async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return true
    if (Date.now() - start > timeoutMs) return false
    await new Promise((done) => setTimeout(done, 5))
  }
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const HTML = '<!doctype html><html><body>app</body></html>'
const SERVER = 'srv'
const SERVER_CONFIG = { id: SERVER, transport: 'stdio', command: 'node', args: ['x.mjs'], enabled: true, ownedBy: 'inkstone' }
const FINGERPRINT = mcpServerIdentityFingerprint(SERVER_CONFIG)

function factsFor(sessionId, runnerId, generation) {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    projectId: 'p1',
    runnerId,
    generation,
    cwd: 'C:/proj'
  }
}

function makeRecord(overrides = {}) {
  return {
    callId: 'call-1',
    owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 3 },
    serverId: SERVER,
    toolName: 'read',
    text: 'MODEL-TEXT',
    resourceUri: 'ui://srv/app.html',
    ...overrides
  }
}

const appTool = { name: 'read', annotations: { readOnlyHint: true }, meta: { ui: { visibility: ['app', 'model'] } }, visibility: ['app', 'model'], modelVisible: true, appVisible: true, resourceUri: null }

function makeOutcome(text = 'ok') {
  return {
    result: { content: [{ type: 'text', text }], structuredContent: { chart: 1 }, _meta: { ui: { resourceUri: null } } },
    meta: { ui: { resourceUri: null } },
    structuredContent: { chart: 1 },
    resourceUri: null,
    uiCsp: null,
    isError: false,
    text
  }
}

function makeBridge(options = {}) {
  const state = {
    active: new Set(options.active ?? ['s1', 's2']),
    foreground: options.foreground ?? factsFor('s1', 'r1', 3),
    currentProject: options.currentProject ?? 'p1',
    hostCalls: [],
    askLog: [],
    late: options.late ?? null
  }
  const records = options.records ?? new Map([['call-1', makeRecord()]])
  const service = new McpAppViewService({
    proxy: {
      getCallResult: (callId) => records.get(callId) ?? null,
      snapshotStatus: () => ({ present: true, stale: false, needsRefresh: false }),
      registrableTools: options.registrableTools ?? (() => [{ serverId: SERVER }]),
      refresh: async (refreshOptions) => {
        state.refreshOptions = refreshOptions
        return options.refreshResult ?? { ok: true, toolCount: 1 }
      }
    },
    host: {
      listToolsWithMeta: async () => options.tools ?? [appTool],
      callToolWithMeta: async (serverId, toolName, args) => {
        state.hostCalls.push({ serverId, toolName, args })
        if (state.late) return state.late.promise
        return makeOutcome()
      },
      readResource: async (serverId, uri) => ({ uri, mimeType: 'text/html;profile=mcp-app', text: HTML, bytes: HTML.length, meta: null, uiCsp: null })
    },
    ownerGuard: { isActive: (owner) => state.active.has(owner.sessionId) },
    runtime: {
      resolve: async () => state.foreground,
      currentProject: async () => state.currentProject
    },
    ask: (request) => {
      state.askLog.push(request)
      return Promise.resolve({ choice: 'once' })
    },
    audit: new McpAppViewAuditStore({ dir: join(root, `audit-${options.name ?? 'default'}`) }),
    serverConfigOf: () => SERVER_CONFIG,
    fetchResource: async ({ projectId }) => {
      state.fetchProjectId = projectId
      return { html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: HTML.length, csp: "default-src 'none'" }
    }
  })
  return { state, service }
}

function attachChannel(service, instanceId, overrides = {}) {
  const win = fakeWindow()
  const frame = fakeFrame()
  const api = {
    calls: [],
    dispatch(instanceIdArg, message) {
      api.calls.push(message)
      return service.dispatch(instanceIdArg, message)
    }
  }
  const channel = new McpAppChannel({
    instanceId,
    api,
    window: win,
    getFrame: () => frame,
    ...overrides
  })
  channel.attach()
  return { win, frame, api, channel }
}

const rpc = (method, params, id) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })
const fromFrame = (frame, message) => ({ data: message, origin: 'null', source: frame })

{
  const { state, service } = makeBridge({ name: 'handshake' })
  const prepared = await service.prepare('call-1')
  ok(prepared.kind === 'ready', '正式 service.prepare 返回 ready 实例', prepared.kind)
  ok(state.fetchProjectId === 'p1', 'prepare 用 owner.projectId 取资源（不是目标 scope）')

  const { win, frame, api, channel } = attachChannel(service, prepared.instanceId)
  const other = fakeFrame()

  win.emit(fromFrame(frame, rpc('ui/initialize', { protocolVersion: 1 }, 11)))
  await waitFor(() => channel.getPhase() === 'ready')
  ok(api.calls.length === 1 && api.calls[0].method === 'ui/initialize', 'initialize 只派发给 host 一次')
  const envelope = frame.posted.at(-1).message
  ok(envelope.jsonrpc === '2.0' && envelope.id === 11, 'host 信封带 jsonrpc/id（单层）')
  ok(envelope.result?.hostContext?.platform === 'desktop', 'initialize 结果在顶层 result')
  ok(envelope.result?.result === undefined, 'ui/initialize 响应只有一层，没有被再包成 result.result')
  ok(channel.getPhase() === 'ready', '合法 initialize 应答后进入 ready')

  win.emit(fromFrame(frame, rpc('vendor/unknown', {}, 12)))
  await waitFor(() => frame.posted.at(-1)?.message?.error?.code === -32601)
  const unknown = frame.posted.at(-1).message
  ok(unknown.error?.code === -32601 && unknown.result === undefined, '未知方法保留顶层 error -32601 unsupported')

  const before = api.calls.length
  win.emit(fromFrame(other, rpc('tools/call', { name: 'read', arguments: {} }, 13)))
  await tick()
  ok(api.calls.length === before, '非本框 source 的消息不派发')
  ok(other.posted.length === 0, '结果不会回投给非本框')

  const dup = rpc('tools/call', { name: 'read', arguments: {} }, 14)
  win.emit(fromFrame(frame, dup))
  win.emit(fromFrame(frame, dup))
  await waitFor(() => state.hostCalls.length >= 1)
  await tick()
  ok(state.hostCalls.length === 1, '同代重复 id 只执行一次', String(state.hostCalls.length))
}

{
  const { state, service } = makeBridge({ name: 'reject-init' })
  const prepared = await service.prepare('call-1')
  state.active.delete('s1')
  const { win, frame, channel } = attachChannel(service, prepared.instanceId)
  win.emit(fromFrame(frame, rpc('ui/initialize', {}, 21)))
  await waitFor(() => Boolean(frame.posted.at(-1)?.message?.error))
  const envelope = frame.posted.at(-1).message
  ok(envelope.error?.code === -32001 && envelope.result === undefined, 'host 拒绝 initialize 保留顶层 error，不转 result')
  ok(channel.getPhase() !== 'ready', '错误 initialize 不进 ready')
  ok(state.hostCalls.length === 0, '未成功 initialize 不放行 tools/call')
}

{
  const { state, service } = makeBridge({ name: 'tools' })
  const prepared = await service.prepare('call-1')
  const { win, frame, channel } = attachChannel(service, prepared.instanceId)
  win.emit(fromFrame(frame, rpc('ui/initialize', {}, 31)))
  await waitFor(() => channel.getPhase() === 'ready')
  win.emit(fromFrame(frame, rpc('tools/call', { name: 'read', arguments: { q: 'x' } }, 32)))
  await waitFor(() => Boolean(frame.posted.at(-1)?.message?.result?.structuredContent))
  const envelope = frame.posted.at(-1).message
  ok(envelope.result?.structuredContent?.chart === 1, 'structuredContent 回到本框')
  ok(envelope.result?._meta !== undefined, '_meta 回到本框')
  ok(state.hostCalls.length === 1 && state.hostCalls[0].toolName === 'read', '审批通过后真正执行一次工具', String(state.hostCalls.length))
  ok(channel.getPhase() === 'ready', '工具调用不改变握手状态')
}

{
  const { state, service } = makeBridge({ name: 'audit' })
  const prepared = await service.prepare('call-1')
  const { win, frame, channel } = attachChannel(service, prepared.instanceId)
  win.emit(fromFrame(frame, rpc('ui/initialize', {}, 41)))
  await waitFor(() => channel.getPhase() === 'ready')
  win.emit(fromFrame(frame, rpc('tools/call', { name: 'read', arguments: { q: 'x' } }, 42)))
  await waitFor(() => state.hostCalls.length === 1)
  await waitFor(async () => {
    const entries = await service.audit('call-1')
    return entries.some((entry) => entry.phase === 'completed')
  })
  const inA = await service.audit('call-1')
  ok(inA.some((entry) => entry.phase === 'completed'), '会话 A 可读本机审计（真实临时 JSONL 落盘）')

  state.foreground = factsFor('s2', 'r2', 1)
  const inB = await service.audit('call-1')
  ok(inB.length === 0, '前台 B 读后台 A 审计返回空（不跨会话）')

  state.foreground = factsFor('s1', 'r1', 3)
  const restored = await service.audit('call-1')
  ok(restored.length >= 3, '恢复同 sessionFile 可读本机历史审计（绝不重跑 tool）')
}

{
  const late = deferred()
  const { state, service } = makeBridge({ name: 'late', late })
  const prepared = await service.prepare('call-1')
  const { win, frame, channel } = attachChannel(service, prepared.instanceId)
  win.emit(fromFrame(frame, rpc('ui/initialize', {}, 51)))
  await waitFor(() => channel.getPhase() === 'ready')
  win.emit(fromFrame(frame, rpc('tools/call', { name: 'read', arguments: {} }, 52)))
  await waitFor(() => state.hostCalls.length === 1)
  const postedBefore = frame.posted.length
  channel.nextGeneration()
  late.resolve(makeOutcome('late'))
  await tick()
  ok(frame.posted.length === postedBefore, '换代（iframe reload）后旧代迟到结果不回投')
  ok(channel.getPhase() === 'idle', '换代把握手重置为 idle')
}

{
  const { service } = makeBridge({ name: 'port' })
  const prepared = await service.prepare('call-1')
  const { win, frame, channel } = attachChannel(service, prepared.instanceId)
  const port = fakePort()
  win.emit({ ...fromFrame(frame, rpc('ui/initialize', {}, 61)), ports: [port] })
  await waitFor(() => port.posted.length === 1)
  ok(port.started, '本框初始化采纳 MessagePort 并 start')
  ok(port.posted.length === 1, 'initialize 应答经端口回投')
  ok(frame.posted.length === 0, '采纳端口后不再走 window.postMessage')
  channel.dispose()
  ok(port.closed, 'dispose 关闭端口')
}

{
  const proxy = await loadTsBundleFromFile("export * from './src/main/mcp/app-proxy-service';", [
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/*'
  ])
  const appHostMark = { at: '2026-10-16T00:00:00.000Z', natives: [{ path: '/pi/mcp.json', name: 'x', entry: {}, fingerprint: 'fp' }] }
  const server = (id, projectScope) => ({
    id,
    transport: 'stdio',
    command: 'x',
    enabled: true,
    ownedBy: 'inkstone',
    appHost: appHostMark,
    ...(projectScope ? { projectScope } : {})
  })
  const listCalls = []
  const host = {
    listManagedServers: () => [server('global-app'), server('proj-a-app', 'p-a'), server('proj-b-app', 'p-b')],
    listToolsWithMeta: async (serverId, options) => {
      listCalls.push({ serverId, projectId: options?.projectId })
      return [{ name: 't', modelVisible: true, appVisible: false, visibility: ['model'] }]
    },
    callToolWithMeta: async () => {
      throw new Error('unused')
    },
    statusOf: () => ({ status: 'ready' })
  }
  const scoped = new proxy.McpAppProxyService({ dir: join(root, 'proxy'), host })

  await scoped.refresh({ callerProjectId: 'p-a' })
  ok(listCalls.every((entry) => entry.serverId !== 'proj-b-app'), '项目 A 刷新不启动 B 服务')
  ok(listCalls.some((entry) => entry.serverId === 'proj-a-app' && entry.projectId === 'p-a'), '项目 A 刷新把真实 caller 带到 listTools（不从目标 scope 自证）')

  listCalls.length = 0
  const empty = await scoped.refresh({ serverIds: [], callerProjectId: 'p-a' })
  ok(empty.written === false && listCalls.length === 0, '显式空 serverIds = 0 目标，不启动任何服务')
  ok(empty.error === proxy.MCP_APP_PROXY_NO_TARGETS, '空目标返回明确 no_targets')

  const failing = new proxy.McpAppProxyService({
    dir: join(root, 'proxy-fail'),
    host: {
      listManagedServers: () => {
        throw new Error('mcp-servers.json 读取失败')
      },
      listToolsWithMeta: async () => [],
      callToolWithMeta: async () => {
        throw new Error('unused')
      },
      statusOf: () => ({ status: 'disconnected' })
    }
  })
  let failed = false
  try {
    await failing.refresh({ callerProjectId: 'p-a' })
  } catch {
    failed = true
  }
  ok(failed, '配置读取失败：刷新默认拒绝，不写出半份快照')
}

{
  const { service } = makeBridge({
    name: 'snapshot',
    currentProject: 'p-a',
    registrableTools: () => [{ serverId: 'global' }, { serverId: 'a', projectScope: 'p-a' }, { serverId: 'b', projectScope: 'p-b' }]
  })
  const snap = await service.snapshot()
  ok(snap.toolCount === 2, 'snapshot 只计当前项目可见（2 条），不泄 B 的条目数', String(snap.toolCount))
  const refreshed = await service.refresh()
  ok(refreshed.ok === true && refreshed.toolCount === 1, 'refresh 走代理刷新接口')
}

await rm(root, { recursive: true, force: true })

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
}

async function finalWiringSuite() {
let checks = 0
const failures = []
const ok = (condition, message, detail) => {
  checks += 1
  if (!condition) {
    failures.push(message)
    console.log(`✗ ${message}${detail !== undefined ? `（${detail}）` : ''}`)
  } else {
    console.log(`✓ ${message}`)
  }
}
const eq = (actual, expected, message) => ok(Object.is(actual, expected), message, `实际 ${JSON.stringify(actual)}`)

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-app-final-wiring-'))
process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_MCP_SERVERS_FILE = join(root, 'mcp-servers.json')

async function loadTsBundle(contents) {
  const bundled = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}

const main = await loadTsBundle(
  "export * from './src/main/mcp/app-view-service';" +
    "export * from './src/main/mcp/app-view-audit';" +
    "export * from './src/main/mcp/app-resource-store';" +
    "export * from './src/main/mcp/app-view-trust';" +
    "export * from './src/main/mcp/app-runtime-ownership';" +
    "export * from './src/main/attention/tray-animation';" +
    "export * from './src/shared/mcp-app-preview';"
)
const renderer = await loadTsBundle(
  "export * from './src/renderer/src/features/artifacts/mcp-app-channel';" +
    "export * from './src/renderer/src/features/artifacts/mcp-app-frame-model';"
)

const {
  McpAppViewService,
  McpAppViewAuditStore,
  McpAppResourceStore,
  createMcpAppViewRuntime,
  mayHoldMcpAppWithLegacy,
  createTrayAnimationPlayer,
  MCP_APP_SANDBOX,
  buildMcpAppCsp,
  mcpAppErrorHeaders,
  mcpAppResponseHeaders,
  parseMcpAppUrl
} = main
const { McpAppChannel, MCP_APP_FRAME_SANDBOX, MCP_APP_FRAME_ALLOW, MCP_APP_FRAME_REFERRER_POLICY } = renderer

const HTML = '<!doctype html><html><body>app</body></html>'
const SERVER = 'srv'
const SERVER_CONFIG = { id: SERVER, transport: 'stdio', command: 'node', args: ['x.mjs'], enabled: true, ownedBy: 'inkstone' }

const facts = (sessionId, runnerId, generation, projectId = 'p1') => ({
  sessionId,
  sessionFile: `/sessions/${sessionId}.jsonl`,
  projectId,
  runnerId,
  generation,
  cwd: 'C:/proj'
})
const FACTS_A = facts('s1', 'r1', 3)
const FACTS_B = facts('s2', 'r2', 7)

const makeRecord = (overrides = {}) => ({
  callId: 'call-1',
  owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 3 },
  serverId: SERVER,
  toolName: 'read',
  text: 'MODEL-TEXT',
  resourceUri: 'ui://srv/app.html',
  ...overrides
})

const appTool = {
  name: 'read',
  annotations: { readOnlyHint: true },
  meta: { ui: { visibility: ['app', 'model'] } },
  visibility: ['app', 'model'],
  modelVisible: true,
  appVisible: true,
  resourceUri: null
}

const outcome = (text = 'ok') => ({
  result: { content: [{ type: 'text', text }], structuredContent: { chart: 1 }, _meta: { ui: { resourceUri: null } } },
  meta: { ui: { resourceUri: null } },
  structuredContent: { chart: 1 },
  resourceUri: null,
  uiCsp: null,
  isError: false,
  text
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeAssembly({ name = 'default', foreground = FACTS_A, records, hostTools, deferredOutcome } = {}) {
  const state = { foreground, last: foreground ?? null, refreshes: [], askLog: [], afterCalls: [] }
  const callRecords = records ?? new Map([['call-1', makeRecord()]])

  const source = {
    current: () => state.foreground,
    currentProject: () => state.foreground?.projectId ?? null,
    isActive: (owner) => {
      const f = state.foreground
      if (!f) return false
      return (
        owner.runnerId === f.runnerId &&
        owner.sessionId === f.sessionId &&
        owner.sessionFile === f.sessionFile &&
        owner.projectId === f.projectId &&
        owner.generation === f.generation
      )
    }
  }
  const { runtime, ownerGuard } = main.createMcpAppViewRuntime(source)

  const service = new McpAppViewService({
    proxy: {
      getCallResult: (callId) => callRecords.get(callId) ?? null,
      snapshotStatus: () => ({ present: true, stale: false, needsRefresh: false }),
      registrableTools: () => [{ serverId: SERVER }, { serverId: SERVER, projectScope: 'p1' }, { serverId: SERVER, projectScope: 'p2' }],
      refresh: async (options) => {
        state.refreshes.push(options)
        return { ok: true, toolCount: 1 }
      }
    },
    host: {
      listToolsWithMeta: async () => hostTools ?? [appTool],
      callToolWithMeta: async () => (deferredOutcome ? deferredOutcome.promise : outcome()),
      readResource: async (serverId, uri) => ({ uri, mimeType: 'text/html;profile=mcp-app', text: HTML, bytes: HTML.length, meta: null, uiCsp: null })
    },
    runtime,
    ownerGuard,
    ask: (request) => {
      state.askLog.push(request)
      return Promise.resolve({ choice: 'once' })
    },
    audit: new McpAppViewAuditStore({ dir: join(root, `audit-${name}`) }),
    serverConfigOf: () => SERVER_CONFIG,
    fetchResource: async () => ({ html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: HTML.length, csp: "default-src 'none'" })
  })

  const syncForeground = (next) => {
    const previous = state.last
    state.foreground = next
    state.last = next
    if (!previous) return
    if (
      next &&
      previous.runnerId === next.runnerId &&
      previous.sessionId === next.sessionId &&
      previous.sessionFile === next.sessionFile &&
      previous.generation === next.generation
    ) {
      return
    }
    service.invalidateRunnerId(previous.runnerId)
    service.invalidateSession(previous.sessionId)
  }

  return { state, service, syncForeground }
}

const call = (instanceId, method, params = {}, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  params
})

{
  const { service } = makeAssembly({ name: 'valid' })
  const prepared = await service.prepare('call-1')
  ok(prepared.kind === 'ready', '正式装配：当前前台会话的有效调用 prepare 成功', prepared.kind)
  ok(typeof prepared.instanceId === 'string' && prepared.instanceId.length > 0, 'prepare 返回实例号')
  ok(parseMcpAppUrl(prepared.url) !== null, 'prepare 返回受控 inkstone-app 地址', prepared.url)

  const init = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'ui/initialize', {}, 10))
  ok(init && init.result && typeof init.result === 'object', 'initialize 返回单层 result 信封')
  const tool = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 11))
  ok(tool && tool.result && tool.result.structuredContent && tool.result.structuredContent.chart === 1, 'tools/call 返回 structuredContent（只回本框）')
  const audit = await service.audit('call-1')
  const phases = audit.map((entry) => entry.phase)
  ok(phases.includes('requested') && phases.includes('approved') && phases.includes('completed'), '真实审计落盘含 requested/approved/completed', phases.join(','))
  ok(audit.every((entry) => entry.summary && !('rawMeta' in entry) && !('structuredContent' in entry)), '审计只存安全摘要，不含 rawMeta/structuredContent')

  const snap = await service.snapshot()
  ok(snap.toolCount === 2, 'snapshot 只计当前项目可见条目（全局 + p1 = 2）', snap.toolCount)
  const refreshed = await service.refresh()
  ok(refreshed.ok === true && refreshed.toolCount === 1, 'refresh 走正式代理刷新入口', JSON.stringify(refreshed))
}

{
  const { service, syncForeground } = makeAssembly({ name: 'switch' })
  const prepared = await service.prepare('call-1')
  ok(prepared.kind === 'ready', '切换前 A 实例可用')
  syncForeground(FACTS_B)

  const oldDispatch = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 21))
  ok(oldDispatch && oldDispatch.error && oldDispatch.error.code === -32600, '切到 B 后旧 A 实例 dispatch 被拒（实例已注销）', JSON.stringify(oldDispatch))
  const oldAudit = await service.audit('call-1')
  eq(oldAudit.length, 0, '切到 B 后读不到 A 会话的审计（不跨会话）')

  const { service: bare } = makeAssembly({ name: 'switch-gate' })
  const barePrepared = await bare.prepare('call-1')
  ok(barePrepared.kind === 'ready', '未主动失效时 A 实例先建立')
  const gate = makeAssembly({ name: 'switch-gate-2' })
  const prepared2 = await gate.service.prepare('call-1')
  gate.state.foreground = FACTS_B
  const gated = await gate.service.dispatch(prepared2.instanceId, call(prepared2.instanceId, 'tools/call', { name: 'read', arguments: {} }, 22))
  ok(gated && gated.error && gated.error.code === -32001, '前台切走后 ownerGuard 拒绝 tools/call（不靠 runtimeOf 旧 runner）', JSON.stringify(gated))
  void bare
}

{
  const late = deferred()
  const { service, syncForeground } = makeAssembly({ name: 'late', deferredOutcome: late })
  const prepared = await service.prepare('call-1')
  const pending = service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 31))
  await new Promise((done) => setTimeout(done, 30))
  syncForeground(FACTS_B)
  late.resolve(outcome('LATE'))
  const result = await pending
  ok(result && result.error, '切换后晚到的工具结果被丢弃（返回错误）', JSON.stringify(result))
  const audit = await service.audit('call-1')
  eq(audit.length, 0, '晚到结果不会写进 B 的会话审计')
}

{
  const cases = [
    ['调用记录会话不符', { owner: { sessionId: 'sX', projectId: 'p1', runnerId: 'r1', epoch: 3 } }],
    ['调用记录 runner 不符', { owner: { sessionId: 's1', projectId: 'p1', runnerId: 'rX', epoch: 3 } }],
    ['调用记录项目不符', { owner: { sessionId: 's1', projectId: 'pX', runnerId: 'r1', epoch: 3 } }],
    ['调用记录代次不符', { owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 4 } }]
  ]
  for (const [label, overrides] of cases) {
    const { service } = makeAssembly({ name: `mismatch-${label}`, records: new Map([['call-1', makeRecord(overrides)]]) })
    const prepared = await service.prepare('call-1')
    ok(prepared.kind === 'error', `${label}：prepare 明确拒绝`, prepared.kind)
  }

  const { service, state } = makeAssembly({ name: 'project-gate' })
  const prepared = await service.prepare('call-1')
  await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'ui/initialize', {}, 40))
  const before = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 41))
  ok(before && before.result, '项目一致时正常调用', JSON.stringify(before))
  state.foreground = { ...FACTS_A, projectId: 'p2' }
  const after = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 42))
  ok(after && after.error && after.error.code === -32001, 'projectId 变化后 ownerGuard 拒绝（full-match）', JSON.stringify(after))
  const snap = await service.snapshot()
  ok(snap.toolCount === 2, 'snapshot 用同源 currentProject 计数（p2 → 全局 + p2）', snap.toolCount)
  await service.refresh()
}

{
  const { service } = makeAssembly({ name: 'init-service' })
  const prepared = await service.prepare('call-1')
  const early = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 51))
  ok(early && early.error && early.error.code === -32002, 'service：未初始化先 tools/call 被拒（-32002）', JSON.stringify(early))

  const win = fakeWindow()
  const frame = fakeFrame()
  const dispatched = []
  const channel = new McpAppChannel({
    instanceId: 'inst-x',
    api: {
      dispatch: async (_instanceId, message) => {
        dispatched.push(message)
        return { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: '初始化失败' } }
      }
    },
    window: win,
    getFrame: () => frame
  })
  channel.attach()
  win.emit({ data: call('inst-x', 'ui/initialize', {}, 61), origin: 'null', source: frame })
  await new Promise((done) => setTimeout(done, 20))
  ok(channel.getPhase() !== 'ready', 'channel：host 返回 error 的 initialize 不进入 ready', channel.getPhase())
  const blocked = await new Promise((resolve) => {
    const before = frame.posted.length
    win.emit({ data: call('inst-x', 'tools/call', { name: 'read', arguments: {} }, 62), origin: 'null', source: frame })
    setTimeout(() => resolve(frame.posted.slice(before)), 10)
  })
  ok(blocked.some((item) => item.message && item.message.error && item.message.error.code === -32002), 'channel：未 ready 的 tools/call 本地拒绝（-32002）')
  channel.dispose()
}

{
  const { service } = makeAssembly({ name: 'renderer-gone' })
  const prepared = await service.prepare('call-1')
  ok(prepared.kind === 'ready', 'renderer 失效前实例存在')
  service.close()
  const after = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 71))
  ok(after && after.error && after.error.code === -32600, 'renderer 异常 / close 后实例被清，dispatch 拒绝', JSON.stringify(after))

  const { service: svc2 } = makeAssembly({ name: 'reclaim' })
  const p2 = await svc2.prepare('call-1')
  svc2.invalidateRunnerId('r1')
  const afterReclaim = await svc2.dispatch(p2.instanceId, call(p2.instanceId, 'tools/call', { name: 'read', arguments: {} }, 72))
  ok(afterReclaim && afterReclaim.error, '回收 runner 后绑定它的实例立即失效')
}

{
  const server = { serverId: SERVER, scope: 'global' }
  const exited = { processRunning: false, conn: 'exited', projectId: null }
  eq(
    mayHoldMcpAppWithLegacy({ ...exited, legacyMcpServices: null }, server),
    true,
    'legacy 事实缺失（null）按「可能持有」，不放行新连接'
  )
  eq(
    mayHoldMcpAppWithLegacy({ ...exited, legacyMcpServices: [{ serverId: SERVER, status: 'ready' }] }, server),
    true,
    'pi 已退出但 legacy client 仍 ready → 仍算持有'
  )
  eq(
    mayHoldMcpAppWithLegacy({ ...exited, legacyMcpServices: [{ serverId: 'other', status: 'ready' }] }, server),
    false,
    '确定退出且目标服务无 legacy 连接 → 才排除持有'
  )
  eq(
    mayHoldMcpAppWithLegacy({ processRunning: true, conn: 'ready', projectId: null, legacyMcpServices: [] }, server),
    true,
    '存活新的 pi 实例仍可能持有（新会话不被误排除）'
  )
}

{
  eq(MCP_APP_FRAME_SANDBOX, 'allow-scripts', 'iframe sandbox 固定 allow-scripts')
  ok(!String(MCP_APP_FRAME_SANDBOX).includes('allow-same-origin'), 'sandbox 不含 allow-same-origin')
  eq(MCP_APP_SANDBOX, 'allow-scripts', '共享 sandbox 常量与渲染端一致')
  eq(MCP_APP_FRAME_REFERRER_POLICY, 'no-referrer', 'referrerPolicy 固定 no-referrer')
  ok(String(MCP_APP_FRAME_ALLOW).split(';').every((item) => item.trim() === '' || /'none'$/.test(item.trim())), 'allow 权限全关（逐项 none）', MCP_APP_FRAME_ALLOW)

  const csp = buildMcpAppCsp({})
  ok(csp.includes('connect-src \'none\''), '首版 CSP connect-src 为 none（拒绝网络声明）')
  ok(csp.includes("frame-src 'none'") && csp.includes("object-src 'none'") && csp.includes("base-uri 'none'"), 'CSP 关闭 frame/object/base')
  ok(csp.includes('sandbox allow-scripts'), 'CSP 末尾带 sandbox allow-scripts')
  const headers = mcpAppResponseHeaders(csp)
  ok(headers['X-Content-Type-Options'] === 'nosniff' && headers['Referrer-Policy'] === 'no-referrer', '响应带 nosniff / no-referrer')
  ok(String(mcpAppErrorHeaders()['Permissions-Policy']).includes('camera=()'), '错误页也带关闭的 Permissions-Policy')

  let fetchCount = 0
  const store = new McpAppResourceStore({
    ownerGuard: { isActive: () => true },
    fetchResource: async () => {
      fetchCount += 1
      return { html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: HTML.length, csp: "default-src 'none'" }
    }
  })
  const ownerA = { serverId: SERVER, sessionId: 's1', sessionFile: '/s1.jsonl', projectId: 'p1', runnerId: 'r1', generation: 3, toolCallId: 'call-1' }
  const ownerB = { ...ownerA, sessionId: 's2', sessionFile: '/s2.jsonl', runnerId: 'r2' }
  const prepared = await store.prepare({ serverId: SERVER, resourceUri: 'ui://srv/app.html', owner: ownerA })
  ok(prepared.ok === true && typeof prepared.instanceId === 'string', 'store：owner 有效时登记实例')
  const wrong = store.read(prepared.url, { owner: ownerB })
  ok(wrong.ok === false && wrong.error === 'owner', 'store：跨 owner 读被拒', wrong.error)
  const revoked = new McpAppResourceStore({ ownerGuard: { isActive: () => false }, fetchResource: async () => ({ html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: HTML.length, csp: 'x' }) })
  const denied = await revoked.prepare({ serverId: SERVER, resourceUri: 'ui://srv/app.html', owner: ownerA })
  ok(denied.ok === false && denied.error === 'revoked', 'store：owner 不活跃时 fail-closed，不抓取', denied.error)
  void fetchCount
}

{
  let now = 0
  const timers = new Set()
  const applied = []
  const player = createTrayAnimationPlayer({
    assets: (state, theme) => ({ frames: [{ image: `${state}-0`, durationMs: 25 }, { image: `${state}-1`, durationMs: 25 }], static: `${state}-static` }),
    theme: () => 'on-light',
    apply: (image) => applied.push(image),
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => {
        const handle = { fn, at: now + ms }
        timers.add(handle)
        return handle
      },
      clearTimeout: (handle) => timers.delete(handle)
    }
  })
  player.setState('running')
  eq(player.animating(), false, '运动偏好未上报时默认 static（不播放）')
  eq(player.frameIndex(), 0, '默认 static 显示静止帧')
  ok(applied.includes('running-static'), '默认 static 应用 running 静态图')

  now = 1000
  player.setMotionAllowed(true)
  eq(player.animating(), true, '收到允许后开始播放')
  player.setMotionAllowed(false)
  eq(player.animating(), false, '用户 reduce 立即停止')
  eq(player.frameIndex(), 0, '停止后回到静态第一帧')

  player.setState('waiting')
  eq(player.animating(), false, '等待态但 motion 关闭时仍 static')
  player.dispose()

  let assetReads = 0
  const p2 = createTrayAnimationPlayer({
    assets: () => {
      assetReads += 1
      return { frames: [{ image: 'a', durationMs: 10 }, { image: 'b', durationMs: 10 }], static: 's' }
    },
    theme: () => 'on-light',
    apply: () => undefined,
    clock: { now: () => now, setTimeout: () => ({ id: 1 }), clearTimeout: () => undefined }
  })
  p2.setState('running')
  p2.setMotionAllowed(true)
  const readsAfterStart = assetReads
  p2.setState('running')
  eq(assetReads, readsAfterStart, '同一状态重复 setState 不重新取素材')
  p2.dispose()
}

{
  const index = await readFile('src/main/index.ts', 'utf8')
  const preload = await readFile('src/preload/index.ts', 'utf8')
  const sharedIpc = await readFile('src/shared/ipc.ts', 'utf8')
  const htmlPreview = await readFile('src/main/html-artifact-preview.ts', 'utf8')
  const protocol = await readFile('src/main/mcp/app-protocol.ts', 'utf8')

  ok(index.includes('registerMcpAppViewIpc(ipc, { service: () => mcpAppViewService })'), 'index：注册正式 view IPC（地址只经主窗口白名单）')
  ok(index.includes('createMcpAppViewRuntime({') && index.includes('registerMcpAppProtocol(mcpAppViewService.resourceStore())'), 'index：正式组装 runtime 并在 ready 后注册协议 handler')
  ok(
    index.includes('owner.runnerId === facts.runnerId') &&
      index.includes('owner.sessionId === facts.sessionId') &&
      index.includes('owner.sessionFile === facts.sessionFile') &&
      index.includes('owner.projectId === facts.projectId') &&
      index.includes('owner.generation === facts.generation'),
    'index：ownerGuard 对当前前台全字段核对'
  )
  ok(index.includes('currentProject: (): string | null => appViewForegroundFacts()?.projectId ?? null'), 'index：currentProject 与 current 同源前台项目')
  ok(index.includes('mcpAppViewService?.close()'), 'index：renderer 失效 / 退出主动 close 实例')
  ok(index.indexOf('mcpAppViewService?.invalidateRunnerId(id)') >= 0, 'index：回收实例时 invalidate 绑定视图')
  ok(index.includes("ipcMain.on('yan:motion-preference'") && index.includes('typeof reduced !== \'boolean\''), 'index：运动偏好 IPC 校验主窗口且严格 boolean')
  ok(index.includes('let trayMotionAllowed = false'), 'index：运动偏好默认 false（静态）')
  ok(index.includes('ensureTrayAssets()') && index.includes('trayAnimationAssets:') && index.includes('motionAllowed: () => trayMotionAllowed'), 'index：启动预载托盘素材并接入 attention 端口')

  ok(preload.includes('mcpApps: {') && preload.includes('MCP_APP_VIEW_CHANNELS.prepare'), 'preload：暴露 mcpApps，通道名来自共享唯一源')
  ok(preload.includes("ipcRenderer.send('yan:motion-preference', Boolean(reduced))"), 'preload：运动偏好单向 send 且转成 boolean')
  ok(sharedIpc.includes('mcpApps: McpAppViewApi') && sharedIpc.includes('setMotionPreference(reduced: boolean): void'), 'shared/ipc：YanBridge 含 mcpApps 与 setMotionPreference')

  ok(htmlPreview.includes('parseMcpAppUrl(details.url) !== null'), '离线 HTML 拦截合并放行受控 inkstone-app 子框（不新增第二个 onBeforeRequest）')
  ok(!protocol.includes('onBeforeRequest'), 'MCP App 协议不注册自己的 webRequest 监听（不与离线成果争单监听）')
  ok(protocol.includes('store.read(request.url, { method: request.method })') && protocol.includes('mcpAppResponseHeaders(result.csp)'), '协议 handler 只读 store，经共享头沿用严格离线 CSP')
}

await rm(root, { recursive: true, force: true }).catch(() => undefined)
console.log(``)
if (failures.length) {
  console.log(`MCP App 生产装配小测：${checks} 项，${failures.length} 项失败`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`MCP App 生产装配小测：${checks} 项全部通过`)
}

console.log('\n=====mcp-app-switch =====')
await isolated(switchSuite)
console.log('\n=====mcp-app-switch-runtime =====')
await isolated(switchRuntimeSuite)
console.log('\n=====mcp-app-ownership =====')
await isolated(ownershipSuite)
console.log('\n=====mcp-app-runtime-ownership =====')
await isolated(runtimeOwnershipSuite)
console.log('\n=====mcp-app-runtime-integration =====')
await isolated(runtimeIntegrationSuite)
console.log('\n=====mcp-app-cancel-isolation =====')
await isolated(cancelIsolationSuite)
console.log('\n=====mcp-app-cross-contract =====')
await isolated(crossContractSuite)
console.log('\n=====mcp-app-final-wiring =====')
await isolated(finalWiringSuite)

process.exit(0)
