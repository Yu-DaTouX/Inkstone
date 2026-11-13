#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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

const stub = `
const real = process.getBuiltinModule('fs/promises')
const log = () => (globalThis.__fsLog ??= [])
const name = (path) => String(path).replace(/^.*[\\\\/]/, '').replace(/\\.\\d+\\.[0-9a-f-]{36}\\.tmp$/, '.tmp')
export const lstat = (...a) => real.lstat(...a)
export const mkdir = (...a) => real.mkdir(...a)
export const rm = (...a) => real.rm(...a)
export const writeFile = async (path, ...rest) => {
  log().push('writeFile:' + name(path))
  return real.writeFile(path, ...rest)
}
export async function rename(from, to) {
  log().push('rename:' + name(from) + '>' + name(to))
  return real.rename(from, to)
}
export async function open(path, ...rest) {
  const handle = await real.open(path, ...rest)
  const label = name(path)
  log().push('open:' + label)
  return {
    writeFile: async (...a) => { log().push('write:' + label); return handle.writeFile(...a) },
    sync: async () => {
      log().push('sync:' + label)
      if (globalThis.__failSync) throw new Error('sync failed')
      return handle.sync()
    },
    close: async () => { log().push('close:' + label); return handle.close() }
  }
}
`

const out = await build({
  entryPoints: ['src/main/atomic-write.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'fs-stub',
    setup(b) {
      b.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'fs-promises', namespace: 'fs-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'fs-stub' }, () => ({ contents: stub, loader: 'js' }))
    }
  }]
})
const root = await mkdtemp(join(tmpdir(), 'yan-atomic-durable-'))
const moduleFile = join(root, 'atomic.mjs')
await (await import('node:fs/promises')).writeFile(moduleFile, out.outputFiles[0].text)
const { atomicWriteFile } = await import(pathToFileURL(moduleFile).href)

try {
  process.stdout.write('\n▌耐久写：先刷盘再替换\n')
  await check('durable：写入、sync、关闭都在 rename 之前，且只 sync 临时文件', async () => {
    globalThis.__fsLog = []
    await atomicWriteFile(join(root, 'auth.json'), 'secret', { mode: 0o600, durable: true })
    assert.deepEqual(globalThis.__fsLog, ['open:auth.json.tmp', 'write:auth.json.tmp', 'sync:auth.json.tmp', 'close:auth.json.tmp', 'rename:auth.json.tmp>auth.json'])
    assert.equal(await readFile(join(root, 'auth.json'), 'utf8'), 'secret')
  })
  await check('非 durable：不打开句柄也不 sync', async () => {
    globalThis.__fsLog = []
    await atomicWriteFile(join(root, 'queue.json'), 'q')
    assert.deepEqual(globalThis.__fsLog, ['writeFile:queue.json.tmp', 'rename:queue.json.tmp>queue.json'])
  })
  await check('durable 与 syncDir 并用时目录 sync 在 rename 之后', async () => {
    globalThis.__fsLog = []
    await atomicWriteFile(join(root, 'desktop.json'), 'x', { durable: true, syncDir: true })
    const log = globalThis.__fsLog
    assert.ok(log.indexOf('sync:desktop.json.tmp') >= 0 && log.indexOf('sync:desktop.json.tmp') < log.indexOf('rename:desktop.json.tmp>desktop.json') && log.lastIndexOf('sync:' + root.split(/[\\/]/).pop()) > log.indexOf('rename:desktop.json.tmp>desktop.json'))
  })
  await check('sync 失败：抛错、关闭句柄、不留临时文件，原文件不变', async () => {
    const target = join(root, 'keep.json')
    await atomicWriteFile(target, 'old')
    globalThis.__fsLog = []
    globalThis.__failSync = true
    try {
      await assert.rejects(() => atomicWriteFile(target, 'new', { durable: true }), /sync failed/)
    } finally {
      globalThis.__failSync = false
    }
    assert.ok(globalThis.__fsLog.includes('close:keep.json.tmp'))
    assert.ok(!globalThis.__fsLog.some((entry) => entry.startsWith('rename:')))
    assert.equal(await readFile(target, 'utf8'), 'old')
    assert.deepEqual((await readdir(root)).filter((n) => n.endsWith('.tmp')), [])
  })
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 耐久写：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
