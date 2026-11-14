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
        : `import {EventEmitter} from 'node:events';const m=globalThis.__startupUpdate;export const autoUpdater=new EventEmitter();autoUpdater.setFeedURL=()=>{};autoUpdater.checkForUpdates=async()=>({updateInfo:{version:m.release.tag_name.slice(1)}});autoUpdater.downloadUpdate=async()=>{autoUpdater.emit('update-downloaded',{version:m.release.tag_name.slice(1)})};autoUpdater.quitAndInstall=(...args)=>m.installs.push(args);`
    }))
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    const launch = async (busy = false) => {
      const handlers = new Map()
      mod.registerAppUpdate({ handle: (channel, fn) => handlers.set(channel, fn) }, () => busy, backup)
      await wait(40)
      return (name, ...args) => handlers.get(`yan:update:${name}`)(...args)
    }

    await launch()
    ok(model.installs.length === 0, '第一次发现并下载完更新时不安装')
    ok(JSON.parse(await readFile(prefsFile, 'utf8')).pending === '0.3.3', '记下已下载待装的版本')

    model.installs = []
    await launch(true)
    ok(model.installs.length === 0, '下次启动时有任务在跑就不装，留到退出时')

    model.installs = []
    backupFails = true
    const before = backups
    await launch()
    ok(model.installs.length === 0 && backups === before + 1, '启动时备份失败不安装')
    backupFails = false

    model.installs = []
    await launch()
    ok(model.installs.length === 1 && model.installs[0][0] === true && model.installs[0][1] === true, '下次启动时备份后静默安装并重新打开')

    model.installs = []
    model.current = '0.3.3'
    await launch()
    ok(model.installs.length === 0 && JSON.parse(await readFile(prefsFile, 'utf8')).pending === undefined, '装好后启动清掉待装记录，不重复安装')

    await writeFile(prefsFile, JSON.stringify({ automatic: false, pending: '0.3.4' }))
    model.release = { ...model.release, tag_name: 'v0.3.4' }
    model.installs = []
    const run = await launch()
    await run('download')
    ok(model.installs.length === 0, '关了自动更新时启动不安装')
  } finally {
    delete globalThis.__startupUpdate
    await rm(directory, { recursive: true, force: true })
  }
})
