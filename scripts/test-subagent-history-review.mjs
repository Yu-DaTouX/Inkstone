import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label}（${detail}）`)
  checks += 1
}

const root = await mkdtemp(join(tmpdir(), 'yan-history-review-'))
const worktreePath = join(root, 'worktree')
try {
  await mkdir(worktreePath, { recursive: true })
  const controllerFile = join(root, 'controller.mjs')
  await build({
    entryPoints: ['src/main/subagents.ts'],
    outfile: controllerFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [{
      name: 'review-fixture',
      setup(b) {
        b.onResolve({ filter: /^\.\/subagent-isolation$/ }, () => ({ path: 'isolation', namespace: 'fixture' }))
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
          export const cleanupWorkspace = async () => {
            globalThis.cleanupCalls++
            const next = globalThis.cleanupQueue.shift()
            return next ?? { ok: true, errors: [] }
          }
          export const collectDiff = async () => ({ summary: { files: 0, additions: 0, deletions: 0, paths: [], truncated: false } })
          export const applyPatch = async () => { globalThis.applyCalls++; return { ok: true } }
          export const prepareWorkspace = async () => ({})
          export const preserveIgnoredOutputs = async () => ({ ok: true, files: [] })
          export const savedOutputsDir = (dir, id) => dir + '/' + id + '-outputs'
          export const recoverWorktree = async () => null
        ` }))
      }
    }]
  })
  const { SubagentController } = await import(pathToFileURL(controllerFile).href)
  globalThis.applyCalls = 0
  globalThis.cleanupCalls = 0
  globalThis.cleanupQueue = []

  const controller = Object.create(SubagentController.prototype)
  controller.opts = { archiveDir: join(root, 'archive'), onChange: () => {} }
  controller.runs = new Map()
  controller.resuming = new Map()
  controller.reviewing = new Set()
  let record
  controller.history = {
    get: () => record,
    save: async (run) => { record = { ...record, run: { ...run } } }
  }
  const workspace = { isolation: 'worktree', rootCwd: root, cwd: worktreePath, repoRoot: root, worktreePath }
  const diff = { files: 1, additions: 1, deletions: 0, paths: ['changed.txt'], truncated: false, patchPath: join(root, 'sub.patch') }

  record = {
    rootCwd: root,
    resume: { workspace },
    run: { id: 'sub-hist', task: '改点东西', status: 'done', isolation: 'worktree', review: 'pending', diff, workspace }
  }

  globalThis.cleanupQueue.push({ ok: false, errors: ['fixture worktree locked'] })
  const first = await controller.merge('sub-hist')
  ok(first.ok === false && /补丁已合并/.test(first.error ?? ''), '历史 merge：补丁已应用但清理失败时如实报错', JSON.stringify(first))
  ok(/只重试清理/.test(first.error ?? ''), '错误说明重试只清理、不重复应用', first.error)
  ok(record.run.review === 'merged', '补丁真正应用后状态就是已合并，不回退成待合并', record.run.review)
  ok(globalThis.applyCalls === 1, '第一次 merge 只应用一次补丁', String(globalThis.applyCalls))
  ok(/fixture worktree locked/.test(record.run.error ?? ''), '清理失败原因写进记录', record.run.error)

  const retried = await controller.merge('sub-hist')
  ok(retried.ok === true, '清理修好后重试 merge 成功', JSON.stringify(retried))
  ok(globalThis.applyCalls === 1, '重试只清理，不重复应用补丁', String(globalThis.applyCalls))
  ok(globalThis.cleanupCalls === 2, '重试确实又清理了一次', String(globalThis.cleanupCalls))
  ok(record.run.review === 'merged', '重试成功后仍是已合并', record.run.review)

  const already = await controller.merge('sub-hist')
  ok(already.ok === true && globalThis.applyCalls === 1, '已清理的合并再次 merge 直接成功、不再应用补丁', String(globalThis.applyCalls))

  record = {
    rootCwd: root,
    resume: { workspace },
    run: { id: 'sub-discard', task: '改点东西', status: 'done', isolation: 'worktree', review: 'pending', diff, workspace }
  }
  const applyBefore = globalThis.applyCalls
  globalThis.cleanupQueue.push({ ok: false, errors: ['fixture worktree locked'] })
  const discardFailed = await controller.discard('sub-discard')
  ok(discardFailed.ok === false && record.run.review === 'pending', '历史 discard 清理失败保留原 review', JSON.stringify({ result: discardFailed, review: record.run.review }))
  globalThis.cleanupQueue.push({ ok: true, errors: [] })
  const discardRetried = await controller.discard('sub-discard')
  ok(discardRetried.ok === true && record.run.review === 'discarded', 'discard 重试成功后标记已放弃', JSON.stringify({ result: discardRetried, review: record.run.review }))
  ok(globalThis.applyCalls === applyBefore, 'discard 从不应用补丁', String(globalThis.applyCalls))
} finally {
  await rm(root, { recursive: true, force: true })
  delete globalThis.applyCalls
  delete globalThis.cleanupCalls
  delete globalThis.cleanupQueue
}

console.log(`subagent-history-review: ${checks} checks passed`)
