#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const DAY = 86_400_000
const root = await mkdtemp(join(tmpdir(), 'yan-session-ipc-'))
const dataDir = join(root, 'data')
const sessionsDir = join(root, 'sessions')
const piDir = join(root, 'pi')
const keys = ['YAN_DATA_DIR', 'YAN_SESSIONS_DIR', 'YAN_PI_DIR']
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
process.env.YAN_DATA_DIR = dataDir
process.env.YAN_SESSIONS_DIR = sessionsDir
process.env.YAN_PI_DIR = piDir
for (const dir of [dataDir, sessionsDir, piDir]) await mkdir(dir, { recursive: true })
await writeFile(join(dataDir, 'desktop.json'), JSON.stringify({ autoArchiveDays: 7, projects: [] }))

const report = { pass: 0, fail: 0 }
async function check(message, fn) {
  try {
    await fn()
    report.pass += 1
    process.stdout.write(`  ✓ ${message}\n`)
  } catch (error) {
    report.fail += 1
    process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const old = Date.now() - 40 * DAY
async function writeSession(name, header) {
  const file = join(sessionsDir, name)
  await writeFile(file, `${JSON.stringify({ type: 'session', version: 3, ...header })}\n`)
  await utimes(file, new Date(old), new Date(old))
  return file
}

const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      loader: 'js',
      contents: [
        'export const shell = { openPath: async () => "" }',
        'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
        'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
        'export const ipcMain = { handle: () => undefined }',
        'export const BrowserWindow = class {}',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (value) => Buffer.from(String(value)), decryptString: (value) => Buffer.from(value).toString() }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }'
      ].join('\n')
    }))
  }
}

const outfile = join(root, 'session-ipc.mjs')
const entry = join(root, 'entry.ts')
const sourceOf = (relative) => fileURLToPath(new URL(relative, import.meta.url)).replace(/\\/g, '/')
await writeFile(
  entry,
  [
    `export { registerSessionIpc } from '${sourceOf('../src/main/ipc/session-ipc.ts')}'`,
    `export { configureRemoteHost } from '${sourceOf('../src/main/remote-host.ts')}'`
  ].join('\n')
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning',
  plugins: [electronStub]
})

try {
  const { registerSessionIpc, configureRemoteHost } = await import(pathToFileURL(outfile).href)
  await writeSession('old-1.jsonl', { id: 'old-1', timestamp: new Date(old).toISOString(), cwd: 'C:/layout-cwd' })

  const sessionChains = { load: async () => undefined, chains: () => [], chainOf: () => null, representativeOf: () => undefined, forget: async () => true }
  const host = {
    runners: () => null,
    ac: () => null,
    push: () => undefined,
    pushRunners: () => undefined,
    pushRunnerSnapshot: async () => undefined,
    validateCwd: async (cwd) => ({ ok: true, cwd }),
    startAgent: async () => ({ ok: true }),
    projectIdForCwd: () => undefined,
    rememberRunnerSession: async () => undefined,
    readHistoryWithArtifacts: async () => null,
    sessionChains
  }
  configureRemoteHost({ ...host, win: () => null, remoteAccess: () => null })
  const handlers = new Map()
  registerSessionIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, host)

  const layoutFile = join(dataDir, 'session-layout.json')
  const readLayout = async () => {
    try {
      return JSON.parse(await readFile(layoutFile, 'utf8'))
    } catch {
      return { entries: [] }
    }
  }
  const entryOf = async (id) => (await readLayout()).entries.find((entry) => entry.sessionId === id)

  process.stdout.write('\n▌自动归档改为启动后台扫一次，读接口不再写盘\n')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const entry = await entryOf('old-1')
    if (entry?.archivedAt) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  await check('启动后自动归档一次', async () => {
    const entry = await entryOf('old-1')
    assert.ok(entry, '启动扫盘应写下布局条目')
    assert.ok(entry.archivedAt, '闲置 40 天、自动归档 7 天的会话应被归档')
  })

  await writeSession('old-2.jsonl', { id: 'old-2', timestamp: new Date(old).toISOString(), cwd: 'C:/layout-cwd' })
  await check('yan:listSessions 不再顺带归档', async () => {
    const list = await handlers.get('yan:listSessions')()
    assert.ok(list.some((item) => item.id === 'old-2'), '新写入的旧会话应在列表里')
    assert.equal(list.find((item) => item.id === 'old-2').archivedAt, undefined, '列表里不应被标记归档')
    const entry = await entryOf('old-2')
    assert.equal(entry?.archivedAt, undefined, '读接口不应触发归档写盘')
  })

  process.stdout.write('\n▌单会话操作先用布局缓存定位，不扫全量会话\n')
  await writeSession('old-1.jsonl', { id: 'old-1', timestamp: new Date(old).toISOString(), cwd: 'C:/header-cwd' })
  await check('setSessionPinned 用布局里的会话文件与工作目录，不回退到全量扫描', async () => {
    const result = await handlers.get('yan:setSessionPinned')('old-1', true)
    assert.equal(result.ok, true, result.error)
    const entry = await entryOf('old-1')
    assert.equal(entry?.pinned, true)
    assert.equal(entry?.cwd, 'C:/layout-cwd', '布局缓存优先：不应改成会话头里的新工作目录')
  })
} finally {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 会话读接口与自动归档：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
