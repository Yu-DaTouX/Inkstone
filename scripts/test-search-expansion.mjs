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
const {
  SEARCH_HOLD_MS,
  SEARCH_TAIL_SLACK_PX,
  SEARCH_BOTTOM_SLACK_PX,
  canAutoCollapse,
  holdSearchAuto,
  resolveSearchAuto,
  searchExpansionKeys,
  searchExpansionOpen,
  seedSearchAuto
} = await import(pathToFileURL(outfile).href)
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
const view = { viewTop: 100, viewBottom: 900 }

check('收起的稳定键不随 operationId 出现而改变', () => {
  const running = searchExpansionKeys('call-1', runningStep)
  const done = searchExpansionKeys('call-1', doneStep)
  assert.equal(running.stable, done.stable)
  assert.ok(running.stable.startsWith('web:call-1:query:'))
})

check('带操作 id 的键按 web:调用:操作 保存', () => {
  assert.equal(searchExpansionKeys('call-1', doneStep).tagged, 'web:call-1:0f8fad5b-d9cb-469f-a165-70867728950e')
  assert.equal(searchExpansionKeys('call-1', runningStep).tagged, searchExpansionKeys('call-1', runningStep).stable)
})

check('同一调用里不同搜索词和读取地址各自独立', () => {
  const one = searchExpansionKeys('call-1', { operationId: null, command: { action: 'query', queries: ['one'], url: '' } })
  const two = searchExpansionKeys('call-1', { operationId: null, command: { action: 'query', queries: ['two'], url: '' } })
  const page = searchExpansionKeys('call-1', { operationId: null, command: fetch })
  assert.notEqual(one.stable, two.stable)
  assert.notEqual(one.stable, page.stable)
  assert.notEqual(searchExpansionKeys('call-2', runningStep).stable, one.stable)
})

check('运行中的搜索默认展开，历史挂载默认收起', () => {
  assert.deepEqual(seedSearchAuto(true), { phase: 'live', holdUntil: null })
  assert.deepEqual(seedSearchAuto(false), { phase: 'idle', holdUntil: null })
  assert.equal(searchExpansionOpen(undefined, seedSearchAuto(true)), true)
  assert.equal(searchExpansionOpen(undefined, seedSearchAuto(false)), false)
})

check('完成后停留 800ms 再收起', () => {
  const hold = holdSearchAuto(5000)
  assert.equal(hold.holdUntil, 5000 + SEARCH_HOLD_MS)
  assert.equal(SEARCH_HOLD_MS, 800)
  assert.equal(searchExpansionOpen(undefined, hold), true)
  const early = resolveSearchAuto(hold, hold.holdUntil - 1, true)
  assert.equal(early, hold)
  assert.equal(searchExpansionOpen(undefined, early), true)
  const ended = resolveSearchAuto(hold, hold.holdUntil, true)
  assert.equal(ended.phase, 'idle')
  assert.equal(searchExpansionOpen(undefined, ended), false)
})

check('不在尾部也不在视口外时，停留结束仍不收起', () => {
  const hold = holdSearchAuto(1000)
  const waiting = resolveSearchAuto(hold, hold.holdUntil, false)
  assert.equal(waiting.phase, 'waiting')
  assert.equal(searchExpansionOpen(undefined, waiting), true)
  assert.equal(resolveSearchAuto(waiting, 99_999, false).phase, 'waiting')
  assert.equal(resolveSearchAuto(waiting, 99_999, true).phase, 'idle')
})

check('用户手动开合压过自动状态', () => {
  const live = seedSearchAuto(true)
  const hold = holdSearchAuto(1000)
  assert.equal(searchExpansionOpen(false, live), false)
  assert.equal(searchExpansionOpen(false, hold), false)
  assert.equal(searchExpansionOpen(true, seedSearchAuto(false)), true)
  assert.equal(searchExpansionOpen(true, resolveSearchAuto(hold, hold.holdUntil, true)), true)
})

check('尾部或完全离开视口才允许自动收起', () => {
  assert.equal(canAutoCollapse({ ...view, top: 0, bottom: 90, atBottom: false }), true)
  assert.equal(canAutoCollapse({ ...view, top: 920, bottom: 1100, atBottom: false }), true)
  assert.equal(canAutoCollapse({ ...view, top: 300, bottom: 500, atBottom: false }), false)
  assert.equal(canAutoCollapse({ ...view, top: 200, bottom: 700, atBottom: false }), false)
})

check('停在底部时视口中间的卡片也算尾部', () => {
  assert.equal(SEARCH_BOTTOM_SLACK_PX, 48)
  assert.equal(canAutoCollapse({ ...view, top: 300, bottom: 500, atBottom: true }), true)
})

check('碰到视口底边按尾部处理，留出 32px 余量', () => {
  assert.equal(SEARCH_TAIL_SLACK_PX, 32)
  assert.equal(canAutoCollapse({ ...view, top: 700, bottom: view.viewBottom - SEARCH_TAIL_SLACK_PX, atBottom: false }), true)
  assert.equal(canAutoCollapse({ ...view, top: 700, bottom: view.viewBottom - SEARCH_TAIL_SLACK_PX - 1, atBottom: false }), false)
})

check('没有可视高度时不自动收起', () => {
  assert.equal(canAutoCollapse({ top: 0, bottom: 50, viewTop: 0, viewBottom: 0, atBottom: true }), false)
})

process.stdout.write(`\n${pass} 项通过\n`)
