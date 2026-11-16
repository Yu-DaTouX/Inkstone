import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'yan-service-review-'))
process.env.YAN_DATA_DIR = join(work, 'data')
process.env.YAN_PI_DIR = join(work, 'pi')
const entry = join(work, 'entry.ts')
await writeFile(entry, `export { SubagentService } from ${JSON.stringify(resolve('src/main/subagent-service.ts').split(sep).join('/'))}`)
const outfile = join(work, 'fixture.mjs')
await build({
  entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{ name: 'electron-fixture', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: [
      'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
      'export const BrowserWindow = class {}',
      'export const safeStorage = { isEncryptionAvailable: () => false }',
      'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
      'export const session = { defaultSession: {}, fromPartition: () => ({}) }'
    ].join('\n') }))
  } }]
})
let checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks += 1 }
try {
  const { SubagentService } = await import(pathToFileURL(outfile).href)
  const archive = join(work, 'archive')
  const outputs = join(archive, 'sub-a1b2c3d4-outputs')
  await mkdir(join(outputs, '.tmp'), { recursive: true })
  await writeFile(join(outputs, '.tmp', 'shot.png'), Buffer.alloc(2048))
  await mkdir(join(archive, 'sub-b2c3d4e5-outputs'), { recursive: true })
  await writeFile(join(archive, 'sub-b2c3d4e5-outputs', 'old.log'), Buffer.alloc(4096))
  const run = { id: 'sub-a1b2c3d4', isolation: 'worktree', review: 'merged', parentSessionId: 'p', diff: { files: 1, additions: 1, deletions: 0, paths: ['a.txt'], truncated: false }, savedOutputsPath: outputs }
  let next = { ok: true }
  const discards = []
  const service = new SubagentService({ resolveModelLabel: async () => ({ ok: true, label: 'fixture/fixture' }) })
  service.get = async () => ({
    setContext() {},
    parentOwns: () => true,
    get: () => run,
    merge: async () => next,
    discard: async (_id, options) => { discards.push(options); return next }
  })
  const context = { cwd: work, parentSessionId: 'p' }

  next = { ok: false, cleanupPending: true, error: '补丁已合并，但工作树没能清理，可再次 merge 只重试清理（不会重复应用补丁）：locked' }
  await assert.rejects(service.run('subagent.merge', { id: run.id }, context), (error) => {
    check(error.code === 'subagent_merge_cleanup_pending', '已合并但清理失败：单独的错误码')
    check(!/解决冲突/.test(error.message) && !/discard/.test(error.message), '不追加「解决冲突或 discard」提示')
    return true
  })
  next = { ok: false, error: '合并冲突或补丁已失效：x' }
  await assert.rejects(service.run('subagent.merge', { id: run.id }, context), (error) => {
    check(error.code === 'subagent_merge_failed' && /解决冲突/.test(error.message), '真正的合并失败仍提示解决冲突')
    return true
  })

  next = { ok: true, warning: '补丁已合并；被忽略的产物超出另存上限又没能搬走，工作树已保留：C:/wt', outputs: { ok: true, path: outputs, files: ['.tmp'], skipped: ['debug/runs'] } }
  const merged = await service.run('subagent.merge', { id: run.id }, context)
  check(merged.summary.warning === next.warning, '超限合并成功：summary 带 warning')
  check(/告诉用户/.test(merged.summary.savedOutputsSkippedNote) && /--drop-outputs/.test(merged.summary.savedOutputsSkippedNote), '没另存的路径说明要先告诉用户、得到同意再丢弃')
  check(merged.summary.savedOutputsSize === '1 MB' && /30 天/.test(merged.summary.savedOutputsRetention) && !('savedOutputsTotal' in merged.summary), '回执只写这次另存的占用与保留期，不遍历全部另存目录算合计')

  next = { ok: true, outputs: { ok: true, path: outputs, files: ['.tmp'], skipped: ['debug/runs'] } }
  const plain = await service.run('subagent.discard', { id: run.id }, context)
  check(discards.at(-1)?.dropOutputs === false && !('warning' in plain.summary), '不带参数的 discard 不确认丢弃')
  await service.run('subagent.discard', { id: run.id, 'drop-outputs': true }, context)
  check(discards.at(-1)?.dropOutputs === true, 'CLI 的 --drop-outputs（不带值解析成 true）透传为确认丢弃')
  await service.run('subagent.discard', { id: run.id, dropOutputs: 'true' }, context)
  check(discards.at(-1)?.dropOutputs === true, 'dropOutputs: "true" 同样识别')
  await service.run('subagent.discard', { id: run.id, 'drop-outputs': 'no' }, context)
  check(discards.at(-1)?.dropOutputs === false, '其他取值不算确认')
  const dropped = await service.run('subagent.discard', { id: run.id, 'drop-outputs': true }, context)
  check(/按 --drop-outputs 确认随工作树删除/.test(dropped.summary.savedOutputsSkippedNote), '确认丢弃后摘要写明这些路径已删除')

  await rm(outputs, { recursive: true, force: true })
  next = { ok: true }
  const pruned = await service.run('subagent.merge', { id: run.id }, context)
  check(/保留期/.test(pruned.summary.savedOutputsPruned ?? '') && !('savedOutputsSize' in pruned.summary), '另存目录已被保留期清理时如实说明')
  console.log(`subagent-service-review: ${checks} checks passed`)
} finally {
  await rm(work, { recursive: true, force: true })
}
