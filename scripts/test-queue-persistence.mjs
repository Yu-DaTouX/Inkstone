#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-queue-persistence-'))
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
const outfile = join(root, 'queue-persistence.mjs')
await build({
  entryPoints: [sourceOf('../src/main/queue-persistence.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const queue = await import(pathToFileURL(outfile).href)
const { QUEUE_RECOVERY_DIR, saveQueue, loadQueue, clearQueueFile } = queue
const fileOf = (sessionId) => join(QUEUE_RECOVERY_DIR, `${sessionId}.json`)

process.stdout.write('▌排队消息落盘与读回\n')
await check('空队列不落盘', async () => {
  await saveQueue({ sessionId: 'session-empty', steering: [], followUp: [] })
  const saved = await loadQueue('session-empty')
  assert.equal(saved, null)
})

await check('插话与排队分开保存并能原样读回', async () => {
  const at = Date.now()
  await saveQueue({ sessionId: 'session-a', steering: ['补充要求：先跑类型检查'], followUp: ['再补测试'] })
  const saved = await loadQueue('session-a')
  assert.equal(saved.version, 1)
  assert.equal(saved.sessionId, 'session-a')
  assert.deepEqual(saved.steering, ['补充要求：先跑类型检查'])
  assert.deepEqual(saved.followUp, ['再补测试'])
  assert.ok(saved.at >= at && saved.at <= Date.now())
})

await check('写入是原子的，目录里不留临时文件', async () => {
  const names = await readdir(QUEUE_RECOVERY_DIR)
  assert.deepEqual(names.filter((name) => name.startsWith('session-a')), ['session-a.json'])
})

await check('按会话隔离，互不覆盖', async () => {
  await saveQueue({ sessionId: 'session-b', steering: ['另一个会话的排队'], followUp: [] })
  assert.deepEqual((await loadQueue('session-a')).steering, ['补充要求：先跑类型检查'])
  assert.deepEqual((await loadQueue('session-b')).steering, ['另一个会话的排队'])
  assert.equal(await loadQueue('session-missing'), null)
})

await check('后写覆盖前写（保留最后一次队列快照）', async () => {
  await saveQueue({ sessionId: 'session-a', steering: ['第一条'], followUp: [] })
  await saveQueue({ sessionId: 'session-a', steering: ['第一条', '第二条'], followUp: ['第三条'] })
  const saved = await loadQueue('session-a')
  assert.deepEqual(saved.steering, ['第一条', '第二条'])
  assert.deepEqual(saved.followUp, ['第三条'])
})

await check('清空后文件消失', async () => {
  await clearQueueFile('session-b')
  assert.equal(existsSync(fileOf('session-b')), false)
  assert.equal(await loadQueue('session-b'), null)
  await clearQueueFile('session-b')
})

process.stdout.write('\n▌内容清洗\n')
await check('空白项被丢弃，纯图片项保留图片计数', async () => {
  await saveQueue({ sessionId: 'session-c', steering: ['   ', '有内容的'], followUp: [], images: 2 })
  const saved = await loadQueue('session-c')
  assert.deepEqual(saved.steering, ['有内容的'])
  assert.equal(saved.images, 2)
})

await check('只有图片没有文本时不算空记录', async () => {
  await saveQueue({ sessionId: 'session-images', steering: [], followUp: [], images: 1 })
  const saved = await loadQueue('session-images')
  assert.equal(saved.images, 1)
  assert.deepEqual(saved.steering, [])
})

await check('超长文本截断到上限，条数上限生效', async () => {
  const long = 'x'.repeat(30_000)
  await saveQueue({
    sessionId: 'session-long',
    steering: Array.from({ length: 210 }, (_, index) => `${long}-${index}`),
    followUp: []
  })
  const saved = await loadQueue('session-long')
  assert.equal(saved.steering.length, 200)
  assert.equal(saved.steering[0].length, 20_000)
  assert.ok(saved.steering[0].startsWith('x'))
})

process.stdout.write('\n▌坏文件自愈\n')
await check('非法 JSON 读回 null 并删除坏文件', async () => {
  await mkdir(QUEUE_RECOVERY_DIR, { recursive: true })
  const target = fileOf('session-broken')
  await writeFile(target, '{ not json')
  assert.equal(await loadQueue('session-broken'), null)
  assert.equal(existsSync(target), false)
})

await check('版本或会话不匹配时不采用', async () => {
  const target = fileOf('session-version')
  await writeFile(target, JSON.stringify({ version: 2, sessionId: 'session-version', at: 1, steering: ['旧格式'], followUp: [], images: 0 }))
  assert.equal(await loadQueue('session-version'), null)
  await writeFile(target, JSON.stringify({ version: 1, sessionId: 'someone-else', at: 1, steering: ['串会话'], followUp: [], images: 0 }))
  assert.equal(await loadQueue('session-version'), null)
})

await check('读回内容与磁盘文件一致', async () => {
  const raw = JSON.parse(await readFile(fileOf('session-a'), 'utf8'))
  assert.deepEqual(raw.steering, ['第一条', '第二条'])
  assert.equal(raw.version, 1)
})

process.stdout.write(`\n排队消息持久化：${report.pass} 通过 / ${report.fail} 失败\n`)
if (report.fail) process.exitCode = 1
