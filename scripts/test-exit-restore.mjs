#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-exit-restore-'))
const dataDir = join(root, 'data')
process.env.YAN_DATA_DIR = dataDir
process.env.YAN_PI_DIR = join(root, 'pi')
await mkdir(dataDir, { recursive: true })

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

const sourceOf = (relative) => fileURLToPath(new URL(relative, import.meta.url)).replace(/\\/g, '/')
const outfile = join(root, 'exit-snapshot.mjs')
await build({
  entryPoints: [sourceOf('../src/main/exit-snapshot.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(outfile).href)
const { EXIT_SNAPSHOT_FILE, writeExitSnapshot, readExitSnapshot, clearExitSnapshot, pickRestoreRunner } = mod

const status = (over = {}) => ({
  id: 'r-1',
  runId: 'r-1',
  sessionId: 'session-1',
  sessionFile: 'C:/sessions/one.jsonl',
  projectId: 'project-1',
  generation: 3,
  cwd: 'C:/work/project',
  running: false,
  waiting: false,
  failed: false,
  conn: 'ready',
  createdAt: 100,
  lastActiveAt: 200,
  isActive: true,
  text: '正文不进快照',
  ...over
})

process.stdout.write('▌退出快照的读取\n')
await check('没有快照时读回 null', async () => {
  assert.equal(await readExitSnapshot(), null)
})

await check('写入后能读回，并按白名单收敛字段', async () => {
  await writeExitSnapshot('save', [status()])
  const snapshot = await readExitSnapshot()
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.mode, 'save')
  assert.equal(snapshot.runners.length, 1)
  assert.equal(snapshot.runners[0].sessionFile, 'C:/sessions/one.jsonl')
  assert.equal(snapshot.runners[0].generation, 3)
  assert.equal(snapshot.runners[0].conn, 'ready')
  assert.equal('isActive' in snapshot.runners[0], false)
  assert.equal('text' in snapshot.runners[0], false)
})

await check('坏 JSON 视为没有快照', async () => {
  await writeFile(EXIT_SNAPSHOT_FILE, '{ broken')
  assert.equal(await readExitSnapshot(), null)
})

await check('版本不符或不认识模式时视为没有快照', async () => {
  await writeFile(EXIT_SNAPSHOT_FILE, JSON.stringify({ version: 2, at: 1, mode: 'save', runners: [] }))
  assert.equal(await readExitSnapshot(), null)
  await writeFile(EXIT_SNAPSHOT_FILE, JSON.stringify({ version: 1, at: 1, mode: 'quit', runners: [] }))
  assert.equal(await readExitSnapshot(), null)
})

await check('运行实例条目缺 id 或 cwd 时被丢弃，其余保留', async () => {
  await writeFile(EXIT_SNAPSHOT_FILE, JSON.stringify({
    version: 1,
    at: 5,
    mode: 'interrupt',
    runners: [
      { ...status(), cwd: '' },
      { ...status(), id: '' },
      status({ id: 'r-2', sessionFile: 'C:/sessions/two.jsonl' })
    ]
  }))
  const snapshot = await readExitSnapshot()
  assert.equal(snapshot.runners.length, 1)
  assert.equal(snapshot.runners[0].id, 'r-2')
})

process.stdout.write('\n▌恢复到哪个会话\n')
const snapshotOf = (runners, mode = 'save') => ({ version: 1, at: 1, mode, runners })

await check('优先恢复被中断（running）的实例，即使它更早活动', () => {
  const picked = pickRestoreRunner(snapshotOf([
    status({ id: 'r-idle', lastActiveAt: 900 }),
    status({ id: 'r-running', running: true, lastActiveAt: 100 })
  ]))
  assert.equal(picked.id, 'r-running')
})

await check('都空闲时取最近活动的实例', () => {
  const picked = pickRestoreRunner(snapshotOf([
    status({ id: 'r-old', lastActiveAt: 100 }),
    status({ id: 'r-new', lastActiveAt: 900 })
  ]))
  assert.equal(picked.id, 'r-new')
})

await check('不按当前文件夹过滤，恢复退出前最近活动的会话', () => {
  const picked = pickRestoreRunner(snapshotOf([
    status({ id: 'r-other', cwd: 'E:/elsewhere', lastActiveAt: 900 }),
    status({ id: 'r-1', lastActiveAt: 100 })
  ]))
  assert.equal(picked.id, 'r-other')
})

await check('没有 sessionFile 的实例不参与恢复', () => {
  assert.equal(pickRestoreRunner(snapshotOf([status({ sessionFile: undefined })])), undefined)
})

await check('空快照返回 undefined', () => {
  assert.equal(pickRestoreRunner(snapshotOf([])), undefined)
})

process.stdout.write('\n▌快照只消费一次\n')
await check('清除后二次读取为空，旧的退出快照不会在强杀后复活', async () => {
  await writeExitSnapshot('save', [status()])
  assert.ok(await readExitSnapshot())
  await clearExitSnapshot()
  assert.equal(await readExitSnapshot(), null)
  assert.equal(existsSync(EXIT_SNAPSHOT_FILE), false)
  await clearExitSnapshot()
})

process.stdout.write('\n▌退出快照仍然只写视图无关字段\n')
await check('磁盘上的快照不含消息正文', async () => {
  await writeExitSnapshot('interrupt', [status()])
  const raw = await readFile(EXIT_SNAPSHOT_FILE, 'utf8')
  assert.equal(raw.includes('正文不进快照'), false)
  assert.equal(JSON.parse(raw).mode, 'interrupt')
  await clearExitSnapshot()
})

process.stdout.write(`\n退出快照恢复：${report.pass} 通过 / ${report.fail} 失败\n`)
if (report.fail) process.exitCode = 1
