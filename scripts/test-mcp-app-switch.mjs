import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

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
