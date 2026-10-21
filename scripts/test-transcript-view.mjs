import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function load(rel) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(rel, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const view = await load('../src/renderer/src/features/session/transcript-view-model.ts')
const proc = await load('../src/renderer/src/features/session/turn-process.ts')

const empty = { defaultView: 'concise', sessions: {} }
assert.deepEqual(view.TRANSCRIPT_VIEWS, ['concise', 'thinking', 'verbose'])
assert.equal(view.effectiveView(empty, 's1'), 'concise', '没有单独设置时跟随默认')
assert.equal(view.effectiveView(empty, null), 'concise', '新会话跟随默认')
assert.equal(view.nextTranscriptView('concise'), 'thinking')
assert.equal(view.nextTranscriptView('thinking'), 'verbose')
assert.equal(view.nextTranscriptView('verbose'), 'concise', '循环回到简洁')
assert.equal(view.showsThinking('concise'), false)
assert.equal(view.showsThinking('thinking'), true)
assert.equal(view.opensEverything('verbose'), true)
assert.equal(view.opensEverything('thinking'), false)

const own = view.withSessionView(empty, 's1', 'verbose')
assert.equal(view.effectiveView(own, 's1'), 'verbose', '会话单独设置生效')
assert.equal(view.effectiveView(own, 's2'), 'concise', '不影响其他会话')
assert.deepEqual(view.withSessionView(own, 's1', 'concise').sessions, {}, '选回默认档时删除单独设置')

const capped = Array.from({ length: 5 }, (_, i) => `s${i}`).reduce((prefs, id) => view.withSessionView(prefs, id, 'thinking', 3), empty)
assert.deepEqual(Object.keys(capped.sessions), ['s2', 's3', 's4'], '只保留最近的若干会话')
assert.deepEqual(Object.keys(view.withSessionView(capped, 's2', 'verbose', 3).sessions), ['s3', 's4', 's2'], '重新设置的会话排到最新')

const madeDefault = view.withDefaultView(own, 'verbose')
assert.equal(madeDefault.defaultView, 'verbose')
assert.deepEqual(madeDefault.sessions, {}, '与新默认相同的单独设置被清掉')

assert.deepEqual(view.parseTranscriptViewPrefs(null), empty)
assert.deepEqual(view.parseTranscriptViewPrefs('{bad'), empty, '损坏的存储回到默认')
assert.deepEqual(
  view.parseTranscriptViewPrefs(JSON.stringify({ defaultView: 'verbose', sessions: { a: 'thinking', b: 'nope', '': 'verbose' } })),
  { defaultView: 'verbose', sessions: { a: 'thinking' } },
  '丢弃无效条目'
)

const tool = (id) => ({ id, name: 'bash', args: { command: id }, status: 'done' })
const segment = (over) => ({
  id: 'seg',
  sourceMessageId: 'm',
  runId: null,
  thinking: '',
  thinkingLive: false,
  tools: [],
  texts: [],
  response: null,
  commentary: [],
  ...over
})

const settled = segment({
  thinking: 'a\n\nb',
  thinkingMs: 3000,
  thinkingParts: [{ text: 'a', at: 0, ms: 1000 }, { text: 'b', at: 1, ms: 2000 }],
  tools: [tool('t1'), tool('t2')]
})
const concise = proc.conciseSegment(settled)
assert.equal(concise.thinking, '', '简洁档去掉已结束的推理')
assert.deepEqual(concise.thinkingParts, [])
const steps = proc.segmentSteps(concise)
assert.equal(steps.lead.length, 0)
assert.equal(steps.steps.length, 1, '推理不再把工具切成多段')
assert.equal(steps.steps[0].kind, 'tools')
assert.equal(steps.steps[0].tools.length, 2)

const live = proc.conciseSegment(segment({
  thinking: 'a\n\nb',
  thinkingLive: true,
  thinkingParts: [{ text: 'a', at: 0 }, { text: 'b', at: 1 }],
  tools: [tool('t1')]
}))
assert.equal(live.thinking, 'b', '简洁档保留正在进行的推理')
assert.equal(live.thinkingLive, true)
const liveSteps = proc.segmentSteps(live)
assert.equal(liveSteps.steps[0].kind, 'tools', '进行中的推理排在已有工具之后')
assert.equal(liveSteps.steps.at(-1).kind, 'thinking')

const thinkingOnly = proc.conciseSegment(segment({ thinking: 'x', thinkingParts: [{ text: 'x', at: 0 }] }))
assert.equal(proc.splitTurnProcess([thinkingOnly, segment({ id: 'r', response: { id: 'r', text: 'done' } })]).process.length, 0, '只有推理的段落在简洁档不进过程区')

const merged = proc.mergeQuietSegments([
  proc.conciseSegment(segment({ id: 'a', thinking: 'x', tools: [tool('t1')] })),
  proc.conciseSegment(segment({ id: 'b', thinking: 'y', tools: [tool('t2')] }))
])
assert.equal(merged.length, 1, '没有说明文字的相邻段落合成一组')
assert.equal(proc.segmentSteps(merged[0]).steps.length, 1)

process.stdout.write('对话显示方式：三档循环、按会话覆盖、默认值、存储容错与简洁档分组检查通过\n')
