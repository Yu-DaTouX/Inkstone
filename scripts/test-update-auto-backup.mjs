#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const report = { pass: 0, fail: 0 }
async function check(message, fn) {
  try {
    await fn()
    report.pass += 1
    process.stdout.write(`  ✓ ${message}\n`)
  } catch (error) {
    report.fail += 1
    process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const work = await mkdtemp(join(process.cwd(), '.tmp', 'update-backup-'))
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

process.stdout.write('\n▌更新前自动备份的保留策略（I4）\n')
const backupBuild = await build({
  entryPoints: ['src/main/data-backup.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const backup = await import(`data:text/javascript;base64,${Buffer.from(backupBuild.outputFiles[0].text).toString('base64')}`)

try {
  const sessions = join(work, 'pi', 'sessions')
  const yan = join(work, 'pi', 'yan')
  const userData = join(work, 'userdata')
  for (const dir of [sessions, yan, userData]) await mkdir(dir, { recursive: true })
  await writeFile(join(sessions, 'a.jsonl'), '{"type":"session"}\n')
  await writeFile(join(yan, 'desktop.json'), '{"lang":"zh-CN"}')

  const autoRoot = backup.autoBackupRoot(userData)
  const first = await backup.createUpdateAutoBackup({ userData, sessions, yan })
  await wait(20)
  const second = await backup.createUpdateAutoBackup({ userData, sessions, yan })

  await check('只保留最近一份本功能创建的成功自动备份', async () => {
    const names = await readdir(autoRoot)
    assert.equal(names.includes('first-marker'), false)
    assert.equal(names.length, 1, JSON.stringify(names))
    assert.equal(names[0], second.path.split(/[\\/]/).pop())
    assert.equal(first.path === second.path, false)
  })

  await check('自动备份里带本功能的标记，能被校验', async () => {
    const manifest = JSON.parse(await readFile(join(second.path, 'manifest.json'), 'utf8'))
    assert.equal(manifest.format, 'inkstone-backup')
    const marker = JSON.parse(await readFile(join(second.path, 'auto-backup.json'), 'utf8'))
    assert.equal(marker.format, 'inkstone-auto-backup')
    const verified = await backup.verifyDataBackup(second.path)
    assert.equal(verified.files, manifest.files.length)
  })

  await check('自动备份目录里不是本功能创建的目录不动', async () => {
    const foreign = join(autoRoot, 'my-own-copy')
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'note.txt'), 'keep')
    const manual = join(work, 'manual-backup')
    await mkdir(manual, { recursive: true })
    await writeFile(join(manual, 'note.txt'), 'keep')
    await wait(20)
    const third = await backup.createUpdateAutoBackup({ userData, sessions, yan })
    const names = await readdir(autoRoot)
    assert.equal(names.includes('my-own-copy'), true, '没有标记的目录保留')
    assert.equal(names.includes(third.path.split(/[\\/]/).pop()), true)
    assert.equal(names.filter((name) => name.startsWith('Inkstone-backup-')).length, 1, JSON.stringify(names))
    assert.equal(await readFile(join(manual, 'note.txt'), 'utf8'), 'keep', '手动备份不动')
  })

  await check('新备份失败时不清理旧的自动备份', async () => {
    const emptySessions = join(work, 'empty-sessions')
    const emptyYan = join(work, 'empty-yan')
    for (const dir of [emptySessions, emptyYan]) await mkdir(dir, { recursive: true })
    const before = (await readdir(autoRoot)).filter((name) => name.startsWith('Inkstone-backup-'))
    await assert.rejects(() => backup.createUpdateAutoBackup({ userData, sessions: emptySessions, yan: emptyYan }))
    const after = (await readdir(autoRoot)).filter((name) => name.startsWith('Inkstone-backup-'))
    assert.deepEqual(after, before, '旧备份仍在')
  })
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => undefined)
}

process.stdout.write('\n▌安装更新前的备份与忙状态（I4）\n')
const model = { directory: await mkdtemp(join(tmpdir(), 'yan-update-')), packaged: true, installs: 0, dialogThrows: false, answer: 1, busy: false, release: { tag_name: 'v0.4.0', assets: [{ name: 'latest.yml' }], html_url: 'https://example.invalid' } }
globalThis.__yanUpdateModel = model
const updateBuild = await build({
  entryPoints: ['src/main/app-update.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'update-stubs',
      setup(builder) {
        builder.onResolve({ filter: /^(electron|electron-updater|\.\/data-backup|\.\/sessions|\.\/paths)$/ }, (args) => ({ path: args.path, namespace: 'stub' }))
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => {
          if (path === 'electron') {
            return {
              contents: `const m = globalThis.__yanUpdateModel
const mainWindow = { isDestroyed: () => false }
export const app = { getVersion: () => '0.3.2', getPath: () => m.directory, get isPackaged() { return m.packaged } }
export const net = { fetch: async () => ({ ok: true, json: async () => m.release }) }
export const BrowserWindow = { getAllWindows: () => (m.noWindow ? [] : [mainWindow]) }
export const dialog = {
  async showMessageBox(win, options) {
    const target = options === undefined ? null : win
    const payload = options === undefined ? win : options
    m.dialogs = [...(m.dialogs ?? []), payload]
    m.dialogWindows = [...(m.dialogWindows ?? []), target === mainWindow ? 'main' : null]
    if (m.dialogThrows) throw new Error('dialog broke')
    return { response: m.answer }
  }
}
`
            }
          }
          if (path === 'electron-updater') {
            return {
              contents: `import { EventEmitter } from 'node:events'
const m = globalThis.__yanUpdateModel
export const autoUpdater = new EventEmitter()
autoUpdater.setFeedURL = () => {}
autoUpdater.checkForUpdates = async () => ({ updateInfo: { version: m.release.tag_name.slice(1) } })
autoUpdater.downloadUpdate = async () => { autoUpdater.emit('download-progress', { percent: 100 }); autoUpdater.emit('update-downloaded') }
autoUpdater.quitAndInstall = () => { m.installs += 1 }
globalThis.__yanUpdater = autoUpdater
`
            }
          }
          if (path === './data-backup') return { contents: 'export const createUpdateAutoBackup = async () => { throw new Error("测试不应走默认备份") }' }
          if (path === './sessions') return { contents: "export const SESSIONS_DIR = '/nonexistent-sessions'" }
          return { contents: "export const YAN_DIR = '/nonexistent-yan'" }
        })
      }
    }
  ]
})
const { registerAppUpdate } = await import(`data:text/javascript;base64,${Buffer.from(updateBuild.outputFiles[0].text).toString('base64')}`)
let prepareAutomaticInstallOnQuit = null

const handlers = new Map()
const factory = { mode: 'ok', delayMs: 0, onRun: null }
const backupFactory = async () => {
  factory.runs = (factory.runs ?? 0) + 1
  factory.onRun?.()
  if (factory.delayMs) await wait(factory.delayMs)
  if (factory.mode === 'fail') throw new Error('no space left')
  return { path: join(model.directory, 'auto-backups', 'x'), createdAt: new Date().toISOString(), files: 1, bytes: 10 }
}
const control = registerAppUpdate({ handle: (channel, fn) => handlers.set(channel, fn) }, () => model.busy, backupFactory)
prepareAutomaticInstallOnQuit = control.prepareAutomaticInstallOnQuit
const cancelAutomaticInstallPreparation = control.cancelAutomaticInstallPreparation
const run = (name, ...args) => handlers.get(`yan:update:${name}`)(...args)

try {
  await check('下载完成后不会先备份，也不会自己打开退出时安装', async () => {
    factory.mode = 'ok'
    factory.runs = 0
    await run('automatic', true)
    await run('check')
    assert.equal((await run('status')).phase, 'downloaded', '自动更新应当已下载')
    await wait(80)
    assert.equal(factory.runs, 0, '下载完成不应预先备份')
    assert.equal(globalThis.__yanUpdater.autoInstallOnAppQuit, false, '退出前准备之前不允许自动安装')
  })

  await check('退出准备时做真实备份，成功才放行原生退出安装', async () => {
    factory.mode = 'ok'
    factory.runs = 0
    const result = await prepareAutomaticInstallOnQuit()
    assert.equal(factory.runs, 1, '退出前应当备份一次')
    assert.equal(result.install, true)
    assert.equal(result.reason, 'backed-up')
    assert.equal(globalThis.__yanUpdater.autoInstallOnAppQuit, true)
  })

  await check('并发调用退出准备只备份一次', async () => {
    factory.runs = 0
    factory.delayMs = 30
    const [a, b] = await Promise.all([prepareAutomaticInstallOnQuit(), prepareAutomaticInstallOnQuit()])
    factory.delayMs = 0
    assert.equal(factory.runs, 1)
    assert.equal(a.install, true)
    assert.equal(b.install, true)
  })

  await check('关掉自动更新时退出准备不备份也不安装', async () => {
    await run('automatic', false)
    factory.runs = 0
    const result = await prepareAutomaticInstallOnQuit()
    assert.equal(result.install, false)
    assert.equal(result.reason, 'disabled')
    assert.equal(factory.runs, 0)
    assert.equal(globalThis.__yanUpdater.autoInstallOnAppQuit, false)
    await run('automatic', true)
  })

  await check('备份失败且用户选择取消安装：只退出、不安装', async () => {
    factory.mode = 'fail'
    model.answer = 1
    model.dialogs = []
    const result = await prepareAutomaticInstallOnQuit()
    assert.equal(result.install, false)
    assert.equal(result.reason, 'cancelled')
    assert.equal(model.dialogs.length, 1, '应当询问用户')
    assert.equal(model.dialogWindows?.at(-1), 'main', '对话框挂在主窗口上')
    assert.equal(globalThis.__yanUpdater.autoInstallOnAppQuit, false)
    assert.match((await run('status')).error ?? '', /备份/)
    model.answer = 1
  })

  await check('备份失败但用户选择继续安装：放行原生退出安装', async () => {
    factory.mode = 'fail'
    model.answer = 0
    const result = await prepareAutomaticInstallOnQuit()
    assert.equal(result.install, true)
    assert.equal(result.reason, 'accepted-without-backup')
    assert.equal(globalThis.__yanUpdater.autoInstallOnAppQuit, true)
    model.answer = 1
    factory.mode = 'ok'
  })

  await check('没有待安装更新时退出准备什么都不做', async () => {
    globalThis.__yanUpdater.emit('error', new Error('simulated'))
    assert.equal((await run('status')).phase, 'error')
    factory.runs = 0
    const result = await prepareAutomaticInstallOnQuit()
    assert.equal(result.install, false)
    assert.equal(result.reason, 'no-update')
    assert.equal(factory.runs, 0)
    assert.equal(globalThis.__yanUpdater.autoInstallOnAppQuit, false)
    globalThis.__yanUpdater.emit('update-downloaded')
    assert.equal((await run('status')).phase, 'downloaded')
  })

  await check('取消接口：晚到的备份结果不放行、不弹框', async () => {
    factory.mode = 'ok'
    factory.delayMs = 40
    factory.runs = 0
    model.dialogs = []
    const pending = prepareAutomaticInstallOnQuit()
    await wait(10)
    cancelAutomaticInstallPreparation()
    const result = await pending
    factory.delayMs = 0
    assert.equal(result.install, false)
    assert.equal(result.reason, 'aborted')
    await wait(80)
    assert.equal(globalThis.__yanUpdater.autoInstallOnAppQuit, false, '晚到的成功不能重新放行')
    assert.equal(model.dialogs.length, 0, '取消后不再弹框')
  })

  await check('传进来的 AbortSignal 生效，备份失败也不再弹框', async () => {
    factory.mode = 'fail'
    factory.delayMs = 40
    model.dialogs = []
    const controller = new AbortController()
    const pending = prepareAutomaticInstallOnQuit({ signal: controller.signal })
    await wait(10)
    controller.abort()
    const result = await pending
    factory.delayMs = 0
    assert.equal(result.install, false)
    assert.equal(result.reason, 'aborted')
    await wait(30)
    assert.equal(model.dialogs.length, 0)
    assert.equal(globalThis.__yanUpdater.autoInstallOnAppQuit, false)
    factory.mode = 'ok'
  })

  await check('信号已取消时直接返回，不再备份', async () => {
    factory.runs = 0
    const controller = new AbortController()
    controller.abort()
    const result = await prepareAutomaticInstallOnQuit({ signal: controller.signal })
    assert.equal(result.install, false)
    assert.equal(result.reason, 'aborted')
    assert.equal(factory.runs, 0)
  })

  assert.equal((await run('status')).phase, 'downloaded', '测试前置：进入待重启状态')

  await check('安装前先做备份，成功后才重启', async () => {
    factory.mode = 'ok'
    model.installs = 0
    const result = await run('install')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.backup, '返回备份摘要')
    await wait(400)
    assert.equal(model.installs, 1)
  })

  await check('备份失败时对话框默认取消，不安装且解锁可重试', async () => {
    factory.mode = 'fail'
    model.installs = 0
    model.answer = 1
    model.dialogs = []
    const result = await run('install')
    assert.equal(result.ok, false)
    assert.equal(model.dialogs.length, 1, '应当询问用户')
    await wait(400)
    assert.equal(model.installs, 0)
    factory.mode = 'ok'
    const retry = await run('install')
    assert.equal(retry.ok, true, '失败后不应一直锁着')
    await wait(400)
    assert.equal(model.installs, 1)
  })

  await check('备份失败但用户选择继续安装时才安装', async () => {
    factory.mode = 'fail'
    model.installs = 0
    model.answer = 0
    const result = await run('install')
    assert.equal(result.ok, true)
    await wait(400)
    assert.equal(model.installs, 1)
    model.answer = 1
  })

  await check('对话框本身抛错时不安装，也不卡住安装锁', async () => {
    factory.mode = 'fail'
    model.installs = 0
    model.dialogThrows = true
    const result = await run('install').catch((error) => ({ ok: false, error: error.message }))
    assert.equal(result.ok, false)
    model.dialogThrows = false
    await wait(400)
    assert.equal(model.installs, 0)
    factory.mode = 'ok'
    const retry = await run('install')
    assert.equal(retry.ok, true)
    await wait(400)
    assert.equal(model.installs, 1)
  })

  await check('备份期间来了新工作就取消这次重启', async () => {
    factory.mode = 'ok'
    factory.delayMs = 30
    factory.onRun = () => {
      model.busy = false
      setTimeout(() => {
        model.busy = true
      }, 10)
    }
    model.installs = 0
    const result = await run('install')
    factory.onRun = null
    factory.delayMs = 0
    assert.equal(result.ok, false, JSON.stringify(result))
    await wait(400)
    assert.equal(model.installs, 0)
    model.busy = false
  })

  await check('备份之后到重启之间又忙起来就不重启', async () => {
    factory.mode = 'ok'
    model.installs = 0
    const result = await run('install')
    assert.equal(result.ok, true)
    model.busy = true
    await wait(450)
    assert.equal(model.installs, 0, '定时器里要再核对一次')
    assert.match((await run('status')).error ?? '', /任务/)
    model.busy = false
  })
await check('手动安装已经备份过，退出准备不再备份第二次', async () => {
  factory.mode = 'ok'
  factory.runs = 0
  model.installs = 0
  const manual = await run('install')
  assert.equal(manual.ok, true)
  await wait(400)
  assert.equal(model.installs, 1)
  const afterManual = factory.runs
  const prepared = await prepareAutomaticInstallOnQuit()
  assert.equal(prepared.install, true)
  assert.equal(prepared.reason, 'backed-up')
  assert.equal(factory.runs, afterManual, '手动安装刚备份过，不应再备份')
})

await check('手动安装选择不备份继续时，退出准备沿用这个决定', async () => {
  globalThis.__yanUpdater.emit('update-downloaded')
  factory.mode = 'fail'
  model.answer = 0
  model.installs = 0
  const manual = await run('install')
  assert.equal(manual.ok, true)
  await wait(400)
  assert.equal(model.installs, 1)
  model.answer = 1
  factory.mode = 'ok'
  const afterManual = factory.runs
  const prepared = await prepareAutomaticInstallOnQuit()
  assert.equal(prepared.install, true)
  assert.equal(prepared.reason, 'accepted-without-backup')
  assert.equal(factory.runs, afterManual)
})
} finally {
  delete globalThis.__yanUpdateModel
  delete globalThis.__yanUpdater
  await rm(model.directory, { recursive: true, force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 更新前自动备份：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
