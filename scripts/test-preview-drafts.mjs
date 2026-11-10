#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

const root = await mkdtemp(join(tmpdir(), 'yan-preview-drafts-'))
const sourceOf = (relative) => fileURLToPath(new URL(relative, import.meta.url)).replaceAll('\\', '/')
const outfile = join(root, 'preview-drafts.mjs')
await build({
  entryPoints: [sourceOf('../src/renderer/src/features/preview/preview-drafts.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const d = await import(pathToFileURL(outfile).href)

const A = 'C:/p/a.md'
const B = 'C:/p/b.md'
const edited = (drafts, abs, text) => d.patchDraft(drafts, abs, (value) => ({ ...value, text }))

await check('A 有未保存草稿时为 B 建草稿不影响 A', () => {
  let drafts = d.putDraft(d.EMPTY_PREVIEW_DRAFTS, d.loadedDraft(A, 'a0', 'h1'))
  drafts = edited(drafts, A, 'a1')
  const before = drafts.get(A)
  drafts = d.putDraft(drafts, d.loadedDraft(B, 'b0', 'h2'))
  assert.equal(drafts.get(A), before)
  assert.equal(drafts.get(A).text, 'a1')
  assert.equal(drafts.get(B).text, 'b0')
})

await check('对 A 的异步结果在当前激活 B 时仍只写 A', () => {
  let drafts = d.putDraft(d.EMPTY_PREVIEW_DRAFTS, d.loadedDraft(A, 'a0', 'h1'))
  drafts = d.putDraft(drafts, d.loadedDraft(B, 'b0', 'h2'))
  drafts = edited(drafts, A, 'a1')
  const bBefore = drafts.get(B)
  drafts = d.patchDraft(drafts, A, (value) => ({ ...value, original: 'a1', hash: 'h3', saving: false }))
  assert.equal(drafts.get(B), bBefore)
  assert.equal(drafts.get(A).original, 'a1')
  assert.equal(d.draftIsDirty(drafts.get(A)), false)
})

await check('对不存在的草稿打补丁不会凭空创建', () => {
  const drafts = d.patchDraft(d.EMPTY_PREVIEW_DRAFTS, A, (value) => ({ ...value, saving: true }))
  assert.equal(drafts.size, 0)
  assert.equal(drafts, d.EMPTY_PREVIEW_DRAFTS)
})

await check('关闭干净的标签会丢草稿，脏的保留', () => {
  let drafts = d.putDraft(d.EMPTY_PREVIEW_DRAFTS, d.loadedDraft(A, 'a0', 'h1'))
  drafts = d.putDraft(drafts, d.loadedDraft(B, 'b0', 'h2'))
  drafts = edited(drafts, A, 'a1')
  const pruned = d.dropCleanDrafts(drafts, () => false)
  assert.equal(pruned.has(A), true)
  assert.equal(pruned.has(B), false)
  assert.equal(pruned.get(A).text, 'a1')
})

await check('仍打开的标签保留干净草稿', () => {
  const drafts = d.putDraft(d.EMPTY_PREVIEW_DRAFTS, d.loadedDraft(B, 'b0', 'h2'))
  assert.equal(d.dropCleanDrafts(drafts, (abs) => abs === B), drafts)
})

await check('列出所有未保存路径', () => {
  let drafts = d.putDraft(d.EMPTY_PREVIEW_DRAFTS, d.loadedDraft(B, 'b0', 'h2'))
  drafts = d.putDraft(drafts, d.loadedDraft(A, 'a0', 'h1'))
  assert.deepEqual(d.unsavedDraftPaths(drafts), [])
  drafts = edited(drafts, B, 'b1')
  drafts = edited(drafts, A, 'a1')
  assert.deepEqual(d.unsavedDraftPaths(drafts), [A, B])
  drafts = d.dropDraft(drafts, A)
  assert.deepEqual(d.unsavedDraftPaths(drafts), [B])
})

await check('放弃只丢当前文件的草稿', () => {
  let drafts = d.putDraft(d.EMPTY_PREVIEW_DRAFTS, d.loadedDraft(A, 'a0', 'h1'))
  drafts = edited(d.putDraft(drafts, d.loadedDraft(B, 'b0', 'h2')), B, 'b1')
  drafts = d.dropDraft(drafts, A)
  assert.equal(drafts.has(A), false)
  assert.equal(drafts.get(B).text, 'b1')
})

process.stdout.write(`\n${report.pass} 通过，${report.fail} 失败\n`)
if (report.fail || report.pass === 0) process.exitCode = 1
