import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'yan-subagent-notice-'))
const dataDir = join(temp, 'data')
process.env.YAN_DATA_DIR = dataDir
process.env.YAN_PI_DIR = join(temp, 'pi')

let checks = 0
const check = (condition, message, extra) => {
  assert.ok(condition, extra === undefined ? message : `${message}（${extra}）`)
  checks += 1
  console.log(`✓ ${message}`)
}

const user = (id, text) => ({ id, role: 'user', text, timestamp: 1 })
const asst = (id, text, extra = {}) => ({ id, role: 'assistant', text, timestamp: 1, ...extra })
const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: 0 })
const tool = (id, name, startedAt, endedAt) => ({ id, name, args: {}, status: 'ok', startedAt, endedAt })

try {
  const outDir = join(process.cwd(), '.tmp', 'subagent-notice-timing')
  await mkdir(outDir, { recursive: true })
  const outfile = join(outDir, 'subagent-notice-timing.mjs')
  await build({
    stdin: {
      contents: `
        export { groupIntoTurns, createTurnProjector, waitSpansMs, toolWaitSpans } from './src/shared/turns'
        export { createOutlineProjector } from './src/shared/outline-turns'
        export { projectSessionMetrics } from './src/shared/session-metrics'
        export { buildSubagentNotice, isSubagentNotice, parseSubagentNotice } from './src/shared/subagent-notice'
        export * as store from './src/main/turn-timing-store'
        export { TurnTimingTracker } from './src/main/turn-timing-tracker'
        export { createSubagentNotifier, findNoticeTarget, NOTICE_COALESCE_WINDOW_MS, NOTICE_BATCH_MIN_WAIT_MS, NOTICE_BATCH_MAX_WAIT_MS, NOTICE_SIBLINGS_POLL_MS, NOTICE_MAX_UNDELIVERED_RUNS } from './src/main/subagent-notify'
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })

  const mod = await import(pathToFileURL(outfile).href)
  const {
    groupIntoTurns,
    createTurnProjector,
    createOutlineProjector,
    projectSessionMetrics,
    buildSubagentNotice,
    isSubagentNotice,
    parseSubagentNotice,
    store,
    TurnTimingTracker,
    createSubagentNotifier,
    findNoticeTarget,
    NOTICE_COALESCE_WINDOW_MS,
    NOTICE_BATCH_MIN_WAIT_MS,
    NOTICE_BATCH_MAX_WAIT_MS,
    NOTICE_SIBLINGS_POLL_MS,
    NOTICE_MAX_UNDELIVERED_RUNS
  } = mod

  const notice = (id, status = 'done', task = '检查登录流程') =>
    buildSubagentNotice({ id, task, status, isolation: 'controlled-cwd', model: 'gpt-x', result: { summary: '完成' } })
  const noticeMsg = (id, status) => ({ id, role: 'user', text: notice(id, status), timestamp: 1 })

  console.log('\n--- 1. 通知分隔前后助手运行段：前一秒冻结，后一段独立计时 ---')
  const core = [
    user('m0', '把登录改好'),
    asst('m1', '已改好。', {
      elapsedMs: 1200,
      usage: usage(10, 5),
      generationTiming: { durationMs: 1200, ttftMs: 200, decodeMs: 1000 }
    }),
    noticeMsg('m2'),
    asst('m3', '子代理结论已收到，补一句总结。', {
      elapsedMs: 300,
      usage: usage(7, 3),
      generationTiming: { durationMs: 300, ttftMs: 50, decodeMs: 250 }
    })
  ]
  {
    check(isSubagentNotice(core[2].text), '构造的通知文本能被 isSubagentNotice 识别')
    const turns = groupIntoTurns(core)
    check(turns.length === 3, '三段：用户 + 两个独立助手段', `实际 ${turns.length}`)
    check(turns[0].kind === 'user' && turns[0].id === 'm0', '通知不产出用户轮（仍只有一条真实用户消息）')
    check(turns.filter((t) => t.kind === 'user').length === 1, '用户轮计数不因通知增加')

    const first = turns[1]
    const second = turns[2]
    check(first.kind === 'assistant' && first.id === 'm1', '第一段身份是通知前的助手消息')
    check(first.elapsedMs === 1200, '已结束段 elapsedMs 冻结在 1200，未被后一段刷新', String(first.elapsedMs))
    check(first.usage?.totalTokens === 15 && first.usage?.input === 10, '已结束段用量保持 15（未被复制 / 覆盖）', JSON.stringify(first.usage))
    check(JSON.stringify(first.sourceIds) === JSON.stringify(['m1']), '已结束段只归属自己的助手消息', JSON.stringify(first.sourceIds))

    check(second.kind === 'assistant' && second.id === 'm3', '第二段身份是通知后的助手消息')
    check(second.elapsedMs === 300, '后续段独立计时 300（不是 1200+300，也不是旧值）', String(second.elapsedMs))
    check(second.usage?.totalTokens === 10 && second.usage?.input === 7, '后续段用量是真实新请求 10，不复制旧段', JSON.stringify(second.usage))
    check(JSON.stringify(second.sourceIds) === JSON.stringify(['m3']), '后续段只归属自己的助手消息', JSON.stringify(second.sourceIds))

    const projected = createTurnProjector()(core)
    check(
      projected.length === 3 &&
        projected[1].elapsedMs === 1200 &&
        projected[2].elapsedMs === 300,
      'createTurnProjector 走同一边界（1200 / 300），不合并'
    )
    check(projected.every((t) => t.kind !== 'user' || t.msg.text !== core[2].text), 'projector 输出不含通知用户轮')
  }

  console.log('\n--- 2. 多次通知、背靠背通知、重复状态通知 ---')
  {
    const many = [
      user('m0', '任务'),
      asst('m1', '第一段', { elapsedMs: 100, usage: usage(1, 1) }),
      noticeMsg('m2'),
      asst('m3', '第二段', { elapsedMs: 200, usage: usage(2, 2) }),
      noticeMsg('m4', 'error'),
      asst('m5', '第三段', { elapsedMs: 300, usage: usage(3, 3) })
    ]
    const turns = groupIntoTurns(many)
    const assistants = turns.filter((t) => t.kind === 'assistant')
    check(assistants.length === 3, '三次通知分界得到三个助手段', `实际 ${assistants.length}`)
    check(
      JSON.stringify(assistants.map((t) => t.elapsedMs)) === JSON.stringify([100, 200, 300]),
      '每段保留自己的 elapsedMs（100 / 200 / 300）',
      JSON.stringify(assistants.map((t) => t.elapsedMs))
    )
    check(turns.filter((t) => t.kind === 'user').length === 1, '多次通知不增加用户轮')

    const backToBack = [
      user('m0', '任务'),
      asst('m1', '第一段', { elapsedMs: 100 }),
      noticeMsg('m2'),
      noticeMsg('m2'),
      asst('m3', '第二段', { elapsedMs: 200 })
    ]
    const bt = groupIntoTurns(backToBack).filter((t) => t.kind === 'assistant')
    check(bt.length === 2 && bt[1].elapsedMs === 200, '重复 / 背靠背通知不产生空段，也不刷前段', `实际 ${bt.length}`)
  }

  console.log('\n--- 3. 真正用户消息仍是边界，通知后仍可接真实用户轮 ---')
  {
    const seq = [
      user('m0', '第一问'),
      asst('m1', '第一答', { elapsedMs: 100 }),
      noticeMsg('m2'),
      asst('m3', '子代理汇总', { elapsedMs: 200 }),
      user('m4', '第二问'),
      asst('m5', '第二答', { elapsedMs: 300 }),
      noticeMsg('m6'),
      asst('m7', '结尾汇总', { elapsedMs: 400 })
    ]
    const turns = groupIntoTurns(seq)
    check(turns.filter((t) => t.kind === 'user').length === 2, '两条真实用户消息 = 两轮用户')
    const assistants = turns.filter((t) => t.kind === 'assistant')
    check(assistants.length === 4, '四个助手段（含两段通知后的汇总）', `实际 ${assistants.length}`)
    check(
      JSON.stringify(assistants.map((t) => t.elapsedMs)) === JSON.stringify([100, 200, 300, 400]),
      '各段计时互不污染（100 / 200 / 300 / 400）',
      JSON.stringify(assistants.map((t) => t.elapsedMs))
    )
  }

  console.log('\n--- 4. 工具等待区间不跨段重复计 ---')
  {
    const withTools = [
      user('m0', '任务'),
      asst('m1', '先看文件', { elapsedMs: 1200, toolCalls: [tool('t1', 'read', 1000, 4000)], usage: usage(5, 5) }),
      noticeMsg('m2'),
      asst('m3', '子代理结论', { elapsedMs: 300, toolCalls: [tool('t2', 'read', 5000, 6000)], usage: usage(2, 2) })
    ]
    const turns = groupIntoTurns(withTools)
    const [first, second] = turns.filter((t) => t.kind === 'assistant')
    check(first.tools.length === 1 && first.tools[0].id === 't1', '第一段的工具只属于第一段')
    check(first.waitMs === 3000, '第一段工具等待 = 并集 3000', String(first.waitMs))
    check(second.tools.length === 1 && second.tools[0].id === 't2', '第二段的工具只属于第二段')
    check(second.waitMs === 1000, '第二段工具等待 = 1000，不把第一段并进来', String(second.waitMs))
    check(first.elapsedMs === 1200 && second.elapsedMs === 300, '带工具的段计时也各自冻结')
  }

  console.log('\n--- 5. 会话累计、导航与轮数口径 ---')
  {
    const metrics = projectSessionMetrics(core, null)
    check(metrics.turns === 1, '轮数 = 有模型回答的用户回合（通知不另起一轮）', String(metrics.turns))
    check(metrics.steps === 2, '步数 = 真实模型请求数 2（通知触发的运行也算新请求）', String(metrics.steps))
    check(metrics.total === 25, '累计 Token = 15 + 10 = 25，逐条真实请求，不重复', String(metrics.total))
    check(metrics.input === 17 && metrics.output === 8, '累计输入 / 输出按真实请求相加', `${metrics.input}/${metrics.output}`)

    const outlines = createOutlineProjector()(core)
    check(outlines.length === 1, '导航只按真实用户轮出条目', String(outlines.length))
    check(outlines[0].elapsedMs === 1200, '导航取通知前已结束段的用时 1200')
    check(!outlines.some((o) => o.user.includes('subagent-notification')), '导航文本不含通知内容')

    const projectorTurns = createTurnProjector()(core)
    check(
      !projectorTurns.some((t) => t.kind === 'user' && isSubagentNotice(t.msg.text)),
      '分组投影里没有通知用户轮（导航 / 队列同源）'
    )
  }

  console.log('\n--- 6. 历史计时日志按用户 / 通知边界恢复，不串段不覆写 ---')
  {
    const g1 = { durationMs: 1200, ttftMs: 200, decodeMs: 1000 }
    const g2 = { durationMs: 300, ttftMs: 50, decodeMs: 250 }
    const rec1 = {
      v: 1,
      logicalTurnId: 'm0',
      runId: 'run-1',
      anchorId: 'm0',
      sourceIds: ['m1'],
      startedAt: 1000,
      endedAt: 2200,
      elapsedMs: 1200,
      terminalReason: 'completed',
      final: true,
      generationTimings: [g1]
    }
    const rec2 = {
      v: 1,
      logicalTurnId: 'm2',
      runId: 'run-2',
      anchorId: 'm2',
      sourceIds: ['m3'],
      startedAt: 3000,
      endedAt: 3300,
      elapsedMs: 300,
      terminalReason: 'completed',
      final: true,
      generationTimings: [g2]
    }
    await store.appendTurnTiming(dataDir, 'notice-sess', rec1)
    await store.appendTurnTiming(dataDir, 'notice-sess', rec2)
    const records = await store.readTurnTimings(dataDir, 'notice-sess')
    check(records.length === 2, '两个逻辑回合各一条记录，不互相覆盖', String(records.length))

    const reloaded = [
      user('m0', '把登录改好'),
      asst('m1', '已改好。'),
      noticeMsg('m2'),
      asst('m3', '子代理结论')
    ]
    const applied = store.applyTurnTimings(reloaded, records)
    check(applied[1].turnTiming?.elapsedMs === 1200, '通知前的助手恢复自己的 1200', JSON.stringify(applied[1].turnTiming))
    check(applied[3].turnTiming?.elapsedMs === 300, '通知后的助手恢复自己的 300', JSON.stringify(applied[3].turnTiming))
    check(JSON.stringify(applied[1].generationTiming) === JSON.stringify(g1), '生成计时按前段次序恢复 g1')
    check(JSON.stringify(applied[3].generationTiming) === JSON.stringify(g2), '生成计时按后段次序恢复 g2，不串到前段')
    check(applied[2].turnTiming === undefined, '通知消息本身不挂计时')

    const regrouped = groupIntoTurns(applied)
    const ra = regrouped.filter((t) => t.kind === 'assistant')
    check(
      ra.length === 2 && ra[0].elapsedMs === 1200 && ra[1].elapsedMs === 300,
      '重载后再分组仍保持 1200 / 300（通知是持久化的锚点边界）',
      JSON.stringify(ra.map((t) => t.elapsedMs))
    )
  }

  console.log('\n--- 7. TurnTimingTracker 为通知后的 run 单独锚定 ---')
  {
    const tracker = new TurnTimingTracker()
    tracker.elapsedMs = 1200
    tracker.runId = 'run-1'
    tracker.terminal = 'completed'
    tracker.messageIds = ['m1']
    await tracker.persist(true, 'tracker-notice.jsonl', [user('m0', '把登录改好'), asst('m1', '已改好。')])

    tracker.elapsedMs = 300
    tracker.runId = 'run-2'
    tracker.terminal = 'completed'
    tracker.messageIds = ['m3']
    await tracker.persist(true, 'tracker-notice.jsonl', [
      user('m0', '把登录改好'),
      asst('m1', '已改好。'),
      noticeMsg('m2'),
      asst('m3', '子代理结论')
    ])

    const recs = await store.readTurnTimings(dataDir, 'tracker-notice')
    check(recs.length === 2, 'tracker 为两个 run 写两条记录，不合并 / 不覆写', String(recs.length))
    const byAnchor = new Map(recs.map((r) => [r.anchorId, r]))
    check(byAnchor.get('m0')?.elapsedMs === 1200, 'run-1 锚定真实用户 m0，用时 1200')
    check(byAnchor.get('m2')?.elapsedMs === 300, 'run-2 锚定子代理通知 m2（真实边界），用时 300')
    check(byAnchor.get('m2')?.sourceIds.includes('m3'), 'run-2 只归属自己的助手消息 m3')
  }

  console.log('\n--- 8. 老记录 / 数据不完整时保持未知，不猜不串 ---')
  {
    const ghostGen = { durationMs: 999 }
    const ghost = {
      v: 1,
      logicalTurnId: 'm-ghost',
      anchorId: 'm-ghost',
      sourceIds: ['m1'],
      startedAt: 1,
      endedAt: 2,
      elapsedMs: 50,
      terminalReason: 'completed',
      generationTimings: [ghostGen, ghostGen]
    }
    const applied = store.applyTurnTimings([user('m0', '任务'), asst('m1', '答')], [ghost])
    check(applied[1].turnTiming?.elapsedMs === 50, '锚丢失时整轮用时仍按 sourceIds 回退')
    check(applied[1].generationTiming === undefined, '生成计时数量对不上 → 保持未知（不把 999 硬挂上去）')

    const legacy = {
      v: 1,
      logicalTurnId: 'm0',
      anchorId: 'm0',
      sourceIds: ['m1'],
      startedAt: 1,
      endedAt: 2,
      elapsedMs: 77,
      terminalReason: 'completed'
    }
    const legacyApplied = store.applyTurnTimings([user('m0', '任务'), asst('m1', '答')], [legacy])
    check(legacyApplied[1].turnTiming?.terminalReason === 'completed', '旧记录照常恢复完成态')
    check(legacyApplied[1].generationTiming === undefined, '旧记录缺生成计时保持未知，不拿墙钟冒充')
  }

  console.log('\n--- 9. 根因复现：修复前 groupIntoTurns 会刷新已结束段 ---')
  {
    let oldSrc = ''
    try {
      oldSrc = execFileSync('git', ['show', 'HEAD:src/shared/turns.ts'], { cwd: process.cwd(), encoding: 'utf8' })
    } catch {
      oldSrc = ''
    }
    const oldHasFlush =
      /isSubagentNotice\(m\.text\)\)\s*\{\s*\n\s*flush\(\)/.test(oldSrc)
    if (!oldSrc || oldHasFlush) {
      console.log('• HEAD 已含边界 flush（或取不到历史源码），跳过修复前复现')
    } else {
      const dir = join(process.cwd(), '.tmp', 'subagent-notice-timing')
      await mkdir(dir, { recursive: true })
      const patched = oldSrc
        .replaceAll("from './ipc'", "from '../../src/shared/ipc'")
        .replaceAll("from './subagent-notice'", "from '../../src/shared/subagent-notice'")
      await writeFile(join(dir, 'old-turns.ts'), patched, 'utf8')
      const oldOut = join(dir, 'old-turns.mjs')
      await build({
        stdin: {
          contents: `export { groupIntoTurns } from './.tmp/subagent-notice-timing/old-turns.ts'`,
          resolveDir: process.cwd(),
          loader: 'ts'
        },
        outfile: oldOut,
        bundle: true,
        platform: 'node',
        format: 'esm',
        logLevel: 'silent'
      })
      const oldMod = await import(pathToFileURL(oldOut).href)
      const oldTurns = oldMod.groupIntoTurns(core)
      const oldAssistants = oldTurns.filter((t) => t.kind === 'assistant')
      check(oldAssistants.length === 1, '修复前：通知前后被并成一个助手段（复现）', `实际 ${oldAssistants.length}`)
      check(oldAssistants[0].elapsedMs === 300, '修复前：已结束段被后续 run 刷成 300（复现用户报的现象）', String(oldAssistants[0].elapsedMs))
      check(oldAssistants[0].usage?.totalTokens === 25, '修复前：新旧用量被错误相加成 25（复现）', JSON.stringify(oldAssistants[0].usage))
    }
  }

  console.log('\n--- 10. 子代理完成通知按兄弟运行情况自适应合并 ---')
  {
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    let clock = null
    globalThis.setTimeout = (fn, ms) => clock.setTimeout(fn, ms)
    globalThis.clearTimeout = (timer) => clock.clearTimeout(timer)

    const settle = async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve()
    }
    const makeClock = () => {
      let now = 0
      let seq = 0
      const timers = []
      return {
        get now() { return now },
        timers,
        setTimeout(fn, ms) {
          const timer = { id: ++seq, fn, ms, at: now + ms, cleared: false, fired: false, unref() {} }
          timers.push(timer)
          return timer
        },
        clearTimeout(timer) { if (timer) timer.cleared = true },
        async advance(ms) {
          const target = now + ms
          for (;;) {
            const due = timers
              .filter((t) => !t.cleared && !t.fired && t.at <= target)
              .sort((a, b) => a.at - b.at || a.id - b.id)[0]
            if (!due) break
            due.fired = true
            now = due.at
            due.fn()
            await settle()
          }
          now = target
          await settle()
        },
        pending() { return timers.filter((t) => !t.cleared && !t.fired) }
      }
    }
    const finish = (id, parent, extra = {}) => ({
      id,
      task: `任务 ${id}`,
      cwd: '/tmp',
      isolation: 'controlled-cwd',
      model: 'gpt-x',
      status: 'done',
      startedAt: 0,
      endedAt: 1000,
      parentSessionId: parent,
      result: { summary: `摘要 ${id}` },
      review: 'none',
      transcript: [],
      ...extra
    })

    const scenario = (opts = {}) => {
      const clk = makeClock()
      clock = clk
      const sent = []
      const state = { siblings: opts.siblings ?? {} }
      const notify = createSubagentNotifier({
        enabled: opts.enabled ?? (() => true),
        now: () => clk.now,
        runningSiblings: opts.runningSiblings ?? ((run) => state.siblings[run.parentSessionId] ?? 0),
        find: opts.find ?? ((run) => ({
          send: async (text, images, mode) => { sent.push({ text, id: run.id, images, mode }); return { ok: true } }
        }))
      })
      return { notify, sent, state }
    }
    const deadlines = () => clock.pending().filter((t) => t.ms >= NOTICE_BATCH_MIN_WAIT_MS)

    try {
      {
        const { notify, sent } = scenario({ siblings: { 'sess-a': 0 } })
        const run = finish('sub-one', 'sess-a')
        notify(run)
        await settle()
        const armed = clock.pending()
        check(armed.length === 1 && armed[0].ms === NOTICE_COALESCE_WINDOW_MS, '无兄弟：入队后挂一个短窗口', JSON.stringify(armed.map((t) => t.ms)))
        check(sent.length === 0, '无兄弟：窗口未到时先不投（等合并）')
        await clock.advance(NOTICE_COALESCE_WINDOW_MS - 1)
        check(sent.length === 0, '无兄弟：差 1ms 仍不投')
        await clock.advance(1)
        check(sent.length === 1, '无兄弟：窗口结束只投一条', String(sent.length))
        check(sent[0].text === buildSubagentNotice(run), '无兄弟：文本保持现有格式（逐字一致）')
        check(sent[0].mode === 'followUp' && sent[0].images === undefined, '无兄弟：沿用 followUp 排队语义投递')
      }

      {
        const half = scenario({ siblings: { 'sess-half': 1 } })
        half.notify(finish('sub-half', 'sess-half', { startedAt: 0, endedAt: 600_000 }))
        await settle()
        check(deadlines().length === 1 && deadlines()[0].ms === 300_000, '有兄弟：等待 0.5 × 时长 = 5 分钟', JSON.stringify(clock.pending().map((t) => t.ms)))

        const low = scenario({ siblings: { 'sess-low': 1 } })
        low.notify(finish('sub-low', 'sess-low', { startedAt: 0, endedAt: 100_000 }))
        await settle()
        check(deadlines().length === 1 && deadlines()[0].ms === NOTICE_BATCH_MIN_WAIT_MS, '有兄弟：短任务抬到 1 分钟下限', JSON.stringify(clock.pending().map((t) => t.ms)))

        const high = scenario({ siblings: { 'sess-high': 1 } })
        high.notify(finish('sub-high', 'sess-high', { startedAt: 0, endedAt: 2_000_000 }))
        await settle()
        check(deadlines().length === 1 && deadlines()[0].ms === NOTICE_BATCH_MAX_WAIT_MS, '有兄弟：长任务压到 10 分钟上限', JSON.stringify(clock.pending().map((t) => t.ms)))
      }

      {
        const { notify, sent } = scenario({ siblings: { 'sess-join': 1 } })
        notify(finish('sub-j1', 'sess-join', { startedAt: 0, endedAt: 600_000 }))
        await settle()
        const deadline = deadlines()[0]
        check(deadline && deadline.at === 300_000, '等待批：截止 = 300000')
        await clock.advance(50_000)
        notify(finish('sub-j2', 'sess-join'))
        await settle()
        const after = deadlines()
        check(after.length === 1 && after[0] === deadline && after[0].at === 300_000, '等待期并入：截止不延后', JSON.stringify(after.map((t) => t.at)))
        check(sent.length === 0, '等待期并入：尚未投递')
        await clock.advance(250_000)
        check(sent.length === 1, '等待期并入：到截止只投一条', String(sent.length))
        check(sent[0].text.includes('sub-j1') && sent[0].text.includes('sub-j2'), '等待期并入：两条合并进同一条消息')
      }

      {
        const { notify, sent } = scenario({ siblings: { 'sess-err': 1 } })
        notify(finish('sub-e1', 'sess-err', { startedAt: 0, endedAt: 600_000 }))
        await settle()
        check(deadlines().some((t) => t.at === 300_000), '出错前：等待批截止 300000')
        await clock.advance(10_000)
        notify(finish('sub-e2', 'sess-err', { status: 'error', error: '模型报错' }))
        await settle()
        const armed = clock.pending().filter((t) => t.ms === NOTICE_COALESCE_WINDOW_MS)
        check(armed.length === 1 && armed[0].at === 10_000 + NOTICE_COALESCE_WINDOW_MS, '出错：改为短窗口', JSON.stringify(clock.pending().map((t) => t.at)))
        await clock.advance(20_000)
        check(sent.length === 1 && sent[0].text.includes('sub-e1') && sent[0].text.includes('sub-e2'), '出错：等待批被一起带出且合并为一条', String(sent.length))
        check(sent[0].text.includes('status="error"'), '出错：合并条目标记为 error')
      }

      {
        const { notify, sent } = scenario({ siblings: { 'sess-review': 1 } })
        const run = finish('sub-r1', 'sess-review', { isolation: 'worktree', startedAt: 0, endedAt: 600_000, review: 'pending', resultPath: '/tmp/wt', diff: { files: 3, additions: 5, deletions: 2 } })
        notify(run)
        await settle()
        check(deadlines().length === 0 && clock.pending().some((t) => t.ms === NOTICE_COALESCE_WINDOW_MS), '待审阅：有兄弟也只等短窗口', JSON.stringify(clock.pending().map((t) => t.ms)))
        await clock.advance(NOTICE_COALESCE_WINDOW_MS)
        check(sent.length === 1 && sent[0].text.includes('工作区：/tmp/wt'), '待审阅：立即投递并带工作区路径', String(sent.length))
      }

      {
        const { notify, sent } = scenario({ siblings: { 'sess-review-join': 1 } })
        notify(finish('sub-rj1', 'sess-review-join', { startedAt: 0, endedAt: 600_000 }))
        await settle()
        await clock.advance(10_000)
        notify(finish('sub-rj2', 'sess-review-join', { isolation: 'worktree', review: 'pending', diff: { files: 1, additions: 1, deletions: 0 } }))
        await settle()
        await clock.advance(NOTICE_COALESCE_WINDOW_MS)
        check(sent.length === 1 && sent[0].text.includes('sub-rj1') && sent[0].text.includes('sub-rj2'), '待审阅并入等待批：整批提前投递', String(sent.length))
      }

      {
        const { notify, sent, state } = scenario({ siblings: { 'sess-five': 1 } })
        notify(finish('sub-f1', 'sess-five', { startedAt: 0, endedAt: 600_000 }))
        await settle()
        await clock.advance(20_000)
        state.siblings['sess-five'] = 0
        notify(finish('sub-f2', 'sess-five'))
        await settle()
        const armed = clock.pending().filter((t) => t.ms === NOTICE_COALESCE_WINDOW_MS)
        check(armed.length === 1 && armed[0].at === 20_000 + NOTICE_COALESCE_WINDOW_MS, '兄弟清空：改为短窗口投递', JSON.stringify(clock.pending().map((t) => t.at)))
        await clock.advance(20_000)
        check(sent.length === 1 && sent[0].text.includes('sub-f1') && sent[0].text.includes('sub-f2'), '兄弟清空：两条合并投递，不等到 300000')
      }

      {
        const { notify, sent, state } = scenario({ siblings: { 'sess-cancel': 1 } })
        notify(finish('sub-c1', 'sess-cancel', { startedAt: 0, endedAt: 600_000 }))
        await settle()
        await clock.advance(20_000)
        state.siblings['sess-cancel'] = 0
        notify(finish('sub-c2', 'sess-cancel', { status: 'cancelled' }))
        await settle()
        const armed = clock.pending().filter((t) => t.ms === NOTICE_COALESCE_WINDOW_MS)
        check(armed.length === 1 && armed[0].at === 20_000 + NOTICE_COALESCE_WINDOW_MS, '取消兄弟：触发短窗口收尾')
        await clock.advance(20_000)
        check(sent.length === 1 && sent[0].text.includes('sub-c1'), '取消兄弟：只投等待批里已完成的那条')
        check(!sent[0].text.includes('sub-c2'), '取消兄弟：自身不通知')
      }

      {
        const { notify, sent, state } = scenario({ siblings: { 'sess-poll': 1 } })
        notify(finish('sub-p1', 'sess-poll', { startedAt: 0, endedAt: 600_000 }))
        await settle()
        await clock.advance(10_000)
        state.siblings['sess-poll'] = 0
        await clock.advance(NOTICE_SIBLINGS_POLL_MS - 10_000)
        const armed = clock.pending().filter((t) => t.ms === NOTICE_COALESCE_WINDOW_MS)
        check(armed.length === 1 && armed[0].at === NOTICE_SIBLINGS_POLL_MS + NOTICE_COALESCE_WINDOW_MS, '轮询兜底：轮询发现兄弟结束后改为短窗口投递', JSON.stringify(clock.pending().map((t) => t.at)))
        await clock.advance(20_000)
        check(sent.length === 1 && sent[0].text.includes('sub-p1'), '轮询兜底：到短窗口后投递')
      }

      {
        const { notify, sent } = scenario({ siblings: { 'sess-merge': 0 } })
        notify(finish('sub-a', 'sess-merge'))
        await settle()
        notify(finish('sub-b', 'sess-merge', { status: 'error', error: '模型报错' }))
        await settle()
        notify(finish('sub-c', 'sess-merge'))
        await settle()
        check(clock.pending().length === 1, '多条：窗口内只保留首条挂的那个定时器', String(clock.pending().length))
        await clock.advance(NOTICE_COALESCE_WINDOW_MS)
        check(sent.length === 1, '多条：三条合并成一次投递，不逐条唤醒父会话', String(sent.length))
        check(
          ['sub-a', 'sub-b', 'sub-c'].every((id) => sent[0].text.includes(`id="${id}`) || sent[0].text.includes(`yan subagent get --id ${id}`)),
          '多条：合并文本逐个列出每个运行的原有内容'
        )
        check(sent[0].text.includes('任务 sub-a') && sent[0].text.includes('任务 sub-c'), '多条：每个任务的标题都在同一条消息里')
        check(isSubagentNotice(sent[0].text), '多条：合并文本仍按通知识别（不显示为用户消息）')
        check(parseSubagentNotice(sent[0].text) !== null, '多条：合并文本仍可解析出标题行')

        notify(finish('sub-d', 'sess-merge'))
        await settle()
        check(clock.pending().length === 1, '多条：窗口关闭后新到的通知另起一批')
        await clock.advance(NOTICE_COALESCE_WINDOW_MS)
        check(sent.length === 2 && sent[1].text.includes('sub-d') && !sent[1].text.includes('sub-a'), '多条：新批次独立投递，不重复上一批')
      }

      {
        const clk = makeClock()
        clock = clk
        const sent = []
        const siblings = { 'sess-A': 1, 'sess-B': 1 }
        const targets = {
          A: { send: async (text) => { sent.push({ to: 'A', text }); return { ok: true } } },
          B: { send: async (text) => { sent.push({ to: 'B', text }); return { ok: true } } }
        }
        const notify = createSubagentNotifier({
          enabled: () => true,
          now: () => clk.now,
          runningSiblings: (run) => siblings[run.parentSessionId] ?? 0,
          find: (run) => (run.parentSessionId === 'sess-A' ? targets.A : run.parentSessionId === 'sess-B' ? targets.B : null)
        })
        notify(finish('sub-A1', 'sess-A'))
        notify(finish('sub-B1', 'sess-B'))
        await settle()
        check(deadlines().length === 2, '跨父会话：两个父会话各挂一个等待批', String(clock.pending().length))
        await clock.advance(NOTICE_BATCH_MIN_WAIT_MS)
        check(sent.length === 2, '跨父会话：各投各的一条', String(sent.length))
        const toA = sent.find((s) => s.to === 'A')
        const toB = sent.find((s) => s.to === 'B')
        check(toA?.text.includes('sub-A1') && !toA?.text.includes('sub-B1'), '跨父会话：A 的消息不含 B 的运行')
        check(toB?.text.includes('sub-B1') && !toB?.text.includes('sub-A1'), '跨父会话：B 的消息不含 A 的运行')
      }

      {
        const clk = makeClock()
        clock = clk
        const sent = []
        const parentId = '01a14877-0000-7000-8000-000000000001'
        const nearId = '01a1487c-d140-7000-8000-000000000002'
        const runnerPool = new Map()
        const load = (runId, sessionId, generation) => {
          runnerPool.set(runId, {
            generation,
            agent: {
              sessionId,
              send: async (text, images, mode) => { sent.push({ to: sessionId, runId, text, mode }); return { ok: true } }
            }
          })
        }
        const registry = {
          agentForSession: (sessionId) => [...runnerPool.values()].find((r) => r.agent.sessionId === sessionId)?.agent ?? null,
          agentOf: (runId) => runnerPool.get(runId)?.agent ?? null,
          runtimeOf: (runId) => {
            const r = runnerPool.get(runId)
            return r ? { sessionId: r.agent.sessionId ?? `pending:${runId}`, runId, generation: r.generation } : null
          }
        }
        const notify = createSubagentNotifier({
          enabled: () => true,
          now: () => clk.now,
          runningSiblings: () => 0,
          find: (run) => findNoticeTarget(run, registry)
        })

        load('r1', parentId, 1)
        load('r2', '01a00000-other', 1)
        const fromParent = finish('sub-news-1', parentId, { parentRunId: 'r1', parentGeneration: 1 })
        load('r1', nearId, 2)
        check(findNoticeTarget(fromParent, registry) === null, '路由：父 runner 被复用到相近 id 会话后，不按 runner 兜底投给它')
        notify(fromParent)
        await settle()
        await clock.advance(NOTICE_COALESCE_WINDOW_MS)
        check(sent.length === 0, '路由：父会话未加载时不投给当前会话', JSON.stringify(sent.map((s) => s.to)))

        load('r2', parentId, 2)
        notify.retry()
        await settle()
        check(sent.length === 1 && sent[0].to === parentId && sent[0].runId === 'r2', '路由：父会话重新加载后补投到父会话', JSON.stringify(sent.map((s) => s.to)))
        check(sent[0].text.includes('sub-news-1') && sent[0].mode === 'followUp', '路由：补投沿用原通知与 followUp 语义')
        notify.retry()
        await settle()
        check(sent.length === 1, '路由：补投只发一次')

        sent.length = 0
        load('r1', nearId, 3)
        load('r2', parentId, 2)
        notify(finish('sub-news-2', parentId, { parentRunId: 'r1', parentGeneration: 1 }))
        await settle()
        await clock.advance(NOTICE_COALESCE_WINDOW_MS)
        check(sent.length === 1 && sent[0].to === parentId && sent[0].runId === 'r2', '路由：父会话不是当前会话、换到别的 runner 时仍精确投给父会话', JSON.stringify(sent.map((s) => `${s.runId}:${s.to}`)))

        check(findNoticeTarget({ parentSessionId: '01a1487', parentRunId: 'r1', parentGeneration: 3 }, registry) === null, '路由：会话 id 前缀不当作匹配')
        load('r3', undefined, 5)
        check(findNoticeTarget({ parentSessionId: 'pending:r3', parentRunId: 'r3', parentGeneration: 5 }, registry) === runnerPool.get('r3').agent, '路由：未落盘父会话按 runner 与代次精确匹配')
        check(findNoticeTarget({ parentSessionId: 'pending:r3', parentRunId: 'r3', parentGeneration: 4 }, registry) === null, '路由：runner 代次变了就不投')
        check(findNoticeTarget({ parentSessionId: 'pending:r3', parentRunId: 'r3' }, registry) === null, '路由：缺代次不按 runner 兜底')
        check(findNoticeTarget({ parentSessionId: 'pending:r1', parentRunId: 'r3', parentGeneration: 5 }, registry) === null, '路由：pending 会话与父 runner 不一致不投')
      }

      {
        const { notify, sent } = scenario({ enabled: () => false })
        notify(finish('sub-off', 'sess-off'))
        await settle()
        check(clock.pending().length === 0, '关闭开关：不入队，不挂窗口定时器')
        await clock.advance(NOTICE_BATCH_MIN_WAIT_MS)
        check(sent.length === 0, '关闭开关：不投递')
      }

      console.log('\n--- 11. 未投递上限、放弃投递日志与退出 flush ---')
      const warns = []
      const realWarn = console.warn
      console.warn = (...parts) => { warns.push(parts.join(' ')) }
      try {
        {
          const clk = makeClock()
          clock = clk
          const sent = []
          let target = null
          const notify = createSubagentNotifier({
            enabled: () => true,
            now: () => clk.now,
            runningSiblings: () => 0,
            find: () => target
          })
          const total = NOTICE_MAX_UNDELIVERED_RUNS + 5
          for (let i = 0; i < total; i++) {
            notify(finish(`sub-cap-${String(i).padStart(2, '0')}`, 'sess-cap', { endedAt: 1000 + i }))
            await settle()
            await clock.advance(NOTICE_COALESCE_WINDOW_MS)
          }
          check(warns.some((w) => w.includes('上限')), '未投递上限：超过上限时写日志', JSON.stringify(warns))

          target = { send: async (text) => { sent.push(text); return { ok: true } } }
          notify.retry()
          await settle()
          check(sent.length === 1, '未投递上限：父会话恢复后补投一次', String(sent.length))
          const text = sent[0] ?? ''
          const oldest = '任务 sub-cap-00'
          const newest = `任务 sub-cap-${String(total - 1).padStart(2, '0')}`
          const boundary = `任务 sub-cap-${String(total - NOTICE_MAX_UNDELIVERED_RUNS).padStart(2, '0')}`
          check(!text.includes(oldest), '未投递上限：最旧的被丢弃，不再投出')
          check(text.includes(boundary) && text.includes(newest), '未投递上限：保留最新的上限数量（含边界与最后一条）')
        }

        {
          const clk = makeClock()
          clock = clk
          const sent = []
          let ok = false
          const notify = createSubagentNotifier({
            enabled: () => true,
            now: () => clk.now,
            runningSiblings: () => 0,
            find: () => ({ send: async (text) => { sent.push(text); return { ok } } })
          })
          notify(finish('sub-give-up', 'sess-give-up'))
          await settle()
          await clock.advance(NOTICE_COALESCE_WINDOW_MS)
          for (let i = 0; i < 3; i++) {
            notify.retry()
            await settle()
          }
          check(!warns.some((w) => w.includes('放弃')), '放弃投递：未到 5 次前不写放弃日志', JSON.stringify(warns))
          check(sent.length === 4, '放弃投递：前 4 次都真的尝试投递', String(sent.length))
          notify.retry()
          await settle()
          check(sent.length === 5, '放弃投递：第 5 次仍尝试', String(sent.length))
          const gaveUp = warns.filter((w) => w.includes('放弃'))
          check(gaveUp.length === 1 && gaveUp[0].includes('sub-give-up') && gaveUp[0].includes('5 次'), '放弃投递：连续 5 次失败时写日志而不是静默丢弃', JSON.stringify(gaveUp))
          ok = true
          notify.retry()
          await settle()
          check(sent.length === 5, '放弃投递：放弃后不再补投', String(sent.length))
        }

      } finally {
        console.warn = realWarn
      }
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }
  }

  console.log('\n--- 12. 会话标题取通知首行 ---')
  {
    const sessionsSource = readFileSync('src/main/sessions.ts', 'utf8')
    const sessionsFile = ts.createSourceFile('sessions.ts', sessionsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const userText = sessionsFile.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'userMessageText')
    check(userText, '找得到 sessions.ts 的 userMessageText')
    const context = vm.createContext({ parseSubagentNotice })
    vm.runInContext(ts.transpileModule(userText.getText(sessionsFile), {}).outputText, context)
    check(
      context.userMessageText({ role: 'user', content: '<subagent-notification id="long-fixture-id" status="done">\n子任务已完成：检查通过\n正文\n</subagent-notification>' }) === '子任务已完成：检查通过',
      '通知消息作会话标题文本时只取首行摘要'
    )
  }

  console.log(`\n子代理通知计时定向检查：${checks} 项通过（现场编译 / 临时目录，不代替真实模型验收）`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
