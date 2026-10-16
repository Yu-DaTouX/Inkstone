#!/usr/bin/env node
/**
 * WP-53 同步接线层（`src/main/ipc/sync-ipc.ts`）的合成验收。
 *
 *   node scripts/test-v3-sync-ipc.mjs
 *
 * 现场用 esbuild 打包真实生产模块（无 Electron 依赖），不启动 Electron、
 * 不连 pi、不调用真实模型、不读写用户真实数据、不访问网络。
 *
 * 覆盖：
 *   1. 未配置状态：status.configured=false，不创建同步服务；
 *   2. 配置 / 清除：目录对话框注入、显式路径、null 清除；
 *   3. 立即同步：真实计数透传、lastSync 落盘、未配置时可读错误；
 *   4. 冲突：列出带预览、resolve 透传 id 与三种方式、非法输入与异常不抛出；
 *   5. 导出 / 导入：路径由对话框注入，导入生成新会话、不覆盖同名；
 *   6. 启动同步 runStartupSync：失败只记日志、不抛异常、正常时写 lastSync；
 *   7. 真实 SyncService 的 resolveConflict：remote 采用他端、both 留两份并清冲突。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/* ── 现场编译生产模块 ───────────────────────────────────────── */
const bundles = []
async function bundle(entry) {
  const outfile = join(tmpdir(), `yan-v3-${randomUUID()}.mjs`)
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning'
  })
  bundles.push(outfile)
  return import(pathToFileURL(outfile).href)
}

const ipcMod = await bundle('../src/main/ipc/sync-ipc.ts')
const syncMod = await bundle('../src/main/sync/index.ts')
const { registerSyncIpc, runStartupSync } = ipcMod
const { SyncService, SyncConfigStore } = syncMod

/* ── 微型断言 / 报告 ────────────────────────────────────────── */
const report = { pass: 0, fail: 0 }
function section(name) {
  process.stdout.write(`\n▌${name}\n`)
}
function ok(message) {
  report.pass += 1
  process.stdout.write(`  ✓ ${message}\n`)
}
function fail(message, error) {
  report.fail += 1
  process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
}
async function check(message, fn) {
  try {
    await fn()
    ok(message)
  } catch (error) {
    fail(message, error)
  }
}

/* ── 捕获注册器与假依赖 ─────────────────────────────────────── */
function captureRegistrar() {
  const handlers = new Map()
  return {
    ipc: {
      handle: (channel, fn) => handlers.set(channel, fn),
      rawHandle: () => undefined
    },
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`未注册的通道：${channel}`)
      return handler(...args)
    }
  }
}

function makeReport(partial = {}) {
  return {
    ok: true,
    deviceId: 'dev-a',
    deviceName: 'DEV-A',
    pushed: ['settings'],
    pulled: ['prompt:review'],
    conflicts: [],
    skipped: ['/tmp/bad.json：坏文件'],
    errors: [],
    at: 1700000000000,
    ...partial
  }
}

function makeConflict(partial = {}) {
  return {
    id: 'conflict-1',
    key: 'settings',
    kind: 'settings',
    detectedAt: 1700000000000,
    localDeviceId: 'dev-a',
    localDeviceName: 'DEV-A',
    localModifiedAt: 1699999999000,
    localHash: 'a'.repeat(64),
    localPayload: '{"theme":"dark"}',
    remoteDeviceId: 'dev-b',
    remoteDeviceName: 'DEV-B',
    remoteModifiedAt: 1700000000000,
    remoteHash: 'b'.repeat(64),
    remotePayload: '{"theme":"light"}',
    suffix: '来自 DEV-B · 2026-10-15 12-00-00',
    ...partial
  }
}

const root = await mkdtemp(join(tmpdir(), 'yan-v3-sync-ipc-'))
const dataDir = join(root, 'data-a')
const sessionsDir = join(root, 'sessions')
const syncRoot = join(root, 'sync-folder')
const exportDir = join(root, 'export')
await mkdir(dataDir, { recursive: true })
await mkdir(sessionsDir, { recursive: true })
await mkdir(syncRoot, { recursive: true })
await mkdir(exportDir, { recursive: true })

let serviceCreates = []
let syncCalls = 0
let listCalls = 0
let resolveCalls = []
let syncResult = makeReport()
let conflictsResult = []
let serviceError = null
let resolveResult = { ok: true }
let sessionFile = ''
let exportedPath = ''

const config = new SyncConfigStore(dataDir)

const deps = {
  dataDir,
  sessionsDir,
  config,
  makeService: (folder) => {
    serviceCreates.push(folder)
    if (serviceError) throw serviceError
    return {
      sync: async () => {
        syncCalls += 1
        return syncResult
      },
      listConflicts: async () => {
        listCalls += 1
        return conflictsResult
      },
      resolveConflict: async (id, resolution) => {
        resolveCalls.push({ id, resolution })
        return resolveResult
      }
    }
  },
  pickSyncFolder: async () => syncRoot,
  pickExportPath: async (name) => join(exportDir, name),
  pickImportFile: async () => '',
  currentSessionPath: () => sessionFile,
  log: null
}

const registrar = captureRegistrar()
const controller = registerSyncIpc(registrar.ipc, deps)
void controller

try {
  /* ══════════════════════════════════════════════════════════
   * 1. 未配置状态
   * ══════════════════════════════════════════════════════════ */
  section('未配置：status 如实报告，不创建同步服务')
  await check('configured=false 且不调用 makeService', async () => {
    const status = await registrar.invoke('yan:sync:status')
    assert.equal(status.configured, false)
    assert.equal(status.conflictCount, 0)
    assert.equal(serviceCreates.length, 0)
  })
  await check('未配置时立即同步返回可读错误，不抛异常', async () => {
    const result = await registrar.invoke('yan:sync:now')
    assert.equal(result.ok, false)
    assert.match(result.error, /同步文件夹/)
    assert.equal(syncCalls, 0)
  })

  /* ══════════════════════════════════════════════════════════
   * 2. 配置 / 清除
   * ══════════════════════════════════════════════════════════ */
  section('配置 / 清除：目录对话框注入')
  await check('configure() 走注入的目录对话框并落盘', async () => {
    const result = await registrar.invoke('yan:sync:configure')
    assert.equal(result.ok, true, result.error)
    assert.equal(result.syncRoot, syncRoot)
    const status = await registrar.invoke('yan:sync:status')
    assert.equal(status.configured, true)
    assert.equal(status.syncRoot, syncRoot)
  })
  await check('configure(path) 直接设置显式路径', async () => {
    const other = join(root, 'sync-other')
    await mkdir(other, { recursive: true })
    const result = await registrar.invoke('yan:sync:configure', other)
    assert.equal(result.ok, true)
    assert.equal(result.syncRoot, other)
  })
  await check('configure(null) 清除配置', async () => {
    const cleared = await registrar.invoke('yan:sync:configure', null)
    assert.equal(cleared.ok, true)
    const status = await registrar.invoke('yan:sync:status')
    assert.equal(status.configured, false)
  })
  await check('目录对话框取消时不写配置', async () => {
    const cancelledDeps = { ...deps, pickSyncFolder: async () => null, config: new SyncConfigStore(join(root, 'data-cancel')) }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, cancelledDeps)
    const result = await local.invoke('yan:sync:configure')
    assert.equal(result.ok, false)
    assert.equal(result.cancelled, true)
    const status = await local.invoke('yan:sync:status')
    assert.equal(status.configured, false)
  })

  /* ══════════════════════════════════════════════════════════
   * 3. 立即同步：计数透传 + lastSync 落盘
   * ══════════════════════════════════════════════════════════ */
  section('立即同步：计数透传与上次结果')
  await registrar.invoke('yan:sync:configure', syncRoot)
  await check('now 返回推送 / 拉取 / 冲突 / 跳过计数', async () => {
    conflictsResult = []
    syncResult = makeReport({ pushed: ['a', 'b'], pulled: ['c'], skipped: ['s1', 's2', 's3'], conflicts: [] })
    const result = await registrar.invoke('yan:sync:now')
    assert.equal(result.ok, true)
    assert.equal(result.pushed, 2)
    assert.equal(result.pulled, 1)
    assert.equal(result.conflicts, 0)
    assert.equal(result.skipped, 3)
    assert.equal(result.at, 1700000000000)
    assert.equal(serviceCreates.at(-1), syncRoot)
  })
  await check('lastSync 写进配置并在 status 里可读', async () => {
    const status = await registrar.invoke('yan:sync:status')
    assert.equal(status.lastSync.ok, true)
    assert.equal(status.lastSync.pushed, 2)
    assert.equal(status.lastSync.pulled, 1)
  })
  await check('sync 抛异常时 now 返回错误而不抛出', async () => {
    const saved = syncResult
    syncResult = null
    const failingDeps = { ...deps, makeService: () => ({ sync: async () => { throw new Error('boom') }, listConflicts: async () => [], resolveConflict: async () => ({ ok: true }) }), config }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, failingDeps)
    const result = await local.invoke('yan:sync:now')
    assert.equal(result.ok, false)
    assert.match(result.error, /boom/)
    syncResult = saved
  })

  /* ══════════════════════════════════════════════════════════
   * 4. 冲突：列出与处理
   * ══════════════════════════════════════════════════════════ */
  section('冲突：列出与逐条处理')
  await check('conflicts 带两侧设备 / 时间 / 预览', async () => {
    conflictsResult = [makeConflict({ localPayload: '{"theme":"dark"}', remotePayload: '{"theme":"light"}' })]
    const list = await registrar.invoke('yan:sync:conflicts')
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'conflict-1')
    assert.equal(list[0].kind, 'settings')
    assert.equal(list[0].localDeviceName, 'DEV-A')
    assert.equal(list[0].remoteDeviceName, 'DEV-B')
    assert.equal(list[0].localPreview, '{"theme":"dark"}')
    assert.equal(list[0].remotePreview, '{"theme":"light"}')
    const status = await registrar.invoke('yan:sync:status')
    assert.equal(status.conflictCount, 1)
  })
  await check('resolve 透传 id 与三种方式', async () => {
    for (const mode of ['local', 'remote', 'both']) {
      const result = await registrar.invoke('yan:sync:resolve', 'conflict-1', mode)
      assert.equal(result.ok, true, result.error)
    }
    assert.deepEqual(
      resolveCalls.map((call) => `${call.id}:${call.resolution}`),
      ['conflict-1:local', 'conflict-1:remote', 'conflict-1:both']
    )
  })
  await check('resolve 非法输入返回可读错误，不调用服务', async () => {
    resolveCalls = []
    assert.equal((await registrar.invoke('yan:sync:resolve', '', 'local')).ok, false)
    assert.equal((await registrar.invoke('yan:sync:resolve', 'conflict-1', 'bogus')).ok, false)
    assert.equal(resolveCalls.length, 0)
  })
  await check('resolve 失败原因原样返回', async () => {
    resolveResult = { ok: false, error: '冲突已经处理' }
    const result = await registrar.invoke('yan:sync:resolve', 'conflict-1', 'local')
    assert.equal(result.ok, false)
    assert.equal(result.error, '冲突已经处理')
    resolveResult = { ok: true }
  })
  await check('listConflicts 抛异常时 status 不抛出，带 error', async () => {
    const failingDeps = { ...deps, makeService: () => ({ sync: async () => makeReport(), listConflicts: async () => { throw new Error('read fail') }, resolveConflict: async () => ({ ok: true }) }), config }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, failingDeps)
    const status = await local.invoke('yan:sync:status')
    assert.equal(status.configured, true)
    assert.match(status.error, /read fail/)
    assert.equal(status.conflictCount, 0)
  })

  /* ══════════════════════════════════════════════════════════
   * 5. 会话导出 / 导入：路径注入
   * ══════════════════════════════════════════════════════════ */
  section('会话导出 / 导入：路径由对话框注入')
  sessionFile = join(dataDir, 'sess-original.jsonl')
  await writeFile(
    sessionFile,
    [
      JSON.stringify({ type: 'session', id: 'orig-0001', v: 1 }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'hi' } })
    ].join('\n') + '\n'
  )
  await check('exportSession 用注入的保存路径写会话包', async () => {
    const result = await registrar.invoke('yan:sync:exportSession')
    assert.equal(result.ok, true, result.error)
    assert.equal(existsSync(result.path), true)
    assert.ok(result.bytes > 0)
    exportedPath = result.path
    const bundle = JSON.parse(await readFile(result.path, 'utf8'))
    assert.equal(bundle.kind, 'inkstone-session')
    assert.equal(bundle.sourceSessionId, 'orig-0001')
  })
  await check('exportSession 没有当前会话时返回可读错误', async () => {
    const emptyDeps = { ...deps, currentSessionPath: () => undefined, config }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, emptyDeps)
    const result = await local.invoke('yan:sync:exportSession')
    assert.equal(result.ok, false)
    assert.match(result.error, /可导出/)
  })
  await check('importSession 用注入的会话包路径，生成新 id 且不覆盖同名', async () => {
    const importDeps = { ...deps, pickImportFile: async () => exportedPath, config }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, importDeps)
    const result = await local.invoke('yan:sync:importSession')
    assert.equal(result.ok, true, result.error)
    assert.notEqual(result.sessionId, 'orig-0001')
    assert.equal(existsSync(result.path), true)
    assert.ok(result.path.startsWith(sessionsDir))
    const content = await readFile(result.path, 'utf8')
    assert.match(content, new RegExp(`"type":"session","id":"${result.sessionId}"`))
  })
  await check('importSession 取消时不抛异常', async () => {
    const cancelDeps = { ...deps, pickImportFile: async () => null, config }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, cancelDeps)
    const result = await local.invoke('yan:sync:importSession')
    assert.equal(result.ok, false)
    assert.equal(result.cancelled, true)
    assert.match(result.error, /取消/)
  })
  await check('exportSession 取消时不抛异常', async () => {
    const cancelDeps = { ...deps, pickExportPath: async () => null, config }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, cancelDeps)
    const result = await local.invoke('yan:sync:exportSession')
    assert.equal(result.ok, false)
    assert.equal(result.cancelled, true)
    assert.match(result.error, /取消/)
  })

  /* ══════════════════════════════════════════════════════════
   * 6. 启动同步：失败只记日志
   * ══════════════════════════════════════════════════════════ */
  section('启动同步 runStartupSync：失败只记日志')
  await check('已配置且 sync 成功：写 lastSync，不抛', async () => {
    syncResult = makeReport({ pushed: ['p1'], pulled: [], conflicts: [], skipped: [], errors: [] })
    syncCalls = 0
    const messages = []
    const startupDeps = { ...deps, log: (message, error) => messages.push(`${message}${error ? `:${error}` : ''}`), config }
    await runStartupSync(startupDeps)
    assert.equal(syncCalls, 1)
    assert.deepEqual(messages, [])
    const status = await registrar.invoke('yan:sync:status')
    assert.equal(status.lastSync.pushed, 1)
  })
  await check('已配置但 sync 抛异常：记日志、不抛', async () => {
    const messages = []
    const failingDeps = {
      ...deps,
      makeService: () => ({ sync: async () => { throw new Error('offline') }, listConflicts: async () => [], resolveConflict: async () => ({ ok: true }) }),
      log: (message, error) => messages.push(`${message}:${error instanceof Error ? error.message : error}`),
      config
    }
    await runStartupSync(failingDeps)
    assert.equal(messages.length, 1)
    assert.match(messages[0], /offline/)
  })
  await check('未配置：不创建服务、不写日志', async () => {
    const emptyConfig = new SyncConfigStore(join(root, 'data-empty'))
    const messages = []
    const emptyDeps = { ...deps, config: emptyConfig, log: (message) => messages.push(message), makeService: () => { throw new Error('不该被调用') } }
    await runStartupSync(emptyDeps)
    assert.deepEqual(messages, [])
  })

  /* ══════════════════════════════════════════════════════════
   * 7. 真实 SyncService 的 resolveConflict
   * ══════════════════════════════════════════════════════════ */
  section('真实 SyncService：resolveConflict 采用他端 / 留两份')
  const realSync = join(root, 'real-sync')
  await mkdir(realSync, { recursive: true })
  const dirA = join(root, 'real-a')
  const dirB = join(root, 'real-b')
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })
  const serviceA = new SyncService({ dataDir: dirA, syncRoot: realSync, deviceId: 'A', deviceName: 'DEV-A' })
  const serviceB = new SyncService({ dataDir: dirB, syncRoot: realSync, deviceId: 'B', deviceName: 'DEV-B' })

  const settingsFileA = join(dirA, 'desktop.json')
  const settingsFileB = join(dirB, 'desktop.json')
  const promptDirB = join(dirB, 'prompts')
  await mkdir(promptDirB, { recursive: true })

  await check('制造一条 settings 冲突', async () => {
    await writeFile(settingsFileA, JSON.stringify({ theme: 'dark', keepAwakeWhileWorking: true }))
    await serviceA.sync()
    await serviceB.sync()
    await writeFile(settingsFileA, JSON.stringify({ theme: 'dark-2' }))
    await serviceA.sync()
    await writeFile(settingsFileB, JSON.stringify({ theme: 'light-2' }))
    const conflicted = await serviceB.sync()
    assert.equal(conflicted.conflicts.length, 1, JSON.stringify(conflicted.errors))
    const list = await serviceB.listConflicts()
    assert.equal(list.length, 1)
  })

  await check('resolveConflict(remote) 采用他端并清掉冲突', async () => {
    const [conflict] = await serviceB.listConflicts()
    const result = await serviceB.resolveConflict(conflict.id, 'remote')
    assert.equal(result.ok, true, result.error)
    const adopted = JSON.parse(await readFile(settingsFileB, 'utf8'))
    assert.equal(adopted.theme, 'dark-2')
    assert.equal((await serviceB.listConflicts()).length, 0)
  })

  await check('resolveConflict(both) 保留本机、他端另存、冲突清除', async () => {
    /* 用提示词制造第二条冲突：两端各写一份。 */
    const promptA = join(dirA, 'prompts')
    await mkdir(promptA, { recursive: true })
    await writeFile(join(promptA, 'review.md'), 'A 版本')
    await serviceA.sync()
    await serviceB.sync()
    await writeFile(join(promptA, 'review.md'), 'A 新版本')
    await writeFile(join(promptDirB, 'review.md'), 'B 新版本')
    await serviceA.sync()
    const conflicted = await serviceB.sync()
    assert.equal(conflicted.conflicts.length, 1, JSON.stringify(conflicted.errors))
    const [conflict] = await serviceB.listConflicts()
    const result = await serviceB.resolveConflict(conflict.id, 'both')
    assert.equal(result.ok, true, result.error)
    assert.equal((await serviceB.listConflicts()).length, 0)
    /* 本机主版本保持不变。 */
    assert.equal(await readFile(join(promptDirB, 'review.md'), 'utf8'), 'B 新版本')
    /* 他端版本落成带来源后缀的第二份。 */
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(promptDirB)
    const copy = files.find((name) => name !== 'review.md' && name.endsWith('.md'))
    assert.ok(copy, `期望复制出第二份，实际：${files.join(', ')}`)
    assert.match(copy, /DEV-A|来自/)
    assert.equal(await readFile(join(promptDirB, copy), 'utf8'), 'A 新版本')
  })
} finally {
  for (const file of bundles) await rm(file, { force: true }).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} WP-53 同步接线：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
