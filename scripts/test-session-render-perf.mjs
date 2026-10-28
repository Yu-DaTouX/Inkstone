import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')
const SEP = '\u0001'

async function load(dir) {
  const session = posix(join(ROOT, 'src/renderer/src/features/session'))
  const entry = join(dir, 'entry.ts')
  await writeFile(entry, [
    `export * from '${session}/tool-run-model.ts'`,
    `export { pagerTreeCurrent } from '${session}/branch-pager-model.ts'`,
    `export * from '${session}/markdown-tail-throttle.ts'`,
    `export * from '${session}/effective-messages.ts'`,
    `export { withoutWrapUpMessages } from '${session}/wrap-up.ts'`
  ].join('\n'))
  const outfile = join(dir, 'bundle.mjs')
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', jsx: 'automatic' })
  return import(pathToFileURL(outfile).href)
}

const call = (id, name, args = {}, extra = {}) => ({ id, name, args, status: 'ok', ...extra })
const user = (id, parentId, kids = []) => ({ entry: { id, parentId, type: 'message', message: { role: 'user', content: id } }, children: kids })
const assistant = (id, parentId, kids = []) => ({ entry: { id, parentId, type: 'message', message: { role: 'assistant', content: id } }, children: kids })

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-render-perf-'))
  try {
    const m = await load(dir)

    const reads = [call('r1', 'read', { path: 'a.ts' }), call('r2', 'read', { path: 'b.ts' }), call('r3', 'read', { path: 'c.ts' })]
    const first = m.buildToolRows(reads)
    const same = m.buildToolRows(reads, undefined, { previous: first })
    assert.equal(same.length, 1)
    assert.equal(same[0], first[0], '调用未变化时组行沿用同一对象')
    const grown = m.buildToolRows([...reads, call('r4', 'read', { path: 'd.ts' })], undefined, { previous: first })
    assert.notEqual(grown[0], first[0], '组里多了调用时重新汇总')
    const replaced = m.buildToolRows([reads[0], { ...reads[1] }, reads[2]], undefined, { previous: first })
    assert.notEqual(replaced[0], first[0], '组里某个调用换了对象时重新汇总')
    const lone = [call('only', 'bash', { command: 'ls' })]
    const loneRows = m.buildToolRows(lone)
    assert.equal(m.buildToolRows(lone, undefined, { previous: loneRows })[0], loneRows[0], '单行沿用同一对象')

    const running = [call('s1', 'read', { path: 'a.ts' }), call('s2', 'bash', { command: 'sleep' }, { status: 'running' })]
    const liveRows = m.buildToolRows(running, new Set())
    const blockedRows = m.buildToolRows(running, new Set(['s2']), { previous: liveRows })
    assert.notEqual(blockedRows[0], liveRows[0], '审批状态变化时组行重新汇总')
    assert.equal(blockedRows[0].summary.needsApproval, true)

    const cache = m.cachedToolRows(null, reads, new Set())
    assert.equal(m.cachedToolRows(cache, [...reads], new Set()), cache, '调用逐个相同、审批集合相同时整体复用缓存')
    const after = m.cachedToolRows(cache, [...reads, call('r4', 'read', { path: 'd.ts' })], new Set())
    assert.notEqual(after, cache)
    assert.equal(m.cachedToolRows(after, after.tools, new Set(['x'])).rows.length, 1)

    const a = [{ call: reads[0], children: [{ call: reads[1], children: [] }] }]
    const b = [{ call: reads[0], children: [{ call: reads[1], children: [] }] }]
    assert.equal(m.toolNodesEqual(a, b), true)
    assert.equal(m.toolNodesEqual(a, [{ call: reads[0], children: [] }]), false)

    const tip = [user('u1', null, [assistant('a1', 'u1', [user('u2', 'a1', [assistant('a2', 'u2')])])])]
    const sig = ['u1', 'a1', 'u2', 'a2'].join(SEP)
    assert.equal(m.pagerTreeCurrent({ tree: tip, leafId: 'a2', loadedSignature: sig, signature: `${sig}${SEP}u3${SEP}a3` }), true, '在叶子上追加新消息不重拉分支树')
    assert.equal(m.pagerTreeCurrent({ tree: tip, leafId: 'a2', loadedSignature: sig, signature: sig }), true, '签名没变不重拉')
    assert.equal(m.pagerTreeCurrent({ tree: tip, leafId: 'a1', loadedSignature: `u1${SEP}a1`, signature: `u1${SEP}a1${SEP}x` }), false, '当前叶子下面已有子节点时要重拉')
    assert.equal(m.pagerTreeCurrent({ tree: tip, leafId: 'a2', loadedSignature: sig, signature: `u1${SEP}a1${SEP}u9` }), false, '回退或换分支后要重拉')
    assert.equal(m.pagerTreeCurrent({ tree: tip, leafId: 'a2', loadedSignature: sig, signature: `${sig}x` }), false, '前缀必须落在条目边界上')
    assert.equal(m.pagerTreeCurrent({ tree: null, leafId: 'a2', loadedSignature: sig, signature: sig }), false)
    assert.equal(m.pagerTreeCurrent({ tree: tip, leafId: null, loadedSignature: sig, signature: sig }), false)
    assert.equal(m.pagerTreeCurrent({ tree: tip, leafId: 'a2', loadedSignature: '', signature: 'u1' }), false, '空会话第一次有内容时要拉')

    const long = 'x'.repeat(5000)
    const t0 = m.throttleTail(null, { offset: 0, text: long }, 1000)
    assert.equal(t0.text, long)
    assert.equal(t0.wait, 0)
    const t1 = m.throttleTail(t0.hold, { offset: 0, text: long + 'y' }, 1040)
    assert.equal(t1.text, long, '长末块在节流窗口内保持旧文本')
    assert.equal(t1.hold, t0.hold)
    assert.ok(t1.wait > 0 && t1.wait <= m.LONG_TAIL_THROTTLE_MS)
    const t2 = m.throttleTail(t1.hold, { offset: 0, text: long + 'yz' }, 1000 + m.LONG_TAIL_THROTTLE_MS)
    assert.equal(t2.text, long + 'yz', '窗口过后放行最新文本')
    assert.equal(t2.wait, 0)
    const shortTail = m.throttleTail({ offset: 0, text: 'ab', at: 1000 }, { offset: 0, text: 'abc' }, 1001)
    assert.equal(shortTail.text, 'abc', '短末块不节流')
    assert.equal(m.throttleTail(t0.hold, { offset: 5000, text: long + 'y' }, 1001).text, long + 'y', '末块起点变了立即放行')
    assert.equal(m.throttleTail(t0.hold, { offset: 0, text: 'z'.repeat(5001) }, 1001).text, 'z'.repeat(5001), '文本不是旧文本的延长时立即放行')

    const receipt = { toolCallId: 'c1', at: 1, decision: 'allow' }
    const withCall = { id: 'm1', role: 'assistant', text: '', toolCalls: [call('c1', 'bash')] }
    const plain = { id: 'm2', role: 'assistant', text: 'hi' }
    const entries = [receipt]
    const merged1 = m.mergeApprovalLogCached([withCall, plain], entries)
    assert.equal(merged1[1], plain)
    assert.equal(merged1[0].toolCalls[0].approval, receipt)
    const merged2 = m.mergeApprovalLogCached([withCall, plain], entries)
    assert.equal(merged2[0], merged1[0], '同一消息同一审批记录复用合并结果')
    const own = [plain]
    assert.equal(m.mergeApprovalLogCached(own, entries), own, '没有变化时返回原数组')
    assert.equal(m.mergeApprovalLogCached(own, []), own)

    assert.equal(m.countUserMessages([{ role: 'user' }, { role: 'user', question: true }, { role: 'assistant' }, { role: 'user' }]), 2)

    const plainList = [plain]
    assert.equal(m.withoutWrapUpMessages(plainList), plainList)
    assert.equal(m.withoutWrapUpMessages(plainList), plainList)

    process.stdout.write('session-render-perf：全部通过\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
  process.exit(1)
})
