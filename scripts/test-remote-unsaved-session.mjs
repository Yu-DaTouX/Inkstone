import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-remote-unsaved-'))
const sessionsDir = join(root, 'sessions')
await mkdir(sessionsDir, { recursive: true })

process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_SESSIONS_DIR = sessionsDir
process.env.YAN_USER_DATA = join(root, 'electron')

const electronStub = {
  name: 'electron-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
      contents: [
        'export const app = { getPath: () => process.env.YAN_USER_DATA, getName: () => "stub", getVersion: () => "0.0.0", whenReady: async () => undefined, on() {}, once() {}, quit() {}, isPackaged: false }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false }), createFromPath: () => ({ isEmpty: () => true }) }',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }',
        'export const BrowserWindow = class { static getAllWindows() { return [] } }',
        'export const Notification = class { static isSupported() { return false } show() {} on() {} }',
        'export const shell = { openExternal: async () => undefined, openPath: async () => undefined, showItemInFolder() {} }',
        'export const ipcMain = { handle() {}, on() {}, removeHandler() {} }',
        'export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) }',
        'export const clipboard = { readText: () => "", writeText() {} }',
        'export const Menu = { buildFromTemplate: (t) => t, setApplicationMenu() {}, getApplicationMenu: () => null }',
        'export const Tray = class { setToolTip() {} setContextMenu() {} on() {} destroy() {} }',
        'export const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }), getAllDisplays: () => [], getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }) }',
        'export const session = { defaultSession: { setPermissionRequestHandler() {} } }',
        'export default {}'
      ].join('\n'),
      loader: 'js'
    }))
  }
}

try {
  const outfile = join(root, 'remote-host.mjs')
  await build({ entryPoints: ['src/main/remote-host.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub] })
  const host = await import(pathToFileURL(outfile).href)

  const sent = []
  const selections = []
  const agent = {
    getState: () => ({ sessionId: 'pending-2', cwd: 'C:\\work\\fresh', model: { provider: 'p', id: 'm', name: 'M', input: ['text'] } }),
    send: async (text) => {
      sent.push(text)
      return { ok: true }
    },
    listModels: async () => [{ id: 'm', provider: 'p', name: 'M', input: ['text'] }],
    listThinkingLevels: async () => ['off']
  }
  const unsaved = {
    id: 'r1',
    runId: 'r1',
    sessionId: 'pending-2',
    projectId: 'p1',
    generation: 1,
    cwd: 'C:\\work\\fresh',
    running: false,
    waiting: false,
    failed: false,
    conn: 'ready',
    createdAt: 1,
    lastActiveAt: 2,
    isActive: false
  }

  const registry = {
    statuses: () => [unsaved],
    select: async (target) => {
      selections.push(target)
      return { ok: true, id: 'r1', runId: 'r1', sessionId: 'pending-2', generation: 1, via: 'hit' }
    },
    hasBusyCwd: () => false,
    runtimeOf: () => ({ generation: 1, sessionId: 'pending-2' }),
    agentOf: () => agent
  }

  host.configureRemoteHost({
    win: () => null,
    remoteAccess: () => null,
    runners: () => registry,
    ac: () => null,
    readHistoryWithArtifacts: async () => null,
    validateCwd: async (cwd) => ({ ok: true, cwd: String(cwd) }),
    rememberRunnerSession: async () => undefined,
    push: () => undefined,
    pushRunners: () => undefined,
    pushRunnerSnapshot: async () => undefined,
    startAgent: async () => ({ ok: true }),
    projectIdForCwd: () => 'p1',
    sessionChains: { load: async () => undefined, chains: () => [], representativeOf: () => null }
  })

  const sentResult = await host.executeRemoteCommand({ action: 'send', sessionId: 'pending-2', text: '第一条消息' })
  assert.equal(sentResult.ok, true, '尚未落盘的新会话可以直接发送')
  assert.deepEqual(sent, ['第一条消息'], '消息送到该会话的运行实例')
  assert.equal(selections.length, 1, '按会话 id 选择运行实例')
  assert.equal(selections[0].sessionId, 'pending-2', '选择目标带上会话 id')
  assert.equal(selections[0].sessionFile, undefined, '没有落盘时不要传空的会话文件路径')
  assert.equal(sentResult.data.sessionId, 'pending-2', '回执带上会话 id')

  const missing = await host.executeRemoteCommand({ action: 'send', sessionId: 'nowhere', text: 'hi' })
  assert.equal(missing.status, 404, '既不落盘也没有运行实例时仍然 404')

  const selected = await host.executeRemoteCommand({ action: 'select', sessionId: 'pending-2' })
  assert.equal(selected.ok, true, '远程 select 也认未落盘的新会话')

  const models = await host.remoteModels('pending-2')
  assert.equal(models.ok, true, '未落盘会话也能读到该实例的模型列表')
  assert.equal(models.data.models[0].id, 'm', '模型列表来自该会话的运行实例')

  const history = await host.remoteHistory('pending-2', 10)
  assert.equal(history.status, 404, '历史接口仍只读已落盘的会话')
} finally {
  await rm(root, { recursive: true, force: true })
}
