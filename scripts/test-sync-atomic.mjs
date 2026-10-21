#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outfile = join(tmpdir(), `yan-sync-atomic-${process.pid}.mjs`)
await build({
  entryPoints: [fileURLToPath(new URL('../src/main/sync/atomic.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning'
})
const { atomicWriteFile } = await import(pathToFileURL(outfile).href)

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

const leftovers = (names) => names.filter((name) => name.endsWith('.tmp') || name.endsWith('.bak'))
const root = await mkdtemp(join(tmpdir(), 'yan-sync-atomic-'))

try {
  process.stdout.write('\n▌原子写：目标已存在时替换，拒绝留下临时文件\n')
  const file = join(root, 'a.json')
  await check('新文件写入并读回', async () => {
    await atomicWriteFile(file, 'one')
    assert.equal(await readFile(file, 'utf8'), 'one')
    assert.deepEqual(leftovers(await readdir(root)), [])
  })
  await check('目标已存在时替换内容，不留 tmp / bak', async () => {
    await atomicWriteFile(file, 'two')
    assert.equal(await readFile(file, 'utf8'), 'two')
    assert.deepEqual(leftovers(await readdir(root)), [])
  })

  process.stdout.write('\n▌原子写：替换失败时原文件不被删除\n')
  await check('目标被占用时写入失败，原内容完整且无 bak 残留', async () => {
    const locked = await open(file, 'r')
    try {
      let failure = null
      try {
        await atomicWriteFile(file, 'three')
      } catch (error) {
        failure = error
      }
      if (failure) assert.equal(await readFile(file, 'utf8'), 'two')
      else assert.equal(await readFile(file, 'utf8'), 'three')
      assert.deepEqual(leftovers(await readdir(root)), [])
    } finally {
      await locked.close()
    }
  })
  await check('目标是目录时写入失败，目录内容与自身都还在', async () => {
    const dir = join(root, 'target-dir')
    await mkdir(dir)
    await writeFile(join(dir, 'inner.txt'), 'keep')
    let failure = null
    try {
      await atomicWriteFile(dir, 'x')
    } catch (error) {
      failure = error
    }
    assert.ok(failure, '写入目录应失败')
    assert.equal(await readFile(join(dir, 'inner.txt'), 'utf8'), 'keep')
    assert.deepEqual(leftovers(await readdir(root)), [])
  })
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
  await rm(outfile, { force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 同步原子写：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
