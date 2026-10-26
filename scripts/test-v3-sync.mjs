#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const bundleFile = join(tmpdir(), `yan-v3-sync-${process.pid}-${randomUUID()}.mjs`)
await build({
  entryPoints: [fileURLToPath(new URL('../src/main/sync/index.ts', import.meta.url))],
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning'
})
const sync = await import(pathToFileURL(bundleFile).href)
const { SyncService, exportSession, importSession, findForbiddenFields, pickSyncSettings, SESSION_TRANSFER_MAX_BYTES } = sync

const report = { pass: 0, fail: 0 }
let group = ''
function section(name) {
  group = name
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

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2))
}
async function writeText(file, text) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}
async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}
async function walk(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

const SECRETS = ['SECRET_KEY_123', 'leaky-token-value', 'shh-secret', 'p@ss-w0rd', 'Bearer leaky-auth', 'remote-token-value']
const LOCAL_PATHS = ['C:/Users/Alice/project', 'C:/tools/whisper.exe']

function desktopSettings(overrides = {}) {
  return {
    theme: 'dark',
    lang: 'zh-CN',
    density: 'standard',
    autoCompactTokens: 250000,
    apiKey: SECRETS[0],
    token: SECRETS[1],
    secret: SECRETS[2],
    password: SECRETS[3],
    authorization: SECRETS[4],
    cwd: LOCAL_PATHS[0],
    recentCwds: [LOCAL_PATHS[0]],
    voiceInput: { model: 'base', programPath: LOCAL_PATHS[1] },
    remoteAccess: { enabled: true, token: SECRETS[5] },
    ...overrides
  }
}

async function seed(dir, options = {}) {
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'desktop.json'), desktopSettings(options.settings))
  if (options.prompt !== undefined) await writeText(join(dir, 'prompts', 'review.md'), options.prompt)
  if (options.skill !== undefined) await writeText(join(dir, 'skills', 'my-skill', 'SKILL.md'), options.skill)
  if (options.schedule !== undefined) {
    await writeJson(join(dir, 'schedules.json'), {
      v: 1,
      tasks: [
        {
          id: options.schedule.id ?? 's1',
          name: options.schedule.name ?? '每日巡检',
          prompt: options.schedule.prompt ?? '检查项目状态',
          trigger: options.schedule.trigger ?? { kind: 'daily', time: '09:00' },
          enabled: true,
          createdBy: 'user',
          createdAt: 1,
          cwd: LOCAL_PATHS[0],
          nextRunAt: 999999,
          lastRunAt: 111,
          lastSessionId: 'old-session'
        }
      ]
    })
  }
  if (options.bookmark !== undefined) {
    await writeJson(join(dir, 'interaction-state', `${sha256(options.bookmark.session)}.json`), {
      version: 1,
      session: options.bookmark.session,
      values: { 'bookmark:m1': '1', 'widget:keep-local': 'local-only' }
    })
  }
}

async function readLocalBookmarks(dir) {
  const found = []
  const stateDir = join(dir, 'interaction-state')
  let files = []
  try {
    files = await readdir(stateDir)
  } catch {
    return found
  }
  for (const name of files) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readJson(join(stateDir, name))
      for (const [key, value] of Object.entries(raw.values ?? {})) {
        if (key.startsWith('bookmark:')) found.push({ session: raw.session, key, value })
      }
    } catch {
    }
  }
  return found
}

const root = await mkdtemp(join(tmpdir(), 'yan-v3-sync-'))
const syncRoot = join(root, 'cloud-folder')
await mkdir(syncRoot, { recursive: true })
const dataA = join(root, 'device-a')
const dataB = join(root, 'device-b')
const sessionValue = 'sess-1111-aaaa'

function service(dataDir, deviceId, deviceName, syncFolder = syncRoot) {
  return new SyncService({ dataDir, syncRoot: syncFolder, piAgentDir: dataDir, deviceId, deviceName })
}

try {
  section('单向同步：A 推、B 拉，五类内容都过去')
  await seed(dataA, {
    prompt: '# review\n请审查这段改动。\n',
    skill: '# my-skill\n做法说明。\n',
    schedule: { id: 's1' },
    bookmark: { session: sessionValue }
  })
  await mkdir(dataB, { recursive: true })
  const A = service(dataA, 'device-a', 'Device A')
  const B = service(dataB, 'device-b', 'Device B')

  const pushReport = await A.sync()
  await check('A 首轮同步成功并推出五类记录', () => {
    assert.equal(pushReport.ok, true, pushReport.errors.join('; '))
    for (const key of ['settings', 'prompt:review', 'skill:my-skill', 'schedule:s1']) {
      assert.ok(pushReport.pushed.includes(key), `缺少 ${key}：${pushReport.pushed.join(', ')}`)
    }
    assert.ok(pushReport.pushed.some((key) => key.startsWith('bookmark:')), `缺少书签：${pushReport.pushed.join(', ')}`)
  })

  const pullReport = await B.sync()
  await check('B 首轮同步拉取了全部记录', () => {
    assert.equal(pullReport.ok, true, pullReport.errors.join('; '))
    for (const key of ['settings', 'prompt:review', 'skill:my-skill', 'schedule:s1']) {
      assert.ok(pullReport.pulled.includes(key), `缺少 ${key}：${pullReport.pulled.join(', ')}`)
    }
  })

  await check('B 拿到设置', async () => {
    const settings = await readJson(join(dataB, 'desktop.json'))
    assert.equal(settings.theme, 'dark')
    assert.equal(settings.autoCompactTokens, 250000)
  })
  await check('B 拿到提示词模板与技能', async () => {
    assert.match(await readFile(join(dataB, 'prompts', 'review.md'), 'utf8'), /请审查这段改动/)
    assert.match(await readFile(join(dataB, 'skills', 'my-skill', 'SKILL.md'), 'utf8'), /做法说明/)
  })
  await check('B 拿到定时任务定义，且不带本机路径 / 运行状态', async () => {
    const doc = await readJson(join(dataB, 'schedules.json'))
    const task = doc.tasks.find((item) => item.id === 's1')
    assert.ok(task, '任务 s1 不存在')
    assert.equal(task.name, '每日巡检')
    assert.equal(task.trigger.time, '09:00')
    assert.equal('cwd' in task, false, 'cwd 不应同步')
    assert.equal('nextRunAt' in task, false, 'nextRunAt 不应同步')
    assert.equal('lastSessionId' in task, false, 'lastSessionId 不应同步')
  })
  await check('B 拿到书签，widget 本机状态不参与', async () => {
    const bookmarks = await readLocalBookmarks(dataB)
    assert.ok(bookmarks.some((item) => item.session === sessionValue && item.key === 'bookmark:m1' && item.value === '1'))
  })

  section('双向不同项：A 改提示词、B 改设置，往返后两端一致')
  await writeText(join(dataA, 'prompts', 'review.md'), '# review v2\n请审查并给出测试建议。\n')
  await writeJson(join(dataB, 'desktop.json'), { ...(await readJson(join(dataB, 'desktop.json'))), theme: 'light' })

  await A.sync()
  await B.sync()
  await A.sync()

  await check('两端提示词一致', async () => {
    const a = await readFile(join(dataA, 'prompts', 'review.md'), 'utf8')
    const b = await readFile(join(dataB, 'prompts', 'review.md'), 'utf8')
    assert.match(a, /review v2/)
    assert.equal(a, b)
  })
  await check('两端设置一致（B 的 theme 回到 A）', async () => {
    assert.equal((await readJson(join(dataA, 'desktop.json'))).theme, 'light')
    assert.equal((await readJson(join(dataB, 'desktop.json'))).theme, 'light')
  })

  section('同项冲突：两端改同一条，保留双份、不静默覆盖')
  const conflictRoot = join(root, 'conflict-folder')
  await mkdir(conflictRoot, { recursive: true })
  const dataC = join(root, 'device-c')
  const dataD = join(root, 'device-d')
  await seed(dataC, { settings: { density: 'standard' } })
  await seed(dataD, { settings: { density: 'standard' } })
  const C = service(dataC, 'device-c', 'Device C', conflictRoot)
  const D = service(dataD, 'device-d', 'Device D', conflictRoot)
  await C.sync()
  await D.sync()

  await writeJson(join(dataC, 'desktop.json'), { ...(await readJson(join(dataC, 'desktop.json'))), density: 'comfortable' })
  await writeJson(join(dataD, 'desktop.json'), { ...(await readJson(join(dataD, 'desktop.json'))), density: 'compact' })
  await C.sync()
  const dReport = await D.sync()

  await check('D 检测到 1 条冲突', () => {
    assert.equal(dReport.conflicts.length, 1, JSON.stringify(dReport.conflicts))
    assert.equal(dReport.conflicts[0].key, 'settings')
  })
  await check('D 本地版本不动（compact），他端版本留在冲突副本里（comfortable）', async () => {
    assert.equal((await readJson(join(dataD, 'desktop.json'))).density, 'compact')
    const conflict = dReport.conflicts[0]
    assert.equal(conflict.localPayload.includes('compact'), true)
    assert.equal(conflict.remotePayload.includes('comfortable'), true)
    assert.match(conflict.suffix, /Device C/)
    const files = await walk(join(conflictRoot, 'inkstone-sync', 'conflicts'))
    assert.ok(files.some((file) => file.endsWith('.json') && !file.endsWith('index.json')), '缺少冲突副本文件')
    assert.ok((await D.listConflicts()).length >= 1, 'listConflicts 应能读回冲突')
  })
  await check('再同步不会覆盖任何一端（冲突冻结）', async () => {
    await D.sync()
    await C.sync()
    assert.equal((await readJson(join(dataD, 'desktop.json'))).density, 'compact')
    assert.equal((await readJson(join(dataC, 'desktop.json'))).density, 'comfortable')
  })
  await check('冲突副本用两个哈希去重，不重复堆', async () => {
    const before = (await walk(join(conflictRoot, 'inkstone-sync', 'conflicts'))).filter((f) => !f.endsWith('index.json')).length
    await D.sync()
    const after = (await walk(join(conflictRoot, 'inkstone-sync', 'conflicts'))).filter((f) => !f.endsWith('index.json')).length
    assert.equal(after, before)
  })
  await check('冲突目录不再写只写不读的 index.json，计数与列表一致', async () => {
    const files = await walk(join(conflictRoot, 'inkstone-sync', 'conflicts'))
    assert.equal(files.some((file) => file.endsWith('index.json')), false, files.join(', '))
    assert.equal(await D.countConflicts(), (await D.listConflicts()).length)
  })

  section('凭证与外泄断言：同步目录里不得出现凭证明文或凭证字段名')
  await check('所有同步文件都不含凭证值 / 本机路径', async () => {
    const files = await walk(syncRoot)
    assert.ok(files.length > 0, '同步目录为空')
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const secret of SECRETS) {
        assert.equal(text.includes(secret), false, `${file} 含凭证值 ${secret}`)
      }
      for (const localPath of LOCAL_PATHS) {
        assert.equal(text.includes(localPath), false, `${file} 含本机路径 ${localPath}`)
      }
    }
  })
  await check('所有 JSON 里没有凭证类字段名（含嵌套 payload）', async () => {
    for (const file of await walk(syncRoot)) {
      if (!file.endsWith('.json')) continue
      let parsed
      try {
        parsed = JSON.parse(await readFile(file, 'utf8'))
      } catch {
        continue
      }
      assert.deepEqual(findForbiddenFields(parsed), [], `${file} 含凭证字段名`)
      if (typeof parsed.payload === 'string') {
        try {
          assert.deepEqual(findForbiddenFields(JSON.parse(parsed.payload)), [], `${file} 的记录 payload 含凭证字段名`)
        } catch (error) {
          if (error instanceof assert.AssertionError) throw error
        }
      }
    }
  })
  await check('白名单另有直接保证：desktop.json 的凭证字段不被选中', () => {
    return readFile(join(dataA, 'desktop.json'), 'utf8').then((text) => {
      assert.ok(text.includes('apiKey') && text.includes('SECRET_KEY_123'), '夹具本身应含凭证')
    })
  })

  section('健壮性：损坏 / 半写入文件跳过，缺失目录只报告')
  const brokenFile = join(syncRoot, 'inkstone-sync', 'records', 'prompt', 'broken.json')
  const halfFile = join(syncRoot, 'inkstone-sync', 'records', 'skill', 'half.json')
  await writeText(brokenFile, '{ this is not json')
  await writeJson(halfFile, {
    v: 1,
    key: 'skill:half',
    kind: 'skill',
    deviceId: 'device-x',
    deviceName: 'Device X',
    modifiedAt: 1,
    hash: 'deadbeef',
    payload: '# half'
  })

  const brokenReport = await B.sync()
  await check('同步不崩溃，坏文件被列入 skipped', () => {
    assert.equal(brokenReport.ok, true, brokenReport.errors.join('; '))
    assert.ok(
      brokenReport.skipped.some((item) => item.includes('broken.json')),
      `未报告 broken.json：${brokenReport.skipped.join(' | ')}`
    )
    assert.ok(
      brokenReport.skipped.some((item) => item.includes('half.json')),
      `未报告 half.json：${brokenReport.skipped.join(' | ')}`
    )
  })
  await check('坏文件原样保留，不被删除', async () => {
    assert.equal(existsSync(brokenFile), true)
    assert.equal(existsSync(halfFile), true)
    assert.match(await readFile(brokenFile, 'utf8'), /not json/)
  })

  await check('同步文件夹缺失 → ok=false，只报告不崩溃', async () => {
    const missing = new SyncService({
      dataDir: dataB,
      syncRoot: join(root, 'no-such-folder'),
      piAgentDir: dataB,
      deviceId: 'device-b',
      deviceName: 'Device B'
    })
    const missingReport = await missing.sync()
    assert.equal(missingReport.ok, false)
    assert.ok(missingReport.errors.some((item) => item.includes('不存在')), missingReport.errors.join('; '))
  })

  section('会话导出 / 导入：生成新 id、不覆盖同名')
  const sourceSession = join(root, 'sessions-src', 'original.jsonl')
  const originalId = 'sess-original-0001'
  await writeText(
    sourceSession,
    [
      JSON.stringify({ type: 'session', id: originalId, cwd: LOCAL_PATHS[0] }),
      JSON.stringify({ type: 'message', id: 'e1', message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'message', id: 'e2', message: { role: 'assistant', content: '你好，有什么可以帮忙？' } })
    ].join('\n') + '\n'
  )
  const bundlePath = join(root, 'export', 'my-session')
  const exportResult = await exportSession(sourceSession, bundlePath)
  let importedId = ''
  await check('导出成功并生成会话包', () => {
    assert.equal(exportResult.ok, true, exportResult.error)
    assert.equal(existsSync(exportResult.path), true)
  })
  const importDir = join(root, 'sessions-import')
  await check('导入生成新 id，正文完整', async () => {
    const queue = ['sess-import-0001']
    const imported = await importSession(exportResult.path, importDir, { newId: () => queue.shift() ?? randomUUID() })
    assert.equal(imported.ok, true, imported.error)
    importedId = imported.sessionId
    assert.notEqual(imported.sessionId, originalId)
    const text = await readFile(imported.path, 'utf8')
    assert.match(text, /sess-import-0001/)
    assert.match(text, /你好，有什么可以帮忙？/)
  })
  await check('同名时换新 id，不覆盖已有会话', async () => {
    const queue = ['sess-import-0001', 'sess-import-0002']
    const imported = await importSession(exportResult.path, importDir, { newId: () => queue.shift() ?? randomUUID() })
    assert.equal(imported.ok, true, imported.error)
    assert.equal(imported.sessionId, 'sess-import-0002')
    assert.equal(existsSync(join(importDir, 'sess-import-0001.jsonl')), true)
    assert.equal(existsSync(join(importDir, 'sess-import-0002.jsonl')), true)
    assert.equal(importedId, 'sess-import-0001')
  })
  await check('会话本体不进入同步目录', async () => {
    const files = await walk(syncRoot)
    assert.equal(files.some((file) => file.endsWith('.jsonl')), false)
  })
  await check('超过 64MB 的会话包拒绝导入，不落任何会话文件', async () => {
    const huge = join(root, 'huge-bundle.json')
    await writeFile(huge, JSON.stringify({ v: 1, kind: 'inkstone-session', exportedAt: 1, fileName: 'a.jsonl', content: 'x' }))
    await truncate(huge, SESSION_TRANSFER_MAX_BYTES + 1)
    const target = join(root, 'sessions-huge')
    const imported = await importSession(huge, target)
    assert.equal(imported.ok, false)
    assert.match(imported.error, /过大/)
    assert.equal(existsSync(target), false)
  })
  await check('超过 64MB 的会话拒绝导出，不写半份会话包', async () => {
    const hugeSession = join(root, 'sessions-src', 'huge.jsonl')
    await writeFile(hugeSession, JSON.stringify({ type: 'session', id: 'sess-huge' }))
    await truncate(hugeSession, SESSION_TRANSFER_MAX_BYTES + 1)
    const target = join(root, 'export', 'huge')
    const exported = await exportSession(hugeSession, target)
    assert.equal(exported.ok, false)
    assert.match(exported.error, /过大/)
    assert.equal(existsSync(`${target}.inkstone-session.json`), false)
  })

  section('安全：权限档与保护开关不再跨设备同步')
  await check('白名单不再包含 permissionMode / guardOutsideWrites / checkpointsEnabled', () => {
    const picked = pickSyncSettings({
      permissionMode: 'all',
      guardOutsideWrites: false,
      checkpointsEnabled: false,
      theme: 'light',
      autoCompactTokens: 123
    })
    assert.deepEqual(picked, { theme: 'light', autoCompactTokens: 123 })
  })
  await check('拉取到的设置只经过注入的写入入口，不直写 desktop.json', async () => {
    const farRoot = join(root, 'folder-applier')
    await mkdir(farRoot, { recursive: true })
    const dataE = join(root, 'device-e')
    await mkdir(dataE, { recursive: true })
    const captured = []
    const E = new SyncService({
      dataDir: dataE,
      syncRoot: farRoot,
      piAgentDir: dataE,
      deviceId: 'device-e',
      deviceName: 'Device E',
      settingsApplier: async (patch) => {
        captured.push(patch)
      }
    })
    await writeJson(join(dataE, 'desktop.json'), { theme: 'dark', permissionMode: 'ask', apiKey: 'SECRET_KEY_123' })
    await E.sync()
    await writeJson(join(dataE, 'desktop.json'), { theme: 'light', permissionMode: 'ask', apiKey: 'SECRET_KEY_123' })
    const pulled = await E.sync()
    assert.deepEqual(pulled.errors, [])
    assert.ok(pulled.pushed.includes('settings'), pulled.pushed.join(', '))
    const dataF = join(root, 'device-f')
    await mkdir(dataF, { recursive: true })
    const received = []
    const F = new SyncService({
      dataDir: dataF,
      syncRoot: farRoot,
      piAgentDir: dataF,
      deviceId: 'device-f',
      deviceName: 'Device F',
      settingsApplier: async (patch) => {
        received.push(patch)
      }
    })
    const report = await F.sync()
    assert.deepEqual(report.errors, [])
    assert.equal(received.length, 1, JSON.stringify(received))
    assert.deepEqual(received[0], { theme: 'light' })
    assert.equal(existsSync(join(dataF, 'desktop.json')), false, '注入写入入口后不应直写 desktop.json')
  })

  section('定时任务：本机内容不被远端覆盖')
  await check('同名任务提示词不同时跳过并报错，本机保留', async () => {
    const scheduleRoot = join(root, 'folder-schedule')
    await mkdir(scheduleRoot, { recursive: true })
    const dataG = join(root, 'device-g')
    const dataH = join(root, 'device-h')
    await seed(dataG, { schedule: { id: 's1', prompt: '检查项目状态' } })
    await seed(dataH, { schedule: { id: 's1', prompt: '检查项目状态' } })
    const G = service(dataG, 'device-g', 'Device G', scheduleRoot)
    const H = service(dataH, 'device-h', 'Device H', scheduleRoot)
    await G.sync()
    await H.sync()
    await writeJson(join(dataG, 'schedules.json'), {
      v: 1,
      tasks: [{ id: 's1', name: '每日巡检', prompt: '新的检查内容', trigger: { kind: 'daily', time: '09:00' }, enabled: true, createdBy: 'user', createdAt: 1 }]
    })
    await G.sync()
    const pulled = await H.sync()
    assert.equal(pulled.ok, false, 'partial failure 不应报 ok')
    assert.ok(pulled.errors.some((item) => item.includes('提示词或触发时间')), pulled.errors.join('; '))
    const doc = await readJson(join(dataH, 'schedules.json'))
    assert.equal(doc.tasks.find((task) => task.id === 's1').prompt, '检查项目状态')
  })
} finally {
  const rootStat = await stat(root).catch(() => null)
  if (rootStat) await rm(root, { recursive: true, force: true }).catch(() => undefined)
  await rm(bundleFile, { force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} WP-53 同步核心：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
