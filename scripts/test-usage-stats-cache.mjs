#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

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

const root = await mkdtemp(join(tmpdir(), 'yan-usage-cache-'))
const mainOut = join(root, 'usage-stats-main.mjs')
await build({ entryPoints: ['src/main/usage-stats.ts'], outfile: mainOut, bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
const m = await import(pathToFileURL(mainOut).href)

const iso = (ms) => new Date(ms).toISOString()
const reply = (ms, total) => JSON.stringify({ type: 'message', timestamp: iso(ms), message: { role: 'assistant', provider: 'p', model: 'q', usage: { totalTokens: total } } })
const sessionFile = join(root, 'sessions', 's.jsonl')
await mkdir(join(root, 'sessions'), { recursive: true })
await writeFile(sessionFile, `${reply(Date.now() - 86_400_000, 120)}\n`)
const size = (await stat(sessionFile)).size
const sourcesFor = (cacheFile) => ({
  listMain: async () => [{ path: sessionFile, size }],
  listSubagents: async () => [],
  cacheFile
})

try {
  process.stdout.write('\n▌用量缓存：原子写与坏缓存重建\n')
  await check('缓存写出完整 JSON，目录里不留临时文件', async () => {
    const cacheFile = join(root, 'cache-ok.json')
    assert.equal((await m.createUsageReader(sourcesFor(cacheFile))('all')).tokens, 120)
    assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).version, 6)
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), [])
  })
  await check('缓存被截断成坏 JSON：读取不抛，结果重建并重写缓存', async () => {
    const cacheFile = join(root, 'cache-bad.json')
    await writeFile(cacheFile, '{"version":6,"files":{"x":')
    assert.equal((await m.createUsageReader(sourcesFor(cacheFile))('all')).tokens, 120)
    assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).version, 6)
  })
  await check('缓存路径写不进去（是目录）：读取仍返回结果，不抛', async () => {
    const cacheFile = join(root, 'cache-dir.json')
    await mkdir(cacheFile)
    assert.equal((await m.createUsageReader(sourcesFor(cacheFile))('all')).tokens, 120)
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), [])
  })
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 用量缓存：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
