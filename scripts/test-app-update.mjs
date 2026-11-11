import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runAppUpdateTests(ok) {
  const directory = await mkdtemp(join(tmpdir(), 'inkstone-update-test-'))
  const model = { directory, packaged: false, release: { tag_name: 'v0.3.0', assets: [], html_url: 'https://github.com/Yu-DaTouX/Inkstone/releases/tag/v0.3.0' }, calls: 0, installs: 0 }
  globalThis.__inkstoneUpdateTest = model
  try {
    const { build } = await import('esbuild')
    await build({ entryPoints: ['src/main/app-update.ts'], outfile: 'out/test/app-update.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'updater-test-host', setup(builder) {
      builder.onResolve({ filter: /^(electron|electron-updater)$/ }, ({ path }) => ({ path, namespace: 'update-host' }))
      builder.onLoad({ filter: /.*/, namespace: 'update-host' }, ({ path }) => ({ contents: path === 'electron' ? `const m=globalThis.__inkstoneUpdateTest;export const app={getVersion:()=> '0.3.2',getPath:()=>m.directory,get isPackaged(){return m.packaged}};export const net={fetch:async()=>{m.calls++;await new Promise(r=>setTimeout(r,10));return {ok:true,json:async()=>m.release}}};export class BrowserWindow{static getAllWindows(){return []}};export const dialog={showMessageBox:async()=>({response:1}),showErrorBox(){}}` : `import {EventEmitter} from 'node:events';const m=globalThis.__inkstoneUpdateTest;export const autoUpdater=new EventEmitter();autoUpdater.setFeedURL=()=>{};autoUpdater.checkForUpdates=async()=>({updateInfo:{version:m.release.tag_name.slice(1)}});autoUpdater.downloadUpdate=async()=>{autoUpdater.emit('download-progress',{percent:50});autoUpdater.emit('update-downloaded')};autoUpdater.quitAndInstall=()=>m.installs++;globalThis.__inkstoneTestUpdater=autoUpdater;` }))
    } }] })
    const { registerAppUpdate } = await import('../out/test/app-update.mjs')
    const handlers = new Map(); let busy = false
    registerAppUpdate({ handle: (channel, fn) => handlers.set(channel, fn) }, () => busy)
    const run = (name, ...args) => handlers.get(`yan:update:${name}`)(...args)
    await new Promise((resolve) => setTimeout(resolve, 30))
    ok(globalThis.__inkstoneTestUpdater.autoDownload === false && globalThis.__inkstoneTestUpdater.autoInstallOnAppQuit === false, '开发版不会退出时自行安装')
    await run('automatic', false)
    ok((await run('check')).phase === 'current', '公开版本较旧时不降级')
    const before = model.calls; await Promise.all([run('check'), run('check')])
    ok(model.calls === before + 1, '重复检查合并为一笔请求')
    model.release = { ...model.release, tag_name: 'v0.3.3' }; model.packaged = true
    ok((await run('check')).phase === 'manual', '缺少 latest.yml 的发布提供手动安装')
    model.release.assets = [{ name: 'latest.yml' }]
    ok((await run('check')).phase === 'available', '安装版和更新元数据齐备时允许下载')
    ok((await run('install')).ok === false, '未下载完成时拒绝安装')
    await run('download')
    ok((await run('status')).phase === 'downloaded', '下载完成进入待重启状态')
    busy = true
    ok((await run('install')).ok === false && model.installs === 0, '运行任务时拒绝重启安装')
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
  } finally {
    delete globalThis.__inkstoneUpdateTest; delete globalThis.__inkstoneTestUpdater
    await rm(directory, { recursive: true, force: true })
  }
}
