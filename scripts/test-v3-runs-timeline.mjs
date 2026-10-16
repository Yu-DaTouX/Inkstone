import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

function syntheticRecords(day, count = 200) {
  const { from } = dayWindow(day)
  const phases = ['running', 'needs-you', 'stalled', 'done', 'failed']
  const terminals = ['done', 'stopped', 'failed']
  const records = []
  for (let i = 0; i < count; i += 1) {
    const start = from + ((i * 331_000) % 86_400_000)
    const duration = 30_000 + ((i * 7_919) % 3_600_000)
    const endedAt = Math.min(from + 86_400_000 - 1, start + duration)
    const span = Math.max(1, endedAt - start)
    const p0 = phases[i % phases.length]
    const p1 = phases[(i + 2) % phases.length]
    const segments = [
      { phase: p0, from: start, to: start + Math.floor(span * 0.4) },
      { phase: p1, from: start + Math.floor(span * 0.4), to: start + Math.floor(span * 0.8) },
      { phase: terminals[i % terminals.length], from: start + Math.floor(span * 0.8), to: endedAt }
    ]
    records.push({
      runId: `run-${i}`,
      code: `S1·${i}`,
      kind: i % 3 === 0 ? 'subagent' : 'session',
      sessionId: i % 3 === 0 ? `subagent:sub-${i}` : `s-${i}`,
      title: `任务 ${i}`,
      startedAt: start,
      endedAt,
      terminal: terminals[i % terminals.length],
      segments,
      ...(i % 3 === 0 ? { parentRunId: 'run-parent' } : {}),
      ...(i % 4 === 0 ? { costUsd: 0.01 * i } : {}),
      counts: { tools: i % 9, edits: i % 3, errors: i % 2 }
    })
  }
  return records
}

async function loadModel() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/renderer/src/features/runs/runs-timeline-model.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const { dayWindow, tickLabel, layoutDayTimeline, visibleLaneRange, DAY_TICKS } = await loadModel()

const day = '2026-01-02'
const window2026 = dayWindow(day)
assert.equal(window2026.from, new Date(2026, 0, 2).getTime(), '起点是当天本地 00:00')
assert.equal(window2026.to, new Date(2026, 0, 3).getTime(), '终点是次日本地 00:00')
assert.equal(window2026.to - window2026.from, 24 * 3_600_000, '非夏令时日期是 24 小时')
assert.deepEqual([...DAY_TICKS], [0, 6, 12, 18, 24], '刻度固定在 0/6/12/18/24 时')
assert.equal(tickLabel(0), '00:00')
assert.equal(tickLabel(6), '06:00')
assert.equal(tickLabel(24), '24:00')

const records = syntheticRecords(day)
const started = performance.now()
const layout = layoutDayTimeline(records, day)
const elapsed = performance.now() - started

assert.equal(layout.lanes.length, 200, '每条记录一条泳道')
assert.equal(layout.day, day)
assert.equal(layout.totalMs, 24 * 3_600_000)
assert.ok(elapsed < 100, `200 条记录布局耗时应小于 100ms，实际 ${elapsed.toFixed(2)}ms`)

let previousStart = -Infinity
for (const lane of layout.lanes) {
  assert.ok(lane.startedAt >= previousStart, '泳道按开始时间升序')
  previousStart = lane.startedAt
  assert.ok(lane.segments.length >= 1, '每条泳道至少一段')
  if (lane.kind === 'subagent') assert.equal(lane.parentRunId, 'run-parent', '子 Agent 泳道保留父运行 id')
  for (const segment of lane.segments) {
    assert.ok(segment.left >= 0 && segment.left <= 1, '色段 left 在 [0,1]')
    assert.ok(segment.width > 0, '色段宽度为正')
    assert.ok(segment.left + segment.width <= 1 + 1e-9, '色段不溢出当天')
    assert.equal(segment.durationMs, segment.to - segment.from, '时长与起止一致')
  }
}

const dayFrom = window2026.from
const crossing = {
  runId: 'cross',
  code: 'S9',
  kind: 'session',
  sessionId: 's9',
  title: '跨零点',
  startedAt: dayFrom - 3_600_000,
  endedAt: dayFrom + 3_600_000,
  terminal: 'done',
  segments: [{ phase: 'running', from: dayFrom - 3_600_000, to: dayFrom + 3_600_000 }],
  counts: { tools: 0, edits: 0, errors: 0 }
}
const [lane] = layoutDayTimeline([crossing], day).lanes
assert.equal(lane.segments.length, 1)
assert.equal(lane.segments[0].from, dayFrom, '跨零点色段夹到当天 00:00')
assert.equal(lane.segments[0].to, dayFrom + 3_600_000, '跨零点色段只取当天部分')
assert.equal(lane.segments[0].left, 0)
assert.ok(Math.abs(lane.segments[0].width - 1 / 24) < 1e-9, '跨零点色段宽度是 1/24 天')
assert.equal(lane.durationMs, 7_200_000, '泳道总时长仍显示真实值')

const fallback = {
  runId: 'fb',
  code: 'S8',
  kind: 'subagent',
  sessionId: 'subagent:sub-8',
  title: '回退',
  startedAt: dayFrom + 3_600_000,
  endedAt: dayFrom + 7_200_000,
  terminal: 'failed',
  segments: [],
  counts: { tools: 1, edits: 0, errors: 1 }
}
const [fallbackLane] = layoutDayTimeline([fallback], day).lanes
assert.equal(fallbackLane.segments.length, 1, '缺 segments 时补一条终态段')
assert.equal(fallbackLane.segments[0].phase, 'failed', '回退段用终态作为色相')

const outside = { ...fallback, runId: 'out', startedAt: dayFrom - 86_400_000, endedAt: dayFrom - 82_800_000 }
const taken = layoutDayTimeline([outside], day).lanes
assert.equal(taken.length, 1, '当天之外的记录仍产生一条泳道，不抛异常')
assert.ok(Number.isFinite(taken[0].segments[0].left), '边界回退不产生 NaN')

assert.deepEqual(layoutDayTimeline([], day).lanes, [], '空输入返回空泳道')

const top = visibleLaneRange(0, 320, 24, 200, 4)
assert.equal(top.start, 0)
assert.equal(top.end, Math.ceil(320 / 24) + 8 + 1)
assert.equal(top.padTop, 0)
assert.equal(top.padBottom, (200 - top.end) * 24)

const middle = visibleLaneRange(2400, 320, 24, 200, 4)
assert.equal(middle.start, 96, '滚动到第 100 行时从第 96 行开始渲染（含 overscan）')
assert.equal(middle.end, Math.min(200, middle.start + Math.ceil(320 / 24) + 8 + 1))
assert.equal(middle.padTop, 96 * 24)

const bottom = visibleLaneRange(1_000_000, 320, 24, 200, 4)
assert.equal(bottom.end, 200, '滚到底时渲染最后一行')
assert.equal(bottom.padBottom, 0)
assert.equal(bottom.padTop, bottom.start * 24)

assert.deepEqual(visibleLaneRange(0, 320, 0, 200, 4), { start: 0, end: 0, padTop: 0, padBottom: 0 }, '零行高不除零')
assert.deepEqual(visibleLaneRange(0, 320, 24, 0, 4), { start: 0, end: 0, padTop: 0, padBottom: 0 }, '没有泳道时窗口为空')

console.log(`v3-runs-timeline: 全部通过（200 条布局 ${elapsed.toFixed(2)}ms）`)
