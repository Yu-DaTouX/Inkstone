import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
        'export const Notification = class { static isSupported() { return true } constructor(options) { this.options = options; globalThis.__notifyOptions = options } show() { globalThis.__notifyShown = (globalThis.__notifyShown ?? 0) + 1 } on() {} }',
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
  globalThis.__notifyOptions = null
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
const runProjects = async (name, projects) => {
  const dataDir = join(root, name)
  await mkdir(dataDir, { recursive: true })
  for (const project of projects) await mkdir(project.cwd, { recursive: true })
  await writeFile(join(dataDir, 'desktop.json'), JSON.stringify({ projects }), 'utf8')
  const outfile = join(root, `${name}.mjs`)
  await build({ entryPoints: ['src/main/ipc/collab-ipc.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub] })
  process.env.YAN_DATA_DIR = dataDir
  process.env.YAN_USER_DATA = dataDir
  const { activeProjects } = await import(pathToFileURL(outfile).href)
  return activeProjects()
}

try {
  const emptyDir = join(root, 'project-empty-name')
  const blankDir = join(root, 'project-blank-name')
  const namedDir = join(root, 'project-named')
  const listed = await runProjects('project-names', [
    { id: 'p-empty', name: '', cwd: emptyDir },
    { id: 'p-blank', name: '   ', cwd: blankDir },
    { id: 'p-named', name: '设计稿', cwd: namedDir }
  ])
  const byId = new Map(listed.map((project) => [project.id, project]))
  assert.equal(byId.get('p-empty').name, basename(emptyDir), '空项目名用目录名兜底')
  assert.equal(byId.get('p-blank').name, basename(blankDir), '纯空白项目名同样兜底')
  assert.equal(byId.get('p-named').name, '设计稿', '已有项目名保持不变')
  assert.deepEqual(
    listed.filter((project) => project.id.startsWith('p-')).map((project) => project.id).sort(),
    ['p-blank', 'p-empty', 'p-named'],
    '项目列表与顺序不受影响'
  )

  assert.equal(await run('default', null), 0, '提示音总开关默认关闭时不弹协作通知')
  assert.equal(await run('muted', { sound: { enabled: true, notifications: false, volume: 0.4, events: { done: true, question: true, error: true } } }), 0, '关闭通知时不弹协作通知')
  assert.equal(await run('enabled', { sound: { enabled: true, notifications: true, volume: 0.4, events: { done: true, question: true, error: true } } }), 1, '总开关与通知都开启时弹一次协作通知')

  const zh = await run('lang-zh', { lang: 'zh-CN', sound: { enabled: true, notifications: true, volume: 0.4, events: { done: true, question: true, error: true } } })
  assert.equal(zh, 1)
  assert.match(globalThis.__notifyOptions.title, /[\u4e00-\u9fff]/, '中文界面弹中文标题')
  const en = await run('lang-en', { lang: 'en-US', sound: { enabled: true, notifications: true, volume: 0.4, events: { done: true, question: true, error: true } } })
  assert.equal(en, 1)
  assert.doesNotMatch(globalThis.__notifyOptions.title, /[\u4e00-\u9fff]/, '英文界面不弹中文标题')
  assert.doesNotMatch(globalThis.__notifyOptions.body, /[：（）]/, '英文界面正文用英文标点，不用中文标点')
  assert.match(globalThis.__notifyOptions.body, / \(feat\/x\)$/, '正文末尾带分支名')
  console.log('collab-notify: 合并请求通知跟随提示音总开关、通知文案跟随界面语言、空项目名兜底通过')
} finally {
  await rm(root, { recursive: true, force: true })
}
