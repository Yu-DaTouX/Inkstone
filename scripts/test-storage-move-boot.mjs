import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, lstat, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const host = {
  name: 'storage-move-boot-host',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, ({ path }) => ({ path, namespace: 'boot-host' }))
    b.onLoad({ filter: /.*/, namespace: 'boot-host' }, () => ({
      loader: 'js',
      contents: `import { EventEmitter } from 'node:events';
const m=globalThis.__storageMoveBoot;const paths={userData:m.defaultUserData};
export const app=Object.assign(new EventEmitter(),{
  setPath(name,value){m.calls.push(['setPath',name,value]);paths[name]=value},
  getPath(name){return paths[name]},
  requestSingleInstanceLock(){m.calls.push(['lock',paths.userData]);return true},
  whenReady:()=>Promise.resolve(),getLocale:()=>'en'
});
export class BrowserWindow extends EventEmitter {
  constructor(){super();m.closeProgress=()=>{const next=new EventEmitter();app.emit('browser-window-created',{},next);next.emit('show')}}
  loadURL(){return Promise.resolve()}
  isDestroyed(){return false}
  destroy(){}
  webContents={isLoading:()=>true};
}
export const dialog={showMessageBox:()=>Promise.resolve()};export const nativeTheme={shouldUseDarkColors:false}`
    }))
  }
}

const disk = {
  name: 'storage-move-test-disk',
  setup(b) {
    b.onResolve({ filter: /^node:(os|fs)$/ }, ({ path, importer }) => importer ? { path, namespace: 'storage-disk' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'storage-disk' }, ({ path }) => ({
      loader: 'js',
      contents: path === 'node:os'
        ? `export const homedir=()=>globalThis.__storageMoveBoot.home`
        : `import { createRequire } from 'node:module';
const fs=createRequire(import.meta.url)('node:fs');
export const {createReadStream,existsSync,linkSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync}=fs;
export function symlinkSync(...args){
  const stop=globalThis.__storageMoveBoot.stop;
  if(stop==='before-junction')throw Error(stop);
  fs.symlinkSync(...args);
  if(stop==='after-junction')throw Error(stop);
}`
    }))
  }
}

const absent = async (path) => lstat(path).then(() => false, (error) => {
  if (error.code !== 'ENOENT') throw error
  return true
})

await runSuite(import.meta.url, async (ok, compile) => {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-storage-move-boot-'))
  const saved = Object.fromEntries(['YAN_USER_DATA', 'APPDATA', 'YAN_PI_DIR', 'PORTABLE_EXECUTABLE_DIR'].map((key) => [key, process.env[key]]))
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    process.env.APPDATA = join(root, 'appdata')
    process.env.YAN_PI_DIR = join(root, 'pi-agent')

    const isolated = join(root, 'isolated-user-data')
    process.env.YAN_USER_DATA = isolated
    globalThis.__storageMoveBoot = { defaultUserData: join(root, 'default-user-data'), calls: [] }
    await (await compile('src/main/storage-move-boot.ts', { plugins: [host] })).storageMoveReady
    const calls = globalThis.__storageMoveBoot.calls
    const lock = calls.find((call) => call[0] === 'lock')
    ok(!!lock, '模块加载时取得单实例锁')
    ok(lock[1] === isolated, '设了 YAN_USER_DATA 时，取锁前 userData 已指向隔离目录，不会和默认实例同锁', JSON.stringify(calls))

    delete process.env.YAN_USER_DATA
    globalThis.__storageMoveBoot = { defaultUserData: join(root, 'default-user-data'), calls: [] }
    await (await compile('src/main/storage-move-boot.ts', { plugins: [host] })).storageMoveReady
    const plain = globalThis.__storageMoveBoot.calls
    ok(!plain.some((call) => call[0] === 'setPath' && call[1] === 'userData'), '没设隔离目录时不改 userData', JSON.stringify(plain))
    ok(plain.find((call) => call[0] === 'lock')?.[1] === join(root, 'default-user-data'), '默认实例按默认 userData 取锁')

    delete process.env.YAN_PI_DIR
    delete process.env.PORTABLE_EXECUTABLE_DIR
    const fixture = async (name, stop, change) => {
      const folder = join(root, name)
      const home = join(folder, 'home')
      const from = join(home, '.pi', 'agent')
      const to = join(folder, 'target')
      process.env.APPDATA = join(folder, 'appdata')
      const control = join(process.env.APPDATA, 'yan-desktop')
      const pending = join(control, 'storage-move.json')
      const marker = join(control, 'storage-move-switch.json')
      const recordFile = join(control, 'storage-move-result.json')
      const hostState = globalThis.__storageMoveBoot = { defaultUserData: join(folder, 'userdata'), home, calls: [], stop }
      await mkdir(control, { recursive: true })
      await mkdir(from, { recursive: true })
      await writeFile(join(from, 'sample.txt'), 'original fixture')
      await writeFile(pending, JSON.stringify({ target: to }))
      const boot = async () => {
        try {
          const mod = await compile('src/main/storage-move-boot.ts', { plugins: [host, disk] })
          await mod.storageMoveReady
        } finally {
          hostState.closeProgress?.()
        }
      }
      if (stop) {
        await assert.rejects(boot(), /storage-move-switch\.json/)
        ok(await absent(pending), `${name}：切换恢复不依赖待迁移请求`)
      } else {
        await boot()
      }
      const record = JSON.parse(await readFile(stop ? marker : recordFile, 'utf8'))
      const backup = stop ? record.backup : record.leftover
      ok(await readFile(join(backup, 'sample.txt'), 'utf8') === 'original fixture', `${name}：原数据保留在备份`)
      hostState.stop = undefined
      const paths = { from, to, backup, marker, pending, record, boot, recordFile }
      if (change) await change(paths)
      return paths
    }
    const assertDone = async ({ from, to, backup, marker, recordFile }) => {
      const result = JSON.parse(await readFile(recordFile, 'utf8'))
      ok((await lstat(from)).isSymbolicLink() && await realpath(from) === await realpath(to), '启动后原位置指向经核对的目标')
      ok(result.ok && result.leftover === backup && await absent(marker), '切换成功，记录了备份并清理切换标记')
      ok(await readFile(join(backup, 'sample.txt'), 'utf8') === 'original fixture', '启动后备份仍未被删除')
    }
    await assertDone(await fixture('normal'))
    await assertDone(await fixture('rename-gap', 'before-junction', async ({ from, boot }) => {
      ok(await absent(from), '模拟中断后原路径确实不存在')
      await boot()
    }))
    await assertDone(await fixture('junction-created', 'after-junction', async ({ boot }) => { await boot() }))
    await fixture('before-rename', 'before-junction', async ({ from, to, backup, marker, boot }) => {
      await rename(backup, from)
      await boot()
      ok(!(await lstat(from)).isSymbolicLink() && await absent(marker), '切换前中断继续使用原目录，不覆盖它')
      ok(await readFile(join(to, 'sample.txt'), 'utf8') === 'original fixture', '切换前中断不删除目标副本')
    })
    await fixture('occupied-original', 'before-junction', async ({ from, backup, marker, boot }) => {
      await mkdir(from)
      await assert.rejects(boot(), /storage-move-switch\.json/)
      ok((await lstat(from)).isDirectory() && !(await absent(marker)), '原位置出现空目录时拒绝启动，且不覆盖、不清理标记')
      ok(!(await absent(backup)), '冲突时不动备份')
    })
    await fixture('wrong-junction', 'before-junction', async ({ from, backup, boot }) => {
      await symlink(backup, from, 'junction')
      await assert.rejects(boot())
      ok(await realpath(from) === await realpath(backup), '原位置的 junction 指向备份而非目标时拦截，不替换现有链接')
    })
    await fixture('replaced-target', 'before-junction', async ({ from, to, boot }) => {
      await rename(to, `${to}-moved`)
      await mkdir(to)
      await writeFile(join(to, 'sample.txt'), 'original fixture')
      await assert.rejects(boot(), /storage-move-switch\.json/)
      ok(await absent(from), '路径和内容相同但身份不同的目标不能被接入')
    })
    await fixture('target-emptied', 'before-junction', async ({ from, to, boot }) => {
      await rm(join(to, 'sample.txt'))
      await assert.rejects(boot(), /storage-move-switch\.json/)
      ok(await absent(from), '不能接入被清空的目标，即使目录身份未变')
    })
    await fixture('legacy-gap', 'before-junction', async ({ from, backup, marker, boot }) => {
      await rm(marker)
      await rename(backup, `${from}.迁移前备份-${Date.now()}`)
      await assert.rejects(boot())
      ok(await absent(from), '旧版仅含时间戳的真备份也能阻止在缺失原位置启动')
      await mkdir(from)
      await assert.rejects(boot())
      ok(!(await lstat(from)).isSymbolicLink(), '旧版本已创建空原目录时也阻止启动')
      await writeFile(join(from, 'restored.txt'), 'manual restore')
      await boot()
      ok(await readFile(join(from, 'restored.txt'), 'utf8') === 'manual restore', '原目录已恢复且没有切换标记，允许保留备份并启动')
    })
    await fixture('unrelated-siblings', 'before-junction', async ({ from, to, backup, marker, boot }) => {
      await rm(marker)
      await rename(backup, `${from}.迁移前备份-unrelated`)
      await writeFile(`${from}.迁移前备份-${Date.now() - 1000}`, 'not a backup folder')
      await symlink(to, `${from}.迁移前备份-${Date.now()}`, 'junction')
      await boot()
      ok(await absent(from), '同前缀的普通目录、同模板的文件或链接不构成遗留中断证据')
      await mkdir(from)
      await boot()
      ok(!(await lstat(from)).isSymbolicLink(), '同前缀无关项不阻止空目录的正常首次启动')
    })
    await fixture('wrong-backup-path', 'before-junction', async ({ from, to, backup, marker, record, boot }) => {
      await writeFile(marker, JSON.stringify({ ...record, backup: to }))
      await assert.rejects(boot(), /storage-move-switch\.json/)
      ok(await absent(from) && !(await absent(backup)), '标记不能把目标目录冒充为原目录备份')
    })
    await fixture('invalid-marker', 'before-junction', async ({ from, to, marker, pending, boot }) => {
      await writeFile(marker, '{"version":1')
      await writeFile(pending, JSON.stringify({ target: to }))
      await assert.rejects(boot(), /storage-move-switch\.json/)
      ok(await absent(from) && !(await absent(pending)), '损坏的切换标记阻止启动，不能退回普通迁移流程')
      process.env.YAN_PI_DIR = join(root, 'isolated-agent')
      try {
        await boot()
        ok(await absent(from) && !(await absent(marker)), '显式使用独立 YAN_PI_DIR 时不碰默认位置或迁移标记')
      } finally {
        delete process.env.YAN_PI_DIR
      }
    })
  } finally {
    restore()
    delete globalThis.__storageMoveBoot
    await rm(root, { recursive: true, force: true })
  }
})
