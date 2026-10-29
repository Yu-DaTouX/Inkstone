#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

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
const { registerSyncIpc, runAutoSync } = ipcMod
const { SyncService, SyncConfigStore } = syncMod

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
let countCalls = 0
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
      countConflicts: async () => {
        countCalls += 1
        return conflictsResult.length
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
    assert.equal(result.error.code, 'config.missing')
    assert.equal(syncCalls, 0)
  })

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
  await check('configure(path) 校验目录：不存在或不是目录都拒绝，且不写配置', async () => {
    const before = (await registrar.invoke('yan:sync:status')).syncRoot
    const missing = join(root, 'no-such-folder')
    const rejected = await registrar.invoke('yan:sync:configure', missing)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error.code, 'folder.missing')
    assert.equal(rejected.error.params.path, missing)
    const file = join(root, 'not-a-folder.txt')
    await writeFile(file, 'x')
    const notDir = await registrar.invoke('yan:sync:configure', file)
    assert.equal(notDir.ok, false)
    assert.equal(notDir.error.code, 'folder.missing')
    assert.equal(notDir.error.params.path, file)
    assert.equal((await registrar.invoke('yan:sync:status')).syncRoot, before)
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
    const failingDeps = { ...deps, makeService: () => ({ sync: async () => { throw new Error('boom') }, listConflicts: async () => [], countConflicts: async () => 0, resolveConflict: async () => ({ ok: true }) }), config }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, failingDeps)
    const result = await local.invoke('yan:sync:now')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'unknown')
    assert.match(String(result.error.params?.reason), /boom/)
    syncResult = saved
  })
  await check('部分记录失败时 now 如实返回 ok=false 并带上错误', async () => {
    syncResult = makeReport({ ok: false, errors: [{ code: 'record.forbidden', params: { key: 'prompt:review', fields: 'apiKey' } }] })
    const result = await registrar.invoke('yan:sync:now')
    assert.equal(result.ok, false)
    assert.deepEqual(result.errors, [{ code: 'record.forbidden', params: { key: 'prompt:review', fields: 'apiKey' } }])
    syncResult = makeReport()
  })
  await check('同步进行中的 resolve 排在同步之后执行', async () => {
    const events = []
    const orderDeps = {
      ...deps,
      config,
      makeService: () => ({
        sync: async () => {
          events.push('sync-start')
          await new Promise((resolve) => setTimeout(resolve, 40))
          events.push('sync-end')
          return makeReport()
        },
        listConflicts: async () => [],
        countConflicts: async () => 0,
        resolveConflict: async () => {
          events.push('resolve')
          return { ok: true }
        }
      })
    }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, orderDeps)
    const syncing = local.invoke('yan:sync:now')
    const deadline = Date.now() + 2000
    while (!events.includes('sync-start') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
    const resolving = local.invoke('yan:sync:resolve', 'conflict-1', 'local')
    assert.equal((await syncing).ok, true)
    assert.equal((await resolving).ok, true)
    assert.deepEqual(events, ['sync-start', 'sync-end', 'resolve'])
  })

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
  await check('resolve 失败原因原样返回（结构化错误码）', async () => {
    resolveResult = { ok: false, error: { code: 'conflict.missing' } }
    const result = await registrar.invoke('yan:sync:resolve', 'conflict-1', 'local')
    assert.equal(result.ok, false)
    assert.deepEqual(result.error, { code: 'conflict.missing' })
    resolveResult = { ok: true }
  })
  await check('status 只数文件个数，不逐条解析冲突 payload', async () => {
    conflictsResult = [makeConflict(), makeConflict({ id: 'conflict-2' })]
    const listBefore = listCalls
    const countBefore = countCalls
    const status = await registrar.invoke('yan:sync:status')
    assert.equal(status.conflictCount, 2)
    assert.equal(countCalls, countBefore + 1)
    assert.equal(listCalls, listBefore)
  })
  await check('listConflicts 抛异常时 status 不抛出，带结构化 error', async () => {
    const failingDeps = { ...deps, makeService: () => ({ sync: async () => makeReport(), listConflicts: async () => { throw new Error('read fail') }, countConflicts: async () => { throw new Error('read fail') }, resolveConflict: async () => ({ ok: true }) }), config }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, failingDeps)
    const status = await local.invoke('yan:sync:status')
    assert.equal(status.configured, true)
    assert.equal(status.error.code, 'unknown')
    assert.match(String(status.error.params?.reason), /read fail/)
    assert.equal(status.conflictCount, 0)
  })

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
    assert.equal(result.error.code, 'session.missing')
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
    assert.equal(result.error.code, 'session.cancelled')
  })
  await check('exportSession 取消时不抛异常', async () => {
    const cancelDeps = { ...deps, pickExportPath: async () => null, config }
    const local = captureRegistrar()
    registerSyncIpc(local.ipc, cancelDeps)
    const result = await local.invoke('yan:sync:exportSession')
    assert.equal(result.ok, false)
    assert.equal(result.cancelled, true)
    assert.equal(result.error.code, 'session.cancelled')
  })

  section('同步方式：默认手动，自动每小时')
  await check('新配置默认手动，status 带 mode 与 1 小时间隔', async () => {
    const status = await registrar.invoke('yan:sync:status')
    assert.equal(status.mode, 'manual')
    assert.equal(status.autoIntervalMs, 60 * 60_000)
  })
  await check('手动模式下自动同步不调用 sync', async () => {
    syncCalls = 0
    await runAutoSync({ ...deps, config })
    assert.equal(syncCalls, 0)
  })
  await check('setMode 拒绝未知值', async () => {
    const result = await registrar.invoke('yan:sync:setMode', 'hourly')
    assert.equal(result.ok, false)
    assert.equal((await registrar.invoke('yan:sync:status')).mode, 'manual')
  })
  await check('旧配置（已选文件夹、无 mode 字段）视为自动', async () => {
    const legacyDir = join(root, 'data-legacy')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(join(legacyDir, 'sync-config.json'), JSON.stringify({ v: 1, syncRoot }))
    const legacy = new SyncConfigStore(legacyDir)
    assert.equal((await legacy.read()).mode, 'auto')
    const cleared = new SyncConfigStore(legacyDir)
    await cleared.setSyncRoot(undefined)
    const reread = JSON.parse(await readFile(join(legacyDir, 'sync-config.json'), 'utf8'))
    assert.equal(reread.mode, 'auto')
  })
  await check('控制器按间隔触发自动同步，切回手动后停止调用', async () => {
    const timedDir = join(root, 'data-timed')
    await mkdir(timedDir, { recursive: true })
    const timedConfig = new SyncConfigStore(timedDir)
    await timedConfig.setSyncRoot(syncRoot)
    await timedConfig.setMode('auto')
    let calls = 0
    const timedDeps = {
      ...deps,
      config: timedConfig,
      autoIntervalMs: 20,
      makeService: () => ({ sync: async () => { calls += 1; return makeReport() }, listConflicts: async () => [], countConflicts: async () => 0, resolveConflict: async () => ({ ok: true }) })
    }
    const local = captureRegistrar()
    const timed = registerSyncIpc(local.ipc, timedDeps)
    timed.start()
    const deadline = Date.now() + 2000
    while (calls < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(calls >= 2, `期望启动加定时至少 2 次，实际 ${calls}`)
    assert.equal((await local.invoke('yan:sync:setMode', 'manual')).mode, 'manual')
    await new Promise((resolve) => setTimeout(resolve, 60))
    const settled = calls
    await new Promise((resolve) => setTimeout(resolve, 100))
    timed.stop()
    assert.equal(calls, settled)
  })

  section('自动同步 runAutoSync：失败只记日志')
  await check('已配置且 sync 成功：写 lastSync，不抛', async () => {
    assert.equal((await registrar.invoke('yan:sync:setMode', 'auto')).mode, 'auto')
    syncResult = makeReport({ pushed: ['p1'], pulled: [], conflicts: [], skipped: [], errors: [] })
    syncCalls = 0
    const messages = []
    const startupDeps = { ...deps, log: (message, error) => messages.push(`${message}${error ? `:${error}` : ''}`), config }
    await runAutoSync(startupDeps)
    assert.equal(syncCalls, 1)
    assert.deepEqual(messages, [])
    const status = await registrar.invoke('yan:sync:status')
    assert.equal(status.lastSync.pushed, 1)
  })
  await check('已配置但 sync 抛异常：记日志、不抛', async () => {
    const messages = []
    const failingDeps = {
      ...deps,
      makeService: () => ({ sync: async () => { throw new Error('offline') }, listConflicts: async () => [], countConflicts: async () => 0, resolveConflict: async () => ({ ok: true }) }),
      log: (message, error) => messages.push(`${message}:${error instanceof Error ? error.message : error}`),
      config
    }
    await runAutoSync(failingDeps)
    assert.equal(messages.length, 1)
    assert.match(messages[0], /offline/)
  })
  await check('未配置：不创建服务、不写日志', async () => {
    const emptyConfig = new SyncConfigStore(join(root, 'data-empty'))
    const messages = []
    const emptyDeps = { ...deps, config: emptyConfig, log: (message) => messages.push(message), makeService: () => { throw new Error('不该被调用') } }
    await runAutoSync(emptyDeps)
    assert.deepEqual(messages, [])
  })

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
    assert.equal(await readFile(join(promptDirB, 'review.md'), 'utf8'), 'B 新版本')
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
