import './lib/test-isolate.mjs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const host = {
  name: 'startup-update-host',
  setup(b) {
    b.onResolve({ filter: /^(electron|electron-updater)$/ }, ({ path }) => ({ path, namespace: 'startup-host' }))
    b.onLoad({ filter: /.*/, namespace: 'startup-host' }, ({ path }) => ({
      loader: 'js',
      contents: path === 'electron'
        ? `const m=globalThis.__startupUpdate;export const app={getVersion:()=>m.current,getPath:()=>m.directory,get isPackaged(){return true}};export const net={fetch:async()=>({ok:true,json:async()=>m.release})};export class BrowserWindow{static getAllWindows(){return []}};export const dialog={showMessageBox:async()=>({response:1}),showErrorBox(){}}`
        : `import {EventEmitter} from 'node:events';const m=globalThis.__startupUpdate;export const autoUpdater=new EventEmitter();autoUpdater.setFeedURL=()=>autoUpdater.removeAllListeners();autoUpdater.checkForUpdates=async()=>({updateInfo:{version:m.release.tag_name.slice(1)}});autoUpdater.downloadUpdate=async()=>{autoUpdater.emit('update-downloaded',{version:m.release.tag_name.slice(1)})};autoUpdater.quitAndInstall=(...args)=>m.installs.push(args);`
    }))
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settledPhases = new Set(['downloaded', 'current', 'error', 'manual', 'available'])

await runSuite(import.meta.url, async (ok, compile) => {
  const shared = await compile('src/shared/app-update.ts')
  const probe = { pending: '0.3.3', downloaded: '0.3.3', current: '0.3.2', automatic: true, busy: false, sinceLaunchMs: 5000 }
  ok(shared.startupInstallDue(probe), '上次已下载的版本在启动时就绪即安装')
  ok(!shared.startupInstallDue({ ...probe, pending: undefined }), '这次运行里才下载完的更新不在中途安装')
  ok(!shared.startupInstallDue({ ...probe, downloaded: '0.3.4' }), '启动时发现更新的版本是新下载，留到退出或下次启动')
  ok(!shared.startupInstallDue({ ...probe, current: '0.3.3' }), '已经是这个版本时不再安装')
  ok(!shared.startupInstallDue({ ...probe, automatic: false }), '关了自动更新不安装')
  ok(!shared.startupInstallDue({ ...probe, busy: true }), '启动时已有任务在跑不安装')
  ok(!shared.startupInstallDue({ ...probe, sinceLaunchMs: shared.STARTUP_INSTALL_WINDOW_MS + 1 }), '启动很久后才就绪的不算启动安装')

  const directory = await mkdtemp(join(tmpdir(), 'inkstone-startup-update-'))
  const prefsFile = join(directory, 'update-preferences.json')
  const model = { directory, current: '0.3.2', installs: [], release: { tag_name: 'v0.3.3', assets: [{ name: 'latest.yml' }], html_url: '' } }
  globalThis.__startupUpdate = model
  try {
    const mod = await compile('src/main/app-update.ts', { plugins: [host] })
    let backups = 0
    let backupFails = false
    const backup = async () => {
      backups++
      if (backupFails) throw new Error('disk full')
      return { file: 'b.zip' }
    }
    const exits = []
    const requestExit = async (source) => { exits.push(source); return true }
    const launch = async (busy = false) => {
      const handlers = new Map()
      const control = mod.registerAppUpdate({ handle: (channel, fn) => handlers.set(channel, fn) }, () => busy, requestExit, backup)
      const call = (name, ...args) => handlers.get(`yan:update:${name}`)(...args)
      const deadline = Date.now() + 20_000
      for (let status = await call('status'); Date.now() < deadline && status.automatic && !settledPhases.has(status.phase); status = await call('status')) await wait(10)
      await wait(20)
      await call('automatic', (await call('status')).automatic)
      return { call, control }
    }
    const prefsWhen = async (accept) => {
      const deadline = Date.now() + 20_000
      for (;;) {
        const prefs = await readFile(prefsFile, 'utf8').then((text) => JSON.parse(text), () => null)
        if ((prefs && accept(prefs)) || Date.now() > deadline) return prefs ?? {}
        await wait(10)
      }
    }

    await launch()
    ok(exits.length === 0 && model.installs.length === 0, '第一次发现并下载完更新时不请求退出安装')
    ok((await prefsWhen((prefs) => prefs.pending === '0.3.3')).pending === '0.3.3', '记下已下载待装的版本')

    model.installs = []
    await launch(true)
    ok(exits.length === 0 && model.installs.length === 0, '下次启动时有任务在跑就不装，留到退出时')

    model.installs = []
    backupFails = true
    const before = backups
    await launch()
    ok(exits.length === 0 && model.installs.length === 0 && backups === before + 1, '启动时备份失败不退出安装')
    backupFails = false

    model.installs = []
    const resumed = await launch()
    ok(exits.join(',') === 'startup' && model.installs.length === 0, '下次启动时备份后只请求协调退出')
    const backupCount = backups
    const preparedStartup = await resumed.control.prepareInstallOnQuit()
    ok(preparedStartup.install && backups === backupCount, '启动续装预检复用成功备份，不重复备份')
    ok(resumed.control.installAfterShutdown() && !resumed.control.installAfterShutdown() && JSON.stringify(model.installs) === '[[true,true]]', '启动续装完成清理后显式安装一次并重新打开')

    model.installs = []
    model.current = '0.3.3'
    await launch()
    const cleared = await prefsWhen((prefs) => prefs.pending === undefined)
    ok(model.installs.length === 0 && cleared.pending === undefined, '装好后启动清掉待装记录，不重复安装', `installs=${model.installs.length} prefs=${JSON.stringify(cleared)}`)

    await writeFile(prefsFile, JSON.stringify({ automatic: true, pending: '0.3.4' }))
    model.release = { ...model.release, tag_name: 'v0.3.4' }
    const handlers = new Map()
    let finishBackup
    let signalBackup
    const backupStarted = new Promise((resolve) => { signalBackup = resolve })
    const control = mod.registerAppUpdate({ handle: (name, fn) => handlers.set(name, fn) }, () => false, requestExit, () => new Promise((finish) => {
      finishBackup = finish
      signalBackup()
    }))
    await Promise.race([backupStarted, wait(2000).then(() => { if (!finishBackup) throw Error('startup backup did not begin') })])
    await handlers.get('yan:update:automatic')(false)
    finishBackup({ file: 'b.zip' })
    await wait(20)
    ok(exits.length === 1 && model.installs.length === 0, '启动备份期间关闭自动更新，备份完成后不请求安装退出')

    await handlers.get('yan:update:automatic')(true)
    finishBackup = undefined
    const preparing = control.prepareInstallOnQuit()
    if (!finishBackup) throw Error('quit backup did not begin')
    await handlers.get('yan:update:automatic')(false)
    finishBackup({ file: 'b.zip' })
    const prepared = await preparing
    ok(!prepared.install && prepared.reason === 'disabled', '退出备份期间关闭自动更新，不授权退出安装')

    await handlers.get('yan:update:automatic')(true)
    const preparingAgain = control.prepareInstallOnQuit()
    finishBackup({ file: 'b.zip' })
    ok((await preparingAgain).install, '自动退出安装已完成预检')
    await handlers.get('yan:update:automatic')(false)
    ok(!control.installAfterShutdown() && model.installs.length === 0, '通过预检后关闭自动更新，仍然不启动安装器')

    await writeFile(prefsFile, JSON.stringify({ automatic: false, pending: '0.3.4' }))
    model.release = { ...model.release, tag_name: 'v0.3.4' }
    model.installs = []
    const { call } = await launch()
    await call('download')
    ok(model.installs.length === 0, '关了自动更新时启动不安装')
  } finally {
    delete globalThis.__startupUpdate
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
