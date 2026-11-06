#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-layout-flag-'))
const outfile = join(dir, 'flag.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/split/layout-transition-flag.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const { runWithLayoutTransitionFlag } = await import(pathToFileURL(outfile).href)
await rm(dir, { recursive: true, force: true })

const root = { dataset: {} }
const first = Promise.withResolvers()
const second = Promise.withResolvers()
runWithLayoutTransitionFlag(root, () => ({ finished: first.promise }))
runWithLayoutTransitionFlag(root, () => ({ finished: second.promise }))
first.reject(new Error('skipped'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(root.dataset.splitLayoutVt, '', '后一次转场进行中，前一次被跳过不得清掉标记')
second.resolve()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(root.dataset.splitLayoutVt, undefined, '最后一次结束后清除标记')
runWithLayoutTransitionFlag(root, () => undefined)
assert.equal(root.dataset.splitLayoutVt, undefined, '没有 finished 时立即清除')
process.stdout.write('  ✓ layout-transition-flag\n')
