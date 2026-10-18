#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-msg-count-'))
const outfile = join(dir, 'session-message-count.mjs')
await build({ entryPoints: [join(ROOT, 'src/main/session-message-count.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const { countSessionMessages, forgetSessionMessageCounts } = await import(pathToFileURL(outfile).href)

let pass = 0
async function check(label, fn) {
  await fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

const reference = (text) => text.split('\n').filter((line) => line.includes('"type":"message"')).length
const message = (i) => JSON.stringify({ type: 'message', id: `m${i}`, message: { role: 'user', content: `第 ${i} 条 "type":"text"` } })
const other = (i) => JSON.stringify({ type: 'custom_message', id: `c${i}` })
const file = join(dir, 's.jsonl')

try {
  let text = [JSON.stringify({ type: 'session', id: 's' }), message(0), other(0), message(1)].join('\n') + '\n'
  await writeFile(file, text)
  await check('首次计数与逐行算法一致', async () => assert.equal(await countSessionMessages(file), reference(text)))

  const added = [message(2), other(1), message(3)].join('\n') + '\n'
  await appendFile(file, added)
  text += added
  await check('追加整行后增量计数一致', async () => assert.equal(await countSessionMessages(file), reference(text)))

  const half = message(4)
  await appendFile(file, half.slice(0, 10))
  text += half.slice(0, 10)
  await check('末尾半行（标记未写完）不计入', async () => assert.equal(await countSessionMessages(file), reference(text)))
  await appendFile(file, half.slice(10) + '\n')
  text += half.slice(10) + '\n'
  await check('半行补齐后计入', async () => assert.equal(await countSessionMessages(file), reference(text)))

  const partialWithMark = message(5)
  await appendFile(file, partialWithMark)
  text += partialWithMark
  await check('末尾含标记的未换行行计入', async () => assert.equal(await countSessionMessages(file), reference(text)))
  await appendFile(file, '\n')
  text += '\n'
  await check('补上换行后不重复计数', async () => assert.equal(await countSessionMessages(file), reference(text)))

  text = [JSON.stringify({ type: 'session', id: 's' }), message(9)].join('\n') + '\n'
  await writeFile(file, text)
  await check('改写变短后整份重算', async () => assert.equal(await countSessionMessages(file), reference(text)))

  const sameSize = text.replace('"type":"message"', '"type":"messagX"')
  await writeFile(file, sameSize + other(7) + '\n')
  await check('文件前部改写后能识别', async () => assert.equal(await countSessionMessages(file), reference(sameSize + other(7) + '\n')))

  const lines = []
  for (let i = 0; i < 40_000; i++) lines.push(i % 3 ? other(i) : message(i))
  const big = lines.join('\n') + '\n'
  await writeFile(file, big)
  await check('跨 1MB 分块边界计数一致', async () => assert.equal(await countSessionMessages(file), reference(big)))

  await writeFile(file, 'x'.repeat(8 * 1024 * 1024 + 1))
  await check('超过 8MB 返回 -1', async () => assert.equal(await countSessionMessages(file), -1))

  await check('文件不存在时抛错（与原实现一致）', async () => assert.rejects(countSessionMessages(join(dir, 'missing.jsonl'))))

  await writeFile(file, text)
  await countSessionMessages(file)
  forgetSessionMessageCounts(new Set())
  await check('清理后重新计数仍正确', async () => assert.equal(await countSessionMessages(file), reference(text)))
} finally {
  await rm(dir, { recursive: true, force: true })
}

process.stdout.write(`\n${pass} passed\n`)
