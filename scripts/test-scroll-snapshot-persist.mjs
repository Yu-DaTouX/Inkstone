#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-scroll-snapshot-'))
const outfile = join(dir, 'scroll-position.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/scroll-position.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })

const store = new Map()
let quotaFull = false
globalThis.sessionStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => { if (quotaFull) throw new Error('QuotaExceededError'); store.set(key, value) }
}
const listeners = new Map()
globalThis.window = { addEventListener: (type, fn) => listeners.set(type, fn) }
const { saveScrollSnapshot, readScrollSnapshot } = await import(pathToFileURL(outfile).href)

saveScrollSnapshot('a', { top: 120, bottom: false, anchor: null })
assert.equal(store.size, 0, '防抖期内尚未写入')
listeners.get('pagehide')()
assert.equal(JSON.parse(store.get('yan.scroll-snapshots'))[0][1].top, 120, '窗口卸载时必须同步落盘')

quotaFull = true
saveScrollSnapshot('b', { top: 5, bottom: true, anchor: null })
assert.doesNotThrow(() => listeners.get('pagehide')(), '存储超额不得抛出')
assert.equal(readScrollSnapshot('b').top, 5)
for (let i = 0; i < 40; i += 1) saveScrollSnapshot(`k${i}`, { top: i, bottom: false, anchor: null })
assert.equal(readScrollSnapshot('k0'), undefined, '内存缓存有上限')
process.stdout.write('  ✓ scroll-snapshot-persist\n')
await rm(dir, { recursive: true, force: true })
setTimeout(() => process.exit(0), 0)
