import './lib/test-isolate.mjs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok) => {
  await runAppUpdateTests(ok)
})

export async function runAppUpdateTests(ok) {
  const directory = await mkdtemp(join(tmpdir(), 'inkstone-update-test-'))
  const model = { directory, packaged: false, release: { tag_name: 'v0.3.0', assets: [], html_url: 'https://github.com/Yu-DaTouX/Inkstone/releases/tag/v0.3.0' }, calls: 0, installs: [], dialogResponse: 1 }
  globalThis.__inkstoneUpdateTest = model
  try {
    const { build } = await import('esbuild')
    await build({ entryPoints: ['src/main/app-update.ts'], outfile: 'out/test/app-update.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'updater-test-host', setup(builder) {
      builder.onResolve({ filter: /^(electron|electron-updater)$/ }, ({ path }) => ({ path, namespace: 'update-host' }))
      builder.onLoad({ filter: /.*/, namespace: 'update-host' }, ({ path }) => ({ contents: path === 'electron' ? `const m=globalThis.__inkstoneUpdateTest;export const app={getVersion:()=> '0.3.2',getPath:()=>m.directory,get isPackaged(){return m.packaged}};export const net={fetch:async(url,init)=>{m.calls++;await new Promise(r=>setTimeout(r,10));if(m.fetch)return m.fetch(String(url),init);return {ok:true,json:async()=>m.release}}};export class BrowserWindow{static getAllWindows(){return []}};export const dialog={showMessageBox:async()=>({response:m.dialogResponse}),showErrorBox(){}}` : `import {EventEmitter} from 'node:events';const m=globalThis.__inkstoneUpdateTest;export const autoUpdater=new EventEmitter();autoUpdater.setFeedURL=()=>{};autoUpdater.checkForUpdates=async()=>{if(m.feedFails)throw new Error('no latest.yml');return {updateInfo:{version:m.release.tag_name.slice(1)}}};autoUpdater.downloadUpdate=async()=>{autoUpdater.emit('download-progress',{percent:50});autoUpdater.emit('update-downloaded')};autoUpdater.quitAndInstall=(...args)=>{m.installs.push(args);if(m.installFails)autoUpdater.emit('error',new Error('installer unavailable'))};globalThis.__inkstoneTestUpdater=autoUpdater;` }))
    } }] })
    const { registerAppUpdate } = await import('../out/test/app-update.mjs')
    const handlers = new Map(); let busy = false
    const exits = []
    const backups = []
    let backupFails = false
    const control = registerAppUpdate({ handle: (channel, fn) => handlers.set(channel, fn) }, () => busy, async (source) => {
      exits.push(source)
      return true
    }, async (interactive) => {
      backups.push(interactive)
      if (backupFails) throw new Error('disk full')
      return { path: 'fixture-backup' }
    })
    const run = (name, ...args) => handlers.get(`yan:update:${name}`)(...args)
    await new Promise((resolve) => setTimeout(resolve, 30))
    ok(globalThis.__inkstoneTestUpdater.autoDownload === false && globalThis.__inkstoneTestUpdater.autoInstallOnAppQuit === false, '开发版不会退出时自行安装')
    await run('automatic', false)
    ok((await run('check')).phase === 'current', '公开版本较旧时不降级')
    const before = model.calls; await Promise.all([run('check'), run('check')])
    ok(model.calls === before + 1, '重复检查合并为一笔请求')
    model.release = { ...model.release, tag_name: 'v0.3.3' }; model.packaged = true
    ok((await run('check')).phase === 'manual', '缺少 latest.yml 的发布提供手动安装')
    const tagPage = 'https://github.com/Yu-DaTouX/Inkstone/releases/tag/v0.3.3'
    const fetched = []
    model.fetch = (url, init) => {
      fetched.push(`${init?.method ?? 'GET'} ${url}`)
      return url.startsWith('https://api.github.com/') ? { ok: false, status: 403 } : { ok: true, status: 200, url: tagPage }
    }
    const limited = await run('check')
    ok(limited.phase === 'available' && limited.latest === '0.3.3' && limited.releaseUrl === tagPage && fetched.at(-1) === 'HEAD https://github.com/Yu-DaTouX/Inkstone/releases/latest', 'GitHub API 限流 403 时改从网页跳转读取最新版本', JSON.stringify({ limited, fetched }))
    model.feedFails = true
    ok((await run('check')).phase === 'manual', '限流回退时更新元数据取不到就提供手动安装')
    model.feedFails = false
    model.fetch = (url) => url.startsWith('https://api.github.com/') ? { ok: false, status: 500 } : { ok: true, status: 200, url: tagPage }
    const failed = await run('check')
    ok(failed.phase === 'error' && failed.error === 'GitHub HTTP 500', '非限流错误照常报错，不走网页回退')
    model.fetch = undefined
    model.release.assets = [{ name: 'latest.yml' }]
    ok((await run('check')).phase === 'available', '安装版和更新元数据齐备时允许下载')
    ok((await run('install')).ok === false, '未下载完成时拒绝安装')
    await run('download')
    ok((await run('status')).phase === 'downloaded', '下载完成进入待重启状态')
    busy = true
    ok((await run('install')).ok === false && model.installs.length === 0, '运行任务时拒绝重启安装')
    ok(JSON.parse(await readFile(join(directory, 'update-preferences.json'), 'utf8')).automatic === false, '启动检查偏好写入独立用户目录')
    const prefsFile = join(directory, 'update-preferences.json')
    const current = (await run('status')).current
    ok((await run('whatsNew')) === null && JSON.parse(await readFile(prefsFile, 'utf8')).seenVersion === current, '第一次运行只记下版本，不弹更新说明')
    ok((await run('whatsNew')) === null, '同一版本不重复弹')
    await writeFile(prefsFile, JSON.stringify({ automatic: false, seenVersion: '0.0.1', notes: { version: current, text: '## 新增' } }))
    const shown = await run('whatsNew')
    ok(shown?.version === current && shown?.notes === '## 新增', '升级后第一次启动返回这个版本的更新说明')
    ok((await run('whatsNew'))?.version === current, '没点知道了之前下次还会弹')
    await run('whatsNewSeen', '9.9.9')
    ok((await run('whatsNew'))?.version === current, '别的版本号不能标记已读')
    await run('whatsNewSeen', current)
    ok((await run('whatsNew')) === null && JSON.parse(await readFile(prefsFile, 'utf8')).notes === undefined, '看过后不再弹，并清掉暂存内容')
    await writeFile(prefsFile, JSON.stringify({ automatic: true, seenVersion: '0.0.1' }))
    ok((await run('whatsNew')) === null, '取不到更新说明时不弹空窗口')
    await writeFile(prefsFile, JSON.stringify({ automatic: true, seenVersion: '0.0.1' }))
    model.fetch = () => ({ ok: false, status: 403 })
    ok((await run('whatsNew')) === null && JSON.parse(await readFile(prefsFile, 'utf8')).seenVersion === '0.0.1', '更新说明被限流时不标记已读，下次启动再取')
    model.fetch = undefined
    ok((await readdir(directory)).every((name) => !name.endsWith('.tmp') && name !== 'update-preferences.json.tmp'), '偏好写入走原子写，不留固定名 .tmp 临时文件', (await readdir(directory)).join(','))

    const updater = globalThis.__inkstoneTestUpdater
    busy = false
    ok(!(await control.prepareInstallOnQuit()).install && backups.length === 0, '关闭自动更新时普通退出不备份、不安装')
    await run('automatic', true)
    backupFails = true
    ok(!(await control.prepareInstallOnQuit()).install && !control.installAfterShutdown(), '普通退出备份失败后可取消安装')
    model.dialogResponse = 0
    const unbacked = await control.prepareInstallOnQuit()
    ok(unbacked.install && unbacked.reason === 'accepted-without-backup', '普通退出备份失败后可明确接受无备份安装')
    control.cancelInstallPreparation()
    ok(!control.installAfterShutdown() && model.installs.length === 0, '取消已准备的安装不会启动安装器')
    backupFails = false
    const ordinary = await control.prepareInstallOnQuit()
    ok(ordinary.install && updater.autoInstallOnAppQuit === false && model.installs.length === 0, '普通退出预检只授权，不开启自动退出安装，也不提前启动安装器')
    ok(control.installAfterShutdown() && !control.installAfterShutdown() && JSON.stringify(model.installs) === '[[true,false]]', '普通退出显式静默安装一次，不自动重启')

    await run('automatic', false)
    backupFails = true
    model.dialogResponse = 1
    ok(!(await run('install')).ok && exits.length === 0, '手动备份失败后取消，保持应用打开')
    backupFails = false
    const manual = await run('install')
    busy = true
    await new Promise((resolve) => setTimeout(resolve, 320))
    ok(manual.ok && exits.length === 0, '手动安装在备份后再次发现忙碌，不请求退出')
    busy = false
    ok((await run('install')).ok, '忙碌取消后可以重试手动安装')
    await new Promise((resolve) => setTimeout(resolve, 320))
    ok(exits.join(',') === 'manual' && model.installs.length === 1 && backups.at(-1) === true, '手动安装保留交互备份，只请求退出，不启动安装器')
    const backupCount = backups.length
    ok((await control.prepareInstallOnQuit()).install && backups.length === backupCount, '手动安装即使关闭自动更新也可获授权，复用刚完成的备份')
    model.installFails = true
    ok(!control.installAfterShutdown() && !control.installAfterShutdown() && JSON.stringify(model.installs) === '[[true,false],[true,true]]', '手动安装要求重启；同步启动失败时只尝试一次，并允许正常退出')
  } finally {
    delete globalThis.__inkstoneUpdateTest; delete globalThis.__inkstoneTestUpdater
    await rm(directory, { recursive: true, force: true })
  }
}
