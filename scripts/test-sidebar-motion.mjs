import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { createSidebarRunsSelector } = await load('src/renderer/src/features/sidebar/sidebar-runs.ts')
const select = createSidebarRunsSelector()
const run = { runId: 'r1', sessionId: 's1', sessionPath: 'a.jsonl', startedAt: 1, code: 'A1', model: { provider: 'fake', id: 'model', label: 'Fake' }, phase: { kind: 'running', since: 1 }, progress: { tools: 0 } }
let selected = select({ runs: [run] })
assert.equal(select({ runs: [{ ...run, phase: { ...run.phase }, model: { ...run.model }, progress: { tools: 40 } }] }), selected, '工具进度不使侧栏订阅失效')
let source = run
const change = (patch, label) => {
  source = { ...source, ...patch }
  const next = select({ runs: [source] })
  assert.notEqual(next, selected, label)
  selected = next
}
change({ phase: { kind: 'needs-you' } }, '审批状态要更新')
change({ phase: { kind: 'done', seen: false } }, '完成未读要更新')
change({ phase: { kind: 'done', seen: true } }, '已读要更新')
change({ sessionId: 's2' }, '归属会话要更新')
change({ sessionPath: 'b.jsonl' }, '文件归属要更新')
change({ code: 'B2' }, '编号要更新')
change({ model: { ...source.model, label: 'New' } }, '模型标签要更新')
change({ model: { ...source.model, provider: 'other' } }, '模型品牌要更新')
change({ startedAt: 2 }, '最新运行排序要更新')
assert.deepEqual(select({ runs: [] }), [], '删除运行不能留旧行状态')
assert.equal(select({ runs: [] }), select({ runs: [] }), '空列表引用稳定')
const two = select({ runs: [run, { ...run, runId: 'r2' }] })
const reordered = select({ runs: [{ ...run, runId: 'r2' }, run] })
assert.notEqual(two, reordered)
assert.equal(reordered[0], two[1], '重排序复用未变运行')
console.log('sidebar-motion: 通过（订阅稳定性）')
