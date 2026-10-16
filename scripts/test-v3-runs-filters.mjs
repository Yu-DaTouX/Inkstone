/**
 * v3 运行总览过滤模型单测（WP-54）。
 *
 * 现场用 esbuild 编译纯逻辑 `src/renderer/src/features/runs/runs-filter-model.ts`，
 * 不启动 Electron、不读运行历史文件、不调用模型：
 *   · 状态筛选对当前运行 / 历史的不同口径（历史没有「运行中」）；
 *   · 项目 / 模型 / 类型 / 搜索的组合过滤；
 *   · 缺字段（projectId / model）的明确降级；
 *   · 历史与当前活跃不混同；
 *   · 批选只覆盖当前筛选可见的可停运行，隐藏项不会被意外停止；
 *   · 选项收集（项目名来自正式 settings，模型 / 类型来自真实数据）与清空。
 *
 * 可独立执行：node scripts/test-v3-runs-filters.mjs
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

async function loadModel() {
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL('../src/renderer/src/features/runs/runs-filter-model.ts', import.meta.url))
    ],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const model = await loadModel()
const {
  DEFAULT_RUNS_FILTER,
  RUNS_FILTER_ALL,
  RUNS_STATUS_FILTERS,
  RUN_KINDS,
  matchesLiveFilter,
  matchesHistoryFilter,
  filterLiveRuns,
  filterHistoryRecords,
  isStoppableRun,
  isTerminalRun,
  modelKey,
  collectProjectOptions,
  collectModelOptions,
  collectKindOptions,
  hasActiveFilters,
  clearRunsFilter
} = model

/** 构造一条当前运行快照，只覆盖关心的字段。 */
function liveRun(over = {}) {
  return {
    runId: over.runId ?? 'r1',
    code: over.code ?? 'S1',
    kind: over.kind ?? 'session',
    sessionId: over.sessionId ?? 's1',
    title: over.title ?? '任务',
    startedAt: over.startedAt ?? 1000,
    phase: over.phase ?? { kind: 'running', since: 1000, activity: 'waiting-model' },
    counts: { tools: 0, edits: 0, errors: 0 },
    ...over
  }
}

/** 构造一条当天历史记录。 */
function historyRecord(over = {}) {
  return {
    runId: over.runId ?? 'h1',
    code: over.code ?? 'S1',
    kind: over.kind ?? 'session',
    sessionId: over.sessionId ?? 's1',
    title: over.title ?? '任务',
    startedAt: over.startedAt ?? 1000,
    endedAt: over.endedAt ?? 2000,
    terminal: over.terminal ?? 'done',
    segments: over.segments ?? [],
    counts: { tools: 0, edits: 0, errors: 0 },
    ...over
  }
}

function filter(over = {}) {
  return { ...DEFAULT_RUNS_FILTER, ...over }
}

/* ── 1. 常量与默认值 ─────────────────────────────────────── */
assert.deepEqual([...RUNS_STATUS_FILTERS], ['all', 'attention', 'active', 'done', 'stopped'], '五个状态筛选')
assert.deepEqual([...RUN_KINDS], ['session', 'subagent', 'scheduled', 'review'], '四种运行类型')
assert.equal(RUNS_FILTER_ALL, 'all')
assert.equal(hasActiveFilters(DEFAULT_RUNS_FILTER), false, '默认不过滤')
assert.equal(hasActiveFilters(filter({ query: '   ' })), false, '空白搜索不算过滤')

/* ── 2. 状态筛选：当前运行 ───────────────────────────────── */
const byKind = (phaseKind, over = {}) => liveRun({ phase: { kind: phaseKind, since: 1 }, ...over })
for (const kind of ['running', 'queued']) {
  assert.equal(matchesLiveFilter(byKind(kind), filter({ status: 'active' })), true, `${kind} 属于运行中`)
}
for (const kind of ['needs-you', 'stalled', 'failed']) {
  assert.equal(matchesLiveFilter(byKind(kind), filter({ status: 'attention' })), true, `${kind} 属于需要处理`)
}
assert.equal(matchesLiveFilter(byKind('done'), filter({ status: 'done' })), true)
assert.equal(matchesLiveFilter(byKind('stopped'), filter({ status: 'stopped' })), true)
assert.equal(matchesLiveFilter(byKind('done'), filter({ status: 'active' })), false, '完成不算运行中')
assert.equal(matchesLiveFilter(byKind('running'), filter({ status: 'attention' })), false, '运行中不算需要处理')
assert.equal(isTerminalRun(byKind('done')), true)
assert.equal(isTerminalRun(byKind('failed')), true)
assert.equal(isTerminalRun(byKind('stopped')), true)
assert.equal(isStoppableRun(byKind('running')), true)
assert.equal(isStoppableRun(byKind('queued')), true)
assert.equal(isStoppableRun(byKind('done')), false, '终态不可停')

/* ── 3. 状态筛选：历史没有「运行中」，不把历史当当前活跃 ── */
assert.equal(matchesHistoryFilter(historyRecord({ terminal: 'done' }), filter({ status: 'active' })), false)
assert.equal(matchesHistoryFilter(historyRecord({ terminal: 'failed' }), filter({ status: 'active' })), false)
assert.equal(matchesHistoryFilter(historyRecord({ terminal: 'failed' }), filter({ status: 'attention' })), true)
assert.equal(matchesHistoryFilter(historyRecord({ terminal: 'done' }), filter({ status: 'done' })), true)
assert.equal(matchesHistoryFilter(historyRecord({ terminal: 'stopped' }), filter({ status: 'stopped' })), true)
assert.equal(matchesHistoryFilter(historyRecord({ terminal: 'done' }), filter({ status: 'all' })), true)
/* 相同字段的当前运行与历史，在「运行中」筛选下结果必须相反。 */
assert.equal(matchesLiveFilter(byKind('running'), filter({ status: 'active' })), true)
assert.equal(matchesHistoryFilter(historyRecord({ terminal: 'done' }), filter({ status: 'active' })), false)

/* ── 4. 组合过滤：状态 + 类型 + 项目 + 模型 + 搜索 ───────── */
const target = liveRun({
  runId: 'r-sub',
  kind: 'subagent',
  projectId: 'p1',
  title: '补齐 PKCE 单元测试',
  model: { provider: 'anthropic', id: 'm1', label: 'Sonnet 5.5' },
  phase: { kind: 'running', since: 1 }
})
const combined = filter({ status: 'active', kind: 'subagent', projectId: 'p1', modelId: 'm1', query: 'pkce' })
assert.equal(matchesLiveFilter(target, combined), true, '五项同时命中')
assert.equal(matchesLiveFilter(target, { ...combined, status: 'done' }), false, '状态不命中')
assert.equal(matchesLiveFilter(target, { ...combined, kind: 'session' }), false, '类型不命中')
assert.equal(matchesLiveFilter(target, { ...combined, projectId: 'p2' }), false, '项目不命中')
assert.equal(matchesLiveFilter(target, { ...combined, modelId: 'm2' }), false, '模型不命中')
assert.equal(matchesLiveFilter(target, { ...combined, query: 'nope' }), false, '搜索不命中')

/* 搜索覆盖编号 / 标题 / 模型 label / 模型 id，且大小写与空白无关。 */
assert.equal(matchesLiveFilter(target, filter({ query: 'PKCE' })), true)
assert.equal(matchesLiveFilter(target, filter({ query: '  pkce  ' })), true)
assert.equal(matchesLiveFilter(target, filter({ query: 'Sonnet' })), true)
assert.equal(matchesLiveFilter(target, filter({ query: 'anthropic' })), false, 'provider 不冒充搜索项')
assert.equal(matchesLiveFilter(target, filter({ query: 'm1' })), true)
assert.equal(matchesLiveFilter(target, filter({ query: 's1' })), true, '编号参与搜索（不区分大小写）')
assert.equal(matchesLiveFilter(target, filter({ query: 'r-sub' })), false, 'runId 不参与搜索')

/* ── 5. 缺字段降级：具体筛选排除，全部筛选保留 ───────────── */
const noProject = liveRun({ runId: 'r-noproject', kind: 'subagent' })
assert.equal(hasActiveFilters(filter({ projectId: 'p1' })), true)
assert.equal(matchesLiveFilter(noProject, filter({ projectId: RUNS_FILTER_ALL })), true, '缺 projectId + 全部 → 保留')
assert.equal(matchesLiveFilter(noProject, filter({ projectId: 'p1' })), false, '缺 projectId + 具体 → 排除')
assert.equal(matchesLiveFilter(target, filter({ projectId: 'p1' })), true, '有 projectId 且命中 → 保留')
const recordNoProject = historyRecord({ runId: 'h-noproject' })
assert.equal(matchesHistoryFilter(recordNoProject, filter({ projectId: RUNS_FILTER_ALL })), true)
assert.equal(matchesHistoryFilter(recordNoProject, filter({ projectId: 'p1' })), false, '历史缺字段同样排除')

const noModel = liveRun({ runId: 'r-nomodel' })
assert.equal(matchesLiveFilter(noModel, filter({ modelId: RUNS_FILTER_ALL })), true)
assert.equal(matchesLiveFilter(noModel, filter({ modelId: 'm1' })), false, '缺 model + 具体 → 排除')
assert.equal(matchesLiveFilter(target, filter({ modelId: 'm1' })), true, '有 model 且命中 → 保留')

assert.equal(modelKey(undefined), null)
assert.equal(modelKey({ provider: 'a', id: '   ', label: 'x' }), null, '空 id 不冒充模型键')
assert.equal(modelKey({ provider: 'a', id: 'm1', label: 'x' }), 'm1')

/* ── 6. 过滤函数保持顺序、不修改输入，且只留命中项 ───────── */
const list = [
  liveRun({ runId: 'a', kind: 'session', phase: { kind: 'running', since: 1 } }),
  liveRun({ runId: 'b', kind: 'subagent', phase: { kind: 'running', since: 1 } }),
  liveRun({ runId: 'c', kind: 'subagent', phase: { kind: 'done', at: 1, seen: false } }),
  liveRun({ runId: 'd', kind: 'subagent', phase: { kind: 'queued', since: 1, reason: 'concurrency' } })
]
const onlySubagents = filterLiveRuns(list, filter({ kind: 'subagent' }))
assert.deepEqual(onlySubagents.map((r) => r.runId), ['b', 'c', 'd'], '过滤保序且只留命中项')
assert.equal(list.length, 4, '输入数组不被修改')

const records = [
  historyRecord({ runId: 'h1', kind: 'session', terminal: 'done' }),
  historyRecord({ runId: 'h2', kind: 'subagent', terminal: 'failed' })
]
assert.deepEqual(
  filterHistoryRecords(records, filter({ kind: 'subagent' })).map((r) => r.runId),
  ['h2']
)
assert.deepEqual(
  filterHistoryRecords(records, filter({ status: 'active' })).map((r) => r.runId),
  [],
  '历史「运行中」筛选恒为空'
)

/* ── 7. 批选安全：隐藏项不会被选进、不可停的不算 ─────────── */
const visibleSubagents = filterLiveRuns(list, filter({ kind: 'subagent' }))
const selectable = visibleSubagents.filter(isStoppableRun)
assert.deepEqual(selectable.map((r) => r.runId), ['b', 'd'], '只把可见且进行中的子 Agent 列为可停')
/* 用户先前勾选过、随后被筛选隐藏的运行：交集里必须消失。 */
const staleSelection = new Set(['a', 'b', 'd'])
const selectedActive = selectable.filter((run) => staleSelection.has(run.runId))
assert.deepEqual(selectedActive.map((r) => r.runId), ['b', 'd'], '隐藏的 a 不在批选集合里')
assert.equal(selectedActive.some((run) => run.runId === 'a'), false)

/* ── 8. 选项收集 ─────────────────────────────────────────── */
const optionRuns = [
  liveRun({ runId: 'o1', projectId: 'p2', model: { provider: 'x', id: 'm1', label: 'Model One' } }),
  liveRun({ runId: 'o2', projectId: 'p1', model: { provider: 'x', id: 'm2', label: 'Model Two' } })
]
const optionRecords = [
  historyRecord({ runId: 'ho1', projectId: 'p2', model: { provider: 'x', id: 'm1', label: 'Model One' } }),
  historyRecord({ runId: 'ho2', projectId: 'p3' })
]
const projects = [
  { id: 'p1', name: 'Alpha' },
  { id: 'p2', name: '' },
  { id: 'p0', name: 'Unused' }
]
assert.deepEqual(
  collectProjectOptions(optionRuns, optionRecords, projects),
  [
    { id: 'p1', label: 'Alpha' },
    { id: 'p2', label: 'p2' },
    { id: 'p3', label: 'p3' }
  ],
  '项目名优先取 settings，取不到用 id，只收集出现过的项目'
)
assert.deepEqual(
  collectModelOptions(optionRuns, optionRecords),
  [
    { id: 'm1', label: 'Model One' },
    { id: 'm2', label: 'Model Two' }
  ],
  '模型去重且用 label 显示'
)
assert.deepEqual(
  collectKindOptions(
    [liveRun({ kind: 'review' }), liveRun({ kind: 'subagent' })],
    [historyRecord({ kind: 'session' })]
  ),
  ['session', 'subagent', 'review'],
  '类型按正式顺序，且只列出现过的'
)
assert.deepEqual(collectProjectOptions([liveRun({})], [], projects), [], '没有带项目的运行就不给项目选项')
assert.deepEqual(collectModelOptions([liveRun({})], []), [], '没有带模型的运行就不给模型选项')

/* ── 9. 清空筛选 ─────────────────────────────────────────── */
const dirty = filter({ status: 'active', kind: 'subagent', projectId: 'p1', modelId: 'm1', query: 'x' })
assert.equal(hasActiveFilters(dirty), true)
const cleared = clearRunsFilter()
assert.equal(hasActiveFilters(cleared), false)
assert.notEqual(cleared, DEFAULT_RUNS_FILTER, '清空返回新对象')
cleared.query = 'mutated'
assert.equal(DEFAULT_RUNS_FILTER.query, '', '默认值不被清空结果污染')

console.log('test-v3-runs-filters: 全部通过')
