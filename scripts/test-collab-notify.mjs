import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-collab-notify-'))

const electronStub = {
  name: 'electron-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
      loader: 'js',
      contents: [
        'export const app = { getLocale: () => "zh-CN", getPath: () => process.env.YAN_USER_DATA, getVersion: () => "0.0.0", getName: () => "stub", whenReady: async () => undefined, on() {}, once() {}, quit() {} }',
        'export const Notification = class { static isSupported() { return true } constructor(options) { this.options = options } show() { globalThis.__notifyShown = (globalThis.__notifyShown ?? 0) + 1 } on() {} }',
        'export const shell = { openExternal: async () => undefined, openPath: async () => undefined, showItemInFolder() {} }',
        'export const ipcMain = { handle() {}, on() {}, removeHandler() {} }',
        'export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) }',
        'export const clipboard = { readText: () => "", writeText() {} }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true }), createFromPath: () => ({ isEmpty: () => true }) }',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }',
        'export const BrowserWindow = class { static getAllWindows() { return [] } }',
        'export const Menu = { buildFromTemplate: (t) => t, setApplicationMenu() {}, getApplicationMenu: () => null }',
        'export const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }), getAllDisplays: () => [], getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }) }',
        'export default {}'
      ].join('\n')
    }))
  }
}

const request = {
  id: 'req-1',
  direction: 'incoming',
  peerName: '砚 · 另一台电脑',
  localProjectId: 'p-1',
  projectName: '项目',
  branch: 'feat/x',
  trackingRef: 'refs/remotes/yan-other/feat/x',
  oid: 'a'.repeat(40),
  title: '合并请求',
  note: '',
  createdAt: 1,
  status: 'open'
}

const run = async (name, settings) => {
  const dataDir = join(root, name)
  await mkdir(dataDir, { recursive: true })
  if (settings) await writeFile(join(dataDir, 'desktop.json'), JSON.stringify(settings), 'utf8')
  const outfile = join(root, `${name}.mjs`)
  await build({ entryPoints: ['src/main/ipc/collab-ipc.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub] })
  process.env.YAN_DATA_DIR = dataDir
  process.env.YAN_USER_DATA = dataDir
  const { registerCollabIpc } = await import(pathToFileURL(outfile).href)
  globalThis.__notifyShown = 0
  const service = registerCollabIpc({ handle() {} }, {
    peerClient: { status: async () => ({ peers: [], imports: [] }) },
    peerHost: {},
    worktreeLinks: { load: async () => undefined, links: () => [] },
    win: () => null
  })
  await service.receiveRequest(request)
  await new Promise((resolve) => setTimeout(resolve, 50))
  return globalThis.__notifyShown
}

try {
  assert.equal(await run('default', null), 0, '提示音总开关默认关闭时不弹协作通知')
  assert.equal(await run('muted', { sound: { enabled: true, notifications: false, volume: 0.4, events: { done: true, question: true, error: true } } }), 0, '关闭通知时不弹协作通知')
  assert.equal(await run('enabled', { sound: { enabled: true, notifications: true, volume: 0.4, events: { done: true, question: true, error: true } } }), 1, '总开关与通知都开启时弹一次协作通知')
  console.log('collab-notify: 合并请求通知跟随提示音总开关通过')
} finally {
  await rm(root, { recursive: true, force: true })
}
