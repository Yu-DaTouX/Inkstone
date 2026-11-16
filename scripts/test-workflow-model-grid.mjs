import './lib/test-isolate.mjs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await runSuite(import.meta.url, async (ok, compile) => {
  const shared = await compile('src/shared/workflows.ts')
  const layout = await compile('src/renderer/src/features/session/model-grid-layout.ts')
  const { WorkflowModelLane } = await compile('src/main/workflows/model-lane.ts')
  const { JournalWriter, ModelReplay } = await compile('src/main/workflows/journal.ts')
  const { WORKFLOW_LIMITS, clipModelText, modelCellCounts, modelThroughput, interruptedModelStats, MODEL_CELL_CODE } = shared

  {
    ok(clipModelText('  a\n\n b  ', 120) === 'a b', '抽查文字折叠空白')
    const long = '译'.repeat(300)
    const clipped = clipModelText(long, WORKFLOW_LIMITS.modelLatestChars)
    ok([...clipped].length === WORKFLOW_LIMITS.modelLatestChars + 1 && clipped.endsWith('…'), '抽查文字按字符截到 120 加省略号', String([...clipped].length))
    ok(clipModelText({ a: 1 }, 120) === '{"a":1}' && clipModelText(null, 120) === '' && clipModelText(undefined, 120) === '', '非字符串结果转成 JSON 文本')
    ok(WORKFLOW_LIMITS.modelLatestChars <= 120 && WORKFLOW_LIMITS.modelFailuresShown <= 50, '视图上限：抽查 ≤120 字、失败列表 ≤50 条')
  }

  {
    const counts = modelCellCounts('qqrrdcfs')
    ok(counts.queued === 2 && counts.running === 2 && counts.done === 2 && counts.failed === 1 && counts.stopped === 1, '状态串计数（复用结果算完成）', JSON.stringify(counts))
    const pace = modelThroughput({ done: 30, running: 10, queued: 50, since: 0 }, 3 * 60_000)
    ok(pace.perMinute === 10 && pace.etaMs === 6 * 60_000, '吞吐与预计剩余', JSON.stringify(pace))
    ok(modelThroughput({ done: 0, running: 3, queued: 9, since: 0 }, 60_000).etaMs === null, '还没有完成时不估剩余时间')
    const stopped = interruptedModelStats({ total: 5, done: 1, cached: 0, failed: 1, stopped: 0, running: 2, queued: 1, cells: 'drrfq', waitingQuota: true })
    ok(stopped.cells === 'dssfs' && stopped.stopped === 3 && stopped.running === 0 && stopped.queued === 0 && !stopped.waitingQuota, '中断时在跑和排队的格子改成已停止', JSON.stringify(stopped))
    ok(MODEL_CELL_CODE.cached === 'c' && MODEL_CELL_CODE.failed === 'f', '状态码约定')
  }

  {
    for (const [count, width] of [[1000, 364], [1000, 869], [5000, 364], [5000, 869], [12, 364]]) {
      const g = layout.modelGridGeometry(count, width)
      ok(g.height <= layout.MODEL_GRID_MAX_HEIGHT && g.cols * (g.size + g.gap) - g.gap <= width && g.cols * g.rows >= count && g.size >= 3, `点阵 ${count} 格 ${width} 宽不超高不超宽`, JSON.stringify(g))
    }
    const big = layout.modelGridGeometry(1000, 869)
    ok(big.size === 7, '空间够时用 7px 格', JSON.stringify(big))
    const g = { size: 7, gap: 2, cols: 10, rows: 3, height: 25 }
    ok(layout.modelGridCellAt(g, 0, 0, 30) === 0 && layout.modelGridCellAt(g, 9 * 3 + 1, 9 + 1, 30) === 13, '坐标换算到格子')
    ok(layout.modelGridCellAt(g, 9 * 10 + 1, 0, 30) === -1 && layout.modelGridCellAt(g, 1, 9 * 3 + 1, 25) === -1 && layout.modelGridCellAt(g, -1, 0, 30) === -1, '网格外与末行之后没有格子')
    const a = layout.modelGridBreath(0, 3)
    ok(a >= 0.55 && a <= 1, '呼吸透明度范围')
  }

  const dir = await mkdtemp(join(tmpdir(), 'yan-model-grid-'))
  try {
    let clock = 1_000
    const replies = new Map()
    let release
    const gate = new Promise((resolve) => (release = resolve))
    const host = {
      call: async (req) => {
        await gate
        await delay(1)
        if (req.prompt.includes('FAIL')) throw new Error(`鉴权失败 ${req.prompt}\n第二行原文 Authorization: Bearer abcdefghijklmnop ${'尾'.repeat(1500)}`)
        clock += 500
        return { text: `  译文 ${req.prompt}\n${'长'.repeat(200)}`, model: req.model, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.0015 }, durationMs: 1 }
      }
    }
    const abort = new AbortController()
    const lane = new WorkflowModelLane({
      host,
      replay: new ModelReplay(new Map()),
      journal: new JournalWriter(join(dir, 'journal.jsonl')),
      attempt: 1,
      concurrency: 4,
      defaultModel: 'fake/m',
      backoffMs: 1,
      signal: abort.signal,
      now: () => clock,
      phase: () => '翻译',
      blocked: () => false,
      reply: (seq, reply) => replies.set(seq, reply),
      onChange: () => undefined
    })
    const total = 120
    for (let i = 0; i < total; i++) lane.add(i + 1, i % 2 === 1 && i < 120 ? `FAIL ${i}` : `段 ${i}`, { label: `segments/${String(i).padStart(4, '0')}.txt`, retries: 0 })
    const early = lane.stats()
    ok(early.cells.length === total && /^r{4}q{116}$/.test(early.cells), '加入后前 4 个在跑、其余排队', early.cells.slice(0, 8))
    ok(early.since === 1_000 && !early.latest && !early.failures, '开始时间与空的抽查、失败')
    const runningCall = lane.call(0)
    ok(runningCall && runningCall.status === 'running' && runningCall.startedAt === 1_000 && runningCall.label === 'segments/0000.txt', '按序号查在跑的调用', JSON.stringify(runningCall))
    release()
    for (let i = 0; i < 400 && replies.size < total; i++) await delay(5)
    const stats = lane.stats()
    ok(replies.size === total && stats.done === 60 && stats.failed === 60, '全部结束：60 完成 60 失败', JSON.stringify({ done: stats.done, failed: stats.failed }))
    ok(modelCellCounts(stats.cells).done === 60 && modelCellCounts(stats.cells).failed === 60 && stats.cells[0] === 'd' && stats.cells[1] === 'f', '状态串与计数一致')
    ok(Math.abs(stats.cost - 60 * 0.0015) < 1e-9, '费用按 usage.cost 汇总', String(stats.cost))
    ok(stats.latest && [...stats.latest.text].length <= WORKFLOW_LIMITS.modelLatestChars + 1 && stats.latest.text.startsWith('译文 段') && stats.latest.label?.startsWith('segments/'), '只保留最近一条完成的抽查，开头一句', JSON.stringify(stats.latest))
    ok(stats.failures.length === WORKFLOW_LIMITS.modelFailuresShown, '失败列表只留前 50 条', String(stats.failures.length))
    const firstFail = stats.failures[0]
    ok(firstFail.index === 1 && firstFail.label === 'segments/0001.txt' && firstFail.error.includes('鉴权失败 FAIL 1') && firstFail.error.includes('\n第二行原文'), '失败列表带 label 与错误原文', JSON.stringify(firstFail))
    const doneCall = lane.call(0)
    ok(doneCall.status === 'done' && doneCall.endedAt >= doneCall.startedAt && !doneCall.error, '按序号查完成的调用有用时')
    const failCall = lane.call(1)
    ok(failCall.status === 'failed' && failCall.error.includes('鉴权失败'), '按序号查失败的调用有错误原文')
    ok(lane.call(total) === null && lane.call(-1) === null && lane.call(1.5) === null, '越界序号返回空')
    ok(lane.callTable().length === total && lane.callTable()[3].index === 3, '结束后可整表保留')
    ok(!firstFail.error.includes('abcdefghijklmnop') && firstFail.error.includes('[redacted]') && [...firstFail.error].length <= WORKFLOW_LIMITS.modelErrorChars + 1, '失败原文脱敏并截到 1000 字')
    ok([...failCall.error].length <= WORKFLOW_LIMITS.modelErrorChars + 1 && !failCall.error.includes('abcdefghijklmnop'), '单次调用的错误也截到 1000 字并脱敏', String([...failCall.error].length))
    await delay(50)
    const journal = (await readFile(join(dir, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const failLine = journal.find((line) => line.index === 1)
    ok(journal.length === total && journal.every((line) => Number.isInteger(line.index)) && new Set(journal.map((line) => line.index)).size === total, 'journal 每条 model 记录带 index', String(journal.length))
    ok(failLine && failLine.status === 'failed' && [...failLine.error].length <= WORKFLOW_LIMITS.modelErrorChars + 1 && !failLine.error.includes('abcdefghijklmnop'), 'journal 里的错误截断并脱敏')
    const json = JSON.stringify(stats)
    ok(!json.includes('长'.repeat(130)), '视图里没有整段输出', String(json.length))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const dir2 = await mkdtemp(join(tmpdir(), 'yan-model-grid-'))
  try {
    const abort = new AbortController()
    const many = 5000
    const lane = new WorkflowModelLane({
      host: { call: (req) => new Promise((resolve, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('已取消'), { kind: 'cancelled' })), { once: true })) },
      replay: new ModelReplay(new Map()),
      journal: new JournalWriter(join(dir2, 'journal.jsonl')),
      attempt: 1,
      concurrency: 32,
      defaultModel: 'fake/m',
      signal: abort.signal,
      now: () => Date.now(),
      phase: () => undefined,
      blocked: () => false,
      reply: () => undefined,
      onChange: () => undefined
    })
    for (let i = 0; i < many; i++) lane.add(i + 1, `段 ${i}`, { label: `segments/${i}.txt` })
    const started = performance.now()
    const view = lane.stats()
    const spent = performance.now() - started
    ok(view.cells.length === many && modelCellCounts(view.cells).running === 32, '5000 次调用的状态串长度与在跑数')
    ok(JSON.stringify(view).length < many + 2000, '5000 次调用的视图仍然小', String(JSON.stringify(view).length))
    ok(spent < 50, '5000 次调用汇总耗时小', `${spent.toFixed(1)}ms`)
    abort.abort()
    await lane.stop()
    const after = lane.stats()
    ok(!after.cells.includes('q') && !after.cells.includes('r') && modelCellCounts(after.cells).stopped === many, '停止后排队与在跑都变成已停止')
  } finally {
    await rm(dir2, { recursive: true, force: true })
  }
})
