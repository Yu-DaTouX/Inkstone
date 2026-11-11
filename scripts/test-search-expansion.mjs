#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-search-expansion-'))
const outfile = join(dir, 'search-expansion.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/web-search/expansion.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const { searchExpansionKeys, searchExpansionOpen } = await import(pathToFileURL(outfile).href)
await rm(dir, { recursive: true, force: true })

let pass = 0
function check(label, fn) {
  fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

const query = { action: 'query', queries: ['rust async', 'tokio'], url: '' }
const fetch = { action: 'fetch', queries: [], url: 'https://example.com/a' }
const runningStep = { operationId: null, command: query }
const doneStep = { operationId: '0f8fad5b-d9cb-469f-a165-70867728950e', command: query }

check('收起的稳定键不随 operationId 出现而改变', () => {
  const running = searchExpansionKeys('call-1', runningStep)
  const done = searchExpansionKeys('call-1', doneStep)
  assert.equal(running.stable, done.stable)
  assert.equal(running.stable, 'web:call-1')
})

check('带操作 id 的键按 web:调用:操作 保存', () => {
  assert.equal(searchExpansionKeys('call-1', doneStep).tagged, 'web:call-1:0f8fad5b-d9cb-469f-a165-70867728950e')
  assert.equal(searchExpansionKeys('call-1', runningStep).tagged, searchExpansionKeys('call-1', runningStep).stable)
})

check('同一调用的查询和读取共用主条状态，不同调用保持独立', () => {
  const one = searchExpansionKeys('call-1', { operationId: null, command: { action: 'query', queries: ['one'], url: '' } })
  const two = searchExpansionKeys('call-1', { operationId: null, command: { action: 'query', queries: ['two'], url: '' } })
  const page = searchExpansionKeys('call-1', { operationId: null, command: fetch })
  assert.equal(one.stable, two.stable)
  assert.equal(one.stable, page.stable)
  assert.notEqual(searchExpansionKeys('call-2', runningStep).stable, one.stable)
})

check('运行、完成和历史来源面板统一默认展开', () => {
  assert.equal(searchExpansionOpen(undefined), true)
})

check('保留用户手动折叠或展开的选择', () => {
  assert.equal(searchExpansionOpen(false), false)
  assert.equal(searchExpansionOpen(true), true)
})

process.stdout.write(`\n${pass} 项通过\n`)
