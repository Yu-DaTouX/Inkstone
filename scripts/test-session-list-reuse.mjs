#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-session-list-'))
const outfile = join(dir, 'session-list.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/state/session-list.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const { reuseSessionSummaries } = await import(pathToFileURL(outfile).href)
await rm(dir, { recursive: true, force: true })

let pass = 0
function check(label, fn) {
  fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

const entry = (path, extra = {}) => ({ id: path, path, cwd: '/w', title: path, named: false, createdAt: 1, updatedAt: 1, messageCount: 1, ...extra })

check('内容完全相同时返回原数组', () => {
  const previous = [entry('a'), entry('b')]
  const next = [entry('a'), entry('b')]
  assert.equal(reuseSessionSummaries(previous, next), previous)
})

check('单条变化时只替换那一条，其余沿用旧对象', () => {
  const previous = [entry('a'), entry('b')]
  const next = [entry('a'), entry('b', { messageCount: 2 })]
  const merged = reuseSessionSummaries(previous, next)
  assert.notEqual(merged, previous)
  assert.equal(merged[0], previous[0])
  assert.equal(merged[1], next[1])
})

check('顺序变化时返回新数组但复用条目', () => {
  const previous = [entry('a'), entry('b')]
  const next = [entry('b'), entry('a')]
  const merged = reuseSessionSummaries(previous, next)
  assert.notEqual(merged, previous)
  assert.equal(merged[0], previous[1])
  assert.equal(merged[1], previous[0])
})

check('新增与删除条目', () => {
  const previous = [entry('a'), entry('b')]
  assert.deepEqual(reuseSessionSummaries(previous, [entry('a')]).map((item) => item.path), ['a'])
  const grown = reuseSessionSummaries(previous, [entry('a'), entry('b'), entry('c')])
  assert.equal(grown.length, 3)
  assert.equal(grown[0], previous[0])
})

check('空列表', () => {
  const previous = []
  assert.equal(reuseSessionSummaries(previous, []), previous)
})

console.log(`session-list reuse: ${pass} passed`)
