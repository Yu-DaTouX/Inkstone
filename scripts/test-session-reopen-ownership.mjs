#!/usr/bin/env node
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-session-reopen-'))
const dataDir = join(root, 'data')
const sessionsDir = join(root, 'sessions')
const piDir = join(root, 'pi')
const dirA = join(root, 'work-a')
const dirB = join(root, 'work-b')
const dirGone = join(root, 'work-gone')
const keys = ['YAN_DATA_DIR', 'YAN_SESSIONS_DIR', 'YAN_PI_DIR']
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
process.env.YAN_DATA_DIR = dataDir
process.env.YAN_SESSIONS_DIR = sessionsDir
process.env.YAN_PI_DIR = piDir

for (const dir of [dataDir, sessionsDir, piDir, dirA, dirB]) await mkdir(dir, { recursive: true })

const norm = (value) => String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

const report = { pass: 0, fail: 0 }
function check(message, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      report.pass += 1
      process.stdout.write(`  ✓ ${message}\n`)
    })
    .catch((error) => {
      report.fail += 1
      process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
    })
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
        'export const dialog = { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) }',
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
    `export { rememberSession, getSessionLayout, moveSessionLayout } from '${sourceOf('../src/main/session-layout.ts')}'`,
    `export { resolveSessionOpenTarget } from '${sourceOf('../src/main/session-open-target.ts')}'`
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

const projects = [
  { id: 'project-a', cwd: dirA, name: 'A', archived: false, createdAt: 1, updatedAt: 1 },
  { id: 'project-b', cwd: dirB, name: 'B', archived: false, createdAt: 1, updatedAt: 1 }
]
await writeFile(join(dataDir, 'desktop.json'), JSON.stringify({ cwd: dirA, autoArchiveDays: 365, projects }))

async function writeSession(id, cwd) {
  const file = join(sessionsDir, `${id}.jsonl`)
  const header = { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd }
  const message = { type: 'message', id: `${id}-m1`, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: `会话 ${id} 的问题` }] } }
  await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`)
  return file
}

const files = {
  belongsToB: await writeSession('sess-b', dirB),
  global: await writeSession('sess-global', dirB),
  moved: await writeSession('sess-moved', dirB),
  headerGone: await writeSession('sess-gone', dirGone),
  noEntry: await writeSession('sess-free', dirB)
}

const layoutEntry = (sessionId, file, cwd, ownership, moveHistory = []) => ({
  sessionId,
  sessionFile: file,
  cwd,
  ...ownership,
  createdAt: 1,
  updatedAt: 2,
  moveHistory
})
await writeFile(
  join(dataDir, 'session-layout.json'),
  JSON.stringify({
    version: 1,
    entries: [
      layoutEntry('sess-b', files.belongsToB, dirB, { projectId: 'project-b', scope: 'project' }),
      layoutEntry('sess-global', files.global, dirB, { scope: 'global' }),
      layoutEntry('sess-moved', files.moved, dirB, { projectId: 'project-b', scope: 'project' }),
      layoutEntry('sess-gone', files.headerGone, dirGone, { projectId: 'project-b', scope: 'project' })
    ]
  })
)
await rm(dirGone, { recursive: true, force: true })

const { registerSessionIpc, rememberSession, getSessionLayout, moveSessionLayout, resolveSessionOpenTarget } =
  await import(pathToFileURL(outfile).href)

const usable = async (cwd) => {
  try {
    const info = await stat(cwd)
    if (!info.isDirectory()) return { ok: false }
    await access(cwd, constants.R_OK)
    return { ok: true, cwd }
  } catch {
    return { ok: false }
  }
}
const projectIdOf = (cwd) => projects.find((project) => norm(project.cwd) === norm(cwd))?.id
const sessionIdOf = (file) => basename(file, '.jsonl')
const entryOf = async (sessionId) => (await getSessionLayout()).entries.find((item) => item.sessionId === sessionId)

const resolveTarget = (sessionFile) =>
  resolveSessionOpenTarget({ sessionFile, fallbackCwd: dirA, usable, projectIdForCwd: projectIdOf })

const selections = []
const host = {
  runners: () => ({
    select: async (target) => {
      selections.push(target)
      return { ok: true, id: 'r-test', sessionId: target.sessionId ?? sessionIdOf(target.sessionFile) }
    },
    statuses: () => [],
    agentForSession: () => null
  }),
  ac: () => null,
  push: () => undefined,
  pushRunners: () => undefined,
  pushRunnerSnapshot: async () => undefined,
  validateCwd: usable,
  startAgent: async () => ({ ok: true }),
  projectIdForCwd: (_settings, cwd) => projectIdOf(cwd),
  rememberRunnerSession: async (result, target) => {
    if (!result.ok || !result.sessionId) return
    await rememberSession({
      sessionId: result.sessionId,
      ...(target.sessionFile ? { sessionFile: target.sessionFile } : {}),
      cwd: target.cwd,
      ...(target.projectId ? { projectId: target.projectId } : {}),
      ...(target.scope ? { scope: target.scope } : {})
    })
  },
  readHistoryWithArtifacts: async () => null,
  sessionChains: {
    load: async () => undefined,
    chains: () => [],
    chainOf: () => null,
    representativeOf: () => undefined,
    forget: async () => true
  }
}
const handlers = new Map()
registerSessionIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, host)
const switchSession = (path) => handlers.get('yan:switchSession')(path)

process.stdout.write('\n▌打开已有会话时以会话自身的目录和归属为准（当前目录 A，会话属于 B）\n')

await check('恢复上次会话：运行实例 cwd 是会话的 B，不是当前目录 A', async () => {
  const target = await resolveTarget(files.belongsToB)
  assert.equal(norm(target.cwd), norm(dirB), `实际 ${target.cwd}`)
  assert.notEqual(norm(target.cwd), norm(dirA))
  assert.equal(target.projectId, 'project-b')
  assert.equal(target.scope, 'project')
})

await check('恢复上次会话：按运行实例的 cwd 记归属后不新增 moveHistory', async () => {
  const target = await resolveTarget(files.belongsToB)
  const before = await entryOf('sess-b')
  await rememberSession({
    sessionId: 'sess-b',
    sessionFile: files.belongsToB,
    cwd: target.cwd,
    projectId: target.projectId,
    scope: target.scope
  })
  const after = await entryOf('sess-b')
  assert.equal(after.projectId, 'project-b')
  assert.equal(after.scope, 'project')
  assert.equal(after.moveHistory.length, 0, `moveHistory 不应新增：${JSON.stringify(after.moveHistory)}`)
  assert.equal(before.moveHistory.length, after.moveHistory.length)
  assert.equal(norm(after.cwd), norm(dirB))
})

await check('yan:switchSession：运行实例 cwd 是 B，归属保持 project-b，moveHistory 不新增', async () => {
  const result = await switchSession(files.belongsToB)
  assert.equal(result.ok, true, result.error)
  const last = selections.at(-1)
  assert.equal(norm(last.cwd), norm(dirB), `运行实例 cwd 实际 ${last.cwd}`)
  assert.equal(last.projectId, 'project-b')
  assert.equal(last.scope, 'project')
  const entry = await entryOf('sess-b')
  assert.equal(entry.projectId, 'project-b')
  assert.equal(entry.scope, 'project')
  assert.equal(entry.moveHistory.length, 0)
  assert.equal(norm(entry.cwd), norm(dirB))
})

await check('全局会话被打开时不会被当前目录强行归属到项目', async () => {
  const result = await switchSession(files.global)
  assert.equal(result.ok, true, result.error)
  const last = selections.at(-1)
  assert.equal(norm(last.cwd), norm(dirB))
  assert.equal(last.projectId, undefined)
  assert.equal(last.scope, 'global')
  const entry = await entryOf('sess-global')
  assert.equal(entry.projectId, undefined)
  assert.equal(entry.scope, 'global')
  assert.equal(entry.moveHistory.length, 0)
})

process.stdout.write('\n▌只有显式移动才改变归属\n')

await check('显式移动（yan:moveSession/左栏移动）记录 moveHistory', async () => {
  const moved = await moveSessionLayout({ sessionId: 'sess-moved', sessionFile: files.moved, cwd: dirB }, 'project-a')
  assert.equal(moved.projectId, 'project-a')
  assert.equal(moved.moveHistory.length, 1)
})

await check('移动后再打开会话不会追加 moveHistory，也不把归属改回当前目录', async () => {
  const result = await switchSession(files.moved)
  assert.equal(result.ok, true, result.error)
  const entry = await entryOf('sess-moved')
  assert.equal(entry.projectId, 'project-a')
  assert.equal(entry.scope, 'project')
  assert.equal(entry.moveHistory.length, 1, JSON.stringify(entry.moveHistory))
})

process.stdout.write('\n▌会话文件头目录不可用时回退当前目录，但不改写归属\n')

await check('文件头目录已不存在：回退到当前目录 A，归属仍是 project-b', async () => {
  const target = await resolveTarget(files.headerGone)
  assert.equal(norm(target.cwd), norm(dirA))
  assert.equal(target.fromSession, false)
  assert.equal(target.projectId, 'project-b')
  assert.equal(target.scope, 'project')
  const result = await switchSession(files.headerGone)
  assert.equal(result.ok, true, result.error)
  const last = selections.at(-1)
  assert.equal(norm(last.cwd), norm(dirA))
  const entry = await entryOf('sess-gone')
  assert.equal(entry.projectId, 'project-b')
  assert.equal(entry.scope, 'project')
  assert.equal(entry.moveHistory.length, 0)
})

process.stdout.write('\n▌没有归属记录的会话按会话自己的目录派生\n')

await check('layout 没有条目时按会话文件头目录派生项目，不落到当前目录', async () => {
  const target = await resolveTarget(files.noEntry)
  assert.equal(norm(target.cwd), norm(dirB))
  assert.equal(target.projectId, 'project-b')
  assert.equal(target.scope, 'project')
})

for (const key of keys) {
  if (previous[key] === undefined) delete process.env[key]
  else process.env[key] = previous[key]
}
await rm(root, { recursive: true, force: true }).catch(() => undefined)

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 会话重新打开的归属：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
