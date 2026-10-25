#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const DAY = 86_400_000
const root = await mkdtemp(join(tmpdir(), 'yan-session-cleanup-'))
const dataDir = join(root, 'data')
const sessionsDir = join(root, 'sessions')
const piDir = join(root, 'pi')
process.env.YAN_DATA_DIR = dataDir
process.env.YAN_SESSIONS_DIR = sessionsDir
process.env.YAN_PI_DIR = piDir
for (const dir of [dataDir, sessionsDir, piDir]) await mkdir(dir, { recursive: true })
await writeFile(join(dataDir, 'desktop.json'), JSON.stringify({ projects: [] }))

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

const outfile = join(root, 'sessions.mjs')
const entry = join(root, 'entry.ts')
const sourceOf = (relative) => fileURLToPath(new URL(relative, import.meta.url)).replace(/\\/g, '/')
await writeFile(
  entry,
  `export { deleteSession, isSessionFileInSessionsDir, sessionsToDelete, restoreSession } from '${sourceOf('../src/main/sessions.ts')}'`
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

const sessionSkillsDir = (id) => join(dataDir, 'capabilities', 'session-skills', id)
const sourcesDir = (id) => join(dataDir, 'sources', id)
const trashDir = join(dataDir, 'trash', 'sessions')

async function writeSession(id, extra = {}) {
  const file = join(sessionsDir, `${id}.jsonl`)
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: 'C:/proj', ...extra }),
      JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } })
    ].join('\n')
  )
  return file
}

const { deleteSession, isSessionFileInSessionsDir, sessionsToDelete, restoreSession } = await import(pathToFileURL(outfile).href)

process.stdout.write('\n▌回收站按时间清理\n')
await check('超过 7 天的回收站条目在删除时清掉，别的保留', async () => {
  await mkdir(trashDir, { recursive: true })
  const stale = join(trashDir, `${Date.now() - 8 * DAY}-abc123-0-old.jsonl`)
  await writeFile(stale, '{}\n')
  const old = new Date(Date.now() - 8 * DAY)
  await utimes(stale, old, old)
  const unknown = join(trashDir, 'legacy-without-deletion-time.jsonl')
  await writeFile(unknown, '{}\n')
  await utimes(unknown, old, old)
  const legacy = join(trashDir, `${Date.now()}-abc123-0-legacy.jsonl`)
  await writeFile(legacy, '{}\n')
  await utimes(legacy, old, old)
  const fresh = join(trashDir, 'fresh-0-0-note.txt')
  await writeFile(fresh, 'x')
  const file = await writeSession('trash-1')
  await deleteSession(file)
  assert.equal(existsSync(stale), false, '过期条目应被删掉')
  assert.equal(existsSync(fresh), true, '未过期条目应保留')
  assert.equal(existsSync(unknown), true, '无法确认删除时间的历史条目不得清理')
  assert.equal(existsSync(legacy), true, '已有命名格式按删除时间而非 mtime 保留')
})

await check('十天旧会话删除后保留完整七天，仍可撤销', async () => {
  const originalNow = Date.now
  let now = originalNow() + 2 * DAY
  Date.now = () => now
  try {
    const file = await writeSession('old-source')
    const old = new Date(now - 10 * DAY)
    await utimes(file, old, old)
    const token = await deleteSession(file)
    now += 61 * 60_000
    await deleteSession(await writeSession('prune-hour'))
    now += 6 * DAY
    await deleteSession(await writeSession('prune-six-days'))
    await restoreSession(token)
    assert.equal(existsSync(file), true)
    const expired = await writeSession('expire-after-week')
    const expiredToken = await deleteSession(expired)
    now += 7 * DAY + 61 * 60_000
    await deleteSession(await writeSession('prune-week'))
    await assert.rejects(restoreSession(expiredToken))
  } finally {
    Date.now = originalNow
  }
})

process.stdout.write('\n▌删除会话同时清理来源副本与会话技能目录\n')
const parent = await writeSession('parent-1')
const child = await writeSession('child-1', { parentSession: 'parent-1' })
for (const id of ['parent-1', 'child-1']) {
  await mkdir(sessionSkillsDir(id), { recursive: true })
  await writeFile(join(sessionSkillsDir(id), 'SKILL.md'), 'x')
  await mkdir(sourcesDir(id), { recursive: true })
  await writeFile(join(sourcesDir(id), 'img-1.bin'), 'x')
}

await check('sessionsToDelete 只含被删的会话本身', async () => {
  const targets = await sessionsToDelete(parent)
  const paths = targets.map((target) => target.path)
  assert.equal(paths.length, 1, `只应含父会话：${paths.join(', ')}`)
  assert.ok(paths[0].endsWith('parent-1.jsonl'), '应为父会话')
})

await check('删除后会话文件进回收站、技能目录与来源副本消失，分支会话不受影响', async () => {
  const token = await deleteSession(parent)
  assert.ok(token, '应返回撤销令牌')
  assert.equal(existsSync(parent), false, '父会话文件应已移走')
  assert.equal(existsSync(child), true, '分支会话文件保留')
  assert.equal(existsSync(sessionSkillsDir('parent-1')), false, '会话技能目录应被删掉')
  assert.equal(existsSync(sessionSkillsDir('child-1')), true, '分支会话技能目录保留')
  assert.equal(existsSync(sourcesDir('parent-1')), false, '来源副本应被删掉')
  assert.equal(existsSync(sourcesDir('child-1')), true, '分支会话来源副本保留')
  const trashed = await readdir(trashDir)
  assert.ok(trashed.some((name) => name.endsWith('-parent-1.jsonl')), '父会话文件应在回收站里')
  assert.ok(!trashed.some((name) => name.endsWith('-child-1.jsonl')), '分支会话文件不进回收站')
})

await check('撤销只恢复会话文件，不恢复技能目录与来源副本', async () => {
  const file = await writeSession('undo-1')
  await mkdir(sessionSkillsDir('undo-1'), { recursive: true })
  await writeFile(join(sessionSkillsDir('undo-1'), 'SKILL.md'), 'x')
  const token = await deleteSession(file)
  assert.equal(existsSync(file), false, '删除后会话文件应已在回收站')
  await restoreSession(token)
  assert.equal(existsSync(file), true, '会话文件应被恢复')
  assert.equal(existsSync(sessionSkillsDir('undo-1')), false, '技能目录不恢复（有意的不对称）')
})

process.stdout.write('\n▌只能读会话目录里的 .jsonl\n')
await check('会话目录内的文件通过路径校验', async () => {
  const file = await writeSession('peek-1')
  assert.equal(await isSessionFileInSessionsDir(file), true)
})

await check('会话目录外的文件被拒绝', async () => {
  const outside = join(piDir, 'outside.jsonl')
  await writeFile(outside, '{}\n')
  assert.equal(await isSessionFileInSessionsDir(outside), false)
})

await check('目录内的非 .jsonl 被拒绝', async () => {
  const other = join(sessionsDir, 'note.txt')
  await writeFile(other, 'x')
  assert.equal(await isSessionFileInSessionsDir(other), false)
})

await check('不存在的路径被拒绝', async () => {
  assert.equal(await isSessionFileInSessionsDir(join(sessionsDir, 'missing.jsonl')), false)
})

process.stdout.write('\n▌会话头里的 id 不安全时仍能删除\n')
await check('id 含非法字符不阻断删除', async () => {
  const file = join(sessionsDir, 'weird.jsonl')
  await writeFile(file, `${JSON.stringify({ type: 'session', version: 3, id: 'a/b', cwd: 'C:/proj' })}\n`)
  const token = await deleteSession(file)
  assert.ok(token)
  assert.equal(existsSync(file), false)
})

process.stdout.write(`\n会话删除清理：${report.pass} 通过 / ${report.fail} 失败\n`)
if (report.fail) process.exitCode = 1
