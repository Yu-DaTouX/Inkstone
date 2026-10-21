import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dir = await mkdtemp(join(tmpdir(), 'yan-push-coalesce-'))

try {
  const outfile = join(dir, 'push-coalesce.mjs')
  await build({
    entryPoints: [join(ROOT, 'src/renderer/src/state/push-coalesce.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  const { mergeMessagePatch, MessagePatchBatch, createFrameFlush } = await import(pathToFileURL(outfile).href)

  assert.deepEqual(
    mergeMessagePatch(undefined, { textDelta: '甲' }),
    { textDelta: '甲' },
    '没有待合并的补丁时原样返回'
  )

  const merged = mergeMessagePatch({ textDelta: '甲', thinkingDelta: '想' }, { textDelta: '乙', thinkingDelta: '考' })
  assert.equal(merged.textDelta, '甲乙', '同一条消息的两个 textDelta 按顺序拼接')
  assert.equal(merged.thinkingDelta, '想考', 'thinkingDelta 同样按顺序拼接')

  const withFields = mergeMessagePatch({ textDelta: '甲', error: 'x' }, { textDelta: '乙', error: undefined })
  assert.equal(withFields.textDelta, '甲乙', '拼接不影响其它字段')
  assert.equal(withFields.error, undefined, '后到的字段覆盖先到的字段')

  const plain = mergeMessagePatch({ status: 'streaming' }, { status: 'done' })
  assert.deepEqual(plain, { status: 'done' }, '不含增量的补丁按覆盖合并')
  assert.equal('textDelta' in plain, false, '没出现过就不凭空加 textDelta')

  const fullWins = mergeMessagePatch(
    { textDelta: '你', thinkingDelta: '想' },
    { text: '你好，世界！', thinking: '想清楚了', thinkingLive: false }
  )
  assert.deepEqual(fullWins, { text: '你好，世界！', thinking: '想清楚了', thinkingLive: false }, '同批全量 text/thinking 直接覆盖待合并的增量')
  assert.equal('textDelta' in fullWins, false, '全量文本不再附带增量，避免在旧文本后面拼接')
  assert.equal('thinkingDelta' in fullWins, false, 'thinking 同理')

  const fullThenDelta = mergeMessagePatch({ text: '全文' }, { textDelta: '尾' })
  assert.deepEqual(fullThenDelta, { text: '全文尾' }, '全量之后的增量并入全量文本，不留下会被旧文本覆盖的 textDelta')

  const batch = new MessagePatchBatch()
  batch.add('m1', { textDelta: 'a' })
  batch.add('m1', { textDelta: 'b' })
  batch.add('m2', { thinkingDelta: 'c' })
  assert.equal(batch.size, 2, '按消息 id 合并，不同 id 各一条')
  const drained = batch.drain()
  assert.deepEqual(
    drained.map((item) => [item.id, item.patch]),
    [
      ['m1', { textDelta: 'ab' }],
      ['m2', { thinkingDelta: 'c' }]
    ],
    'drain 给出合并后的补丁并保持首次出现顺序'
  )
  assert.equal(batch.size, 0, 'drain 之后清空')
  assert.deepEqual(batch.drain(), [], '空批次 drain 得到空数组')

  const lateFull = new MessagePatchBatch()
  lateFull.add('m9', { textDelta: '你' })
  lateFull.add('m9', { thinkingDelta: '想' })
  lateFull.add('m9', { text: '你好，世界！', thinking: '想好了', thinkingLive: false })
  assert.deepEqual(
    lateFull.drain(),
    [{ id: 'm9', patch: { text: '你好，世界！', thinking: '想好了', thinkingLive: false } }],
    '同一帧里增量先到、收尾全量后到，落地结果就是全量文本（不再把全量盖成「旧文本 + 增量」）'
  )

  let runs = 0
  const flush = createFrameFlush(() => {
    runs += 1
  })
  flush.schedule()
  flush.schedule()
  assert.equal(runs, 0, '同一帧内多次 schedule 不立即执行')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(runs, 1, '一帧只 flush 一次')
  flush.schedule()
  flush.schedule()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(runs, 2, '下一次 schedule 重新计一次')
  flush.schedule()
  flush.cancel()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(runs, 2, 'cancel 之后不再 flush')

  console.log('test-push-coalesce: 全部通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
