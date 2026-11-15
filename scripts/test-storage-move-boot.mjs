import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const host = {
  name: 'storage-move-boot-host',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, ({ path }) => ({ path, namespace: 'boot-host' }))
    b.onLoad({ filter: /.*/, namespace: 'boot-host' }, () => ({
      loader: 'js',
      contents: `const m=globalThis.__storageMoveBoot;const paths={userData:m.defaultUserData};
export const app={
  setPath(name,value){m.calls.push(['setPath',name,value]);paths[name]=value},
  getPath(name){return paths[name]},
  requestSingleInstanceLock(){m.calls.push(['lock',paths.userData]);return true},
  whenReady:()=>new Promise(()=>{}),getLocale:()=>'en',on(){},off(){}
};
export class BrowserWindow{};export const dialog={};export const nativeTheme={shouldUseDarkColors:false}`
    }))
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-storage-move-boot-'))
  const saved = { YAN_USER_DATA: process.env.YAN_USER_DATA, APPDATA: process.env.APPDATA, YAN_PI_DIR: process.env.YAN_PI_DIR }
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
    await compile('src/main/storage-move-boot.ts', { plugins: [host] })
    const calls = globalThis.__storageMoveBoot.calls
    const lock = calls.find((call) => call[0] === 'lock')
    ok(!!lock, '模块加载时取得单实例锁')
    ok(lock[1] === isolated, '设了 YAN_USER_DATA 时，取锁前 userData 已指向隔离目录，不会和默认实例同锁', JSON.stringify(calls))

    delete process.env.YAN_USER_DATA
    globalThis.__storageMoveBoot = { defaultUserData: join(root, 'default-user-data'), calls: [] }
    await compile('src/main/storage-move-boot.ts', { plugins: [host] })
    const plain = globalThis.__storageMoveBoot.calls
    ok(!plain.some((call) => call[0] === 'setPath' && call[1] === 'userData'), '没设隔离目录时不改 userData', JSON.stringify(plain))
    ok(plain.find((call) => call[0] === 'lock')?.[1] === join(root, 'default-user-data'), '默认实例按默认 userData 取锁')
  } finally {
    restore()
    delete globalThis.__storageMoveBoot
    await rm(root, { recursive: true, force: true })
  }
})
