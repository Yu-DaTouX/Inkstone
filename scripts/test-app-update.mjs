import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
      builder.onLoad({ filter: /.*/, namespace: 'update-host' }, ({ path }) => ({ contents: path === 'electron' ? `const m=globalThis.__inkstoneUpdateTest;export const app={getVersion:()=> '0.3.2',getPath:()=>m.directory,get isPackaged(){return m.packaged}};export const net={fetch:async()=>{m.calls++;await new Promise(r=>setTimeout(r,10));return {ok:true,json:async()=>m.release}}}` : `import {EventEmitter} from 'node:events';const m=globalThis.__inkstoneUpdateTest;export const autoUpdater=new EventEmitter();autoUpdater.setFeedURL=()=>{};autoUpdater.checkForUpdates=async()=>({updateInfo:{version:m.release.tag_name.slice(1)}});autoUpdater.downloadUpdate=async()=>{autoUpdater.emit('download-progress',{percent:50});autoUpdater.emit('update-downloaded')};autoUpdater.quitAndInstall=()=>m.installs++;globalThis.__inkstoneTestUpdater=autoUpdater;` }))
    } }] })
    const { registerAppUpdate } = await import('../out/test/app-update.mjs')
    const handlers = new Map(); let busy = false
    registerAppUpdate({ handle: (channel, fn) => handlers.set(channel, fn) }, () => busy)
    const run = (name, ...args) => handlers.get(`yan:update:${name}`)(...args)
    await new Promise((resolve) => setTimeout(resolve, 30))
    ok(globalThis.__inkstoneTestUpdater.autoDownload === false && globalThis.__inkstoneTestUpdater.autoInstallOnAppQuit === false, '更新不会自动下载或退出时自行安装')
    ok((await run('check')).phase === 'current', '公开版本较旧时不降级')
    const before = model.calls; await Promise.all([run('check'), run('check')])
    ok(model.calls === before + 1, '重复检查合并为一笔请求')
    model.release = { ...model.release, tag_name: 'v0.3.3' }; model.packaged = true
    ok((await run('check')).phase === 'manual', '缺少 latest.yml 的发布提供手动安装')
    model.release.assets = [{ name: 'latest.yml' }]
    ok((await run('check')).phase === 'available', '安装版和更新元数据齐备时允许下载')
    ok(run('install').ok === false, '未下载完成时拒绝安装')
    await run('download')
    ok((await run('status')).phase === 'downloaded', '下载完成进入待重启状态')
    busy = true
    ok(run('install').ok === false && model.installs === 0, '运行任务时拒绝重启安装')
    await run('automatic', false)
    ok(JSON.parse(await readFile(join(directory, 'update-preferences.json'), 'utf8')).automatic === false, '启动检查偏好写入独立用户目录')
  } finally {
    delete globalThis.__inkstoneUpdateTest; delete globalThis.__inkstoneTestUpdater
    await rm(directory, { recursive: true, force: true })
  }
}
