/**
 * 子代理结果通知作为「助手运行段计时分界」的定向测试。
 *
 * 背景（用户报的 bug）：派出的子代理返回时，此前**已经结束**的助手回复段
 * 运行时间被刷新。根因在 `groupIntoTurns()`：宿主子代理结果通知是 `user` 角色，
 * 分支里 `continue` 直接跳过、**没有封住正在累积的助手段**。于是通知之后的
 * 新 run 的 assistant 消息被并进同一段，`cur.last` / `cur.usage` 被新值替换，
 * 已结束段的 elapsedMs 与用量被覆盖。
 *
 * 这里钉住修复后的不变式（纯函数投影，不启动 Electron / pi / 模型）：
 *   · 通知是后续助手运行的计时分界，但**不画成用户轮**，也不进导航 / 队列；
 *   · 已结束段冻结：id / elapsedMs / usage 不被后续段替换；
 *   · 后续段独立计时，用量是真实新请求，不复制旧段；
 *   · 会话累计仍按真实请求累计，不重复也不丢失；
 *   · JSONL 计时恢复按**各自真实用户 / 通知边界**锚定，不串段、不覆写。
 *
 * 现场 esbuild 编译 + 临时数据目录，用 `node scripts/test-subagent-notice-timing.mjs` 单跑。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'yan-subagent-notice-'))
const dataDir = join(temp, 'data')
/* tracker 导入时就把 YAN_DIR 定死，必须在求值前设好。 */
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
  const outfile = join(process.cwd(), 'out', 'test', 'subagent-notice-timing.mjs')
  await build({
    stdin: {
      contents: `
        export { groupIntoTurns, createTurnProjector, waitSpansMs, toolWaitSpans } from './src/shared/turns'
        export { createOutlineProjector } from './src/shared/outline-turns'
        export { projectSessionMetrics } from './src/shared/session-metrics'
        export { buildSubagentNotice, isSubagentNotice } from './src/shared/subagent-notice'
        export * as store from './src/main/turn-timing-store'
        export { TurnTimingTracker } from './src/main/turn-timing-tracker'
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
    store,
    TurnTimingTracker
  } = mod

  const notice = (id, status = 'done', task = '检查登录流程') =>
    buildSubagentNotice({ id, task, status, isolation: 'controlled-cwd', model: 'gpt-x', result: { summary: '完成' } })
  const noticeMsg = (id, status) => ({ id, role: 'user', text: notice(id, status), timestamp: 1 })

  /* ------------------------------------------------ 1. 核心：段冻结 + 独立计时 */
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

    /* projector 与 groupIntoTurns 必须同口径 */
    const projected = createTurnProjector()(core)
    check(
      projected.length === 3 &&
        projected[1].elapsedMs === 1200 &&
        projected[2].elapsedMs === 300,
      'createTurnProjector 走同一边界（1200 / 300），不合并'
    )
    check(projected.every((t) => t.kind !== 'user' || t.msg.text !== core[2].text), 'projector 输出不含通知用户轮')
  }

  /* ------------------------------------------------ 2. 多次 / 背靠背 / 重复状态通知 */
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

  /* ------------------------------------------------ 3. 通知结尾 / 真正用户下一轮 */
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

  /* ------------------------------------------------ 4. 工具等待不跨段重复计 */
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

  /* ------------------------------------------------ 5. 会话累计 / 导航 / 用户轮 */
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

    /* 通知不应出现在任何用户面向投影里 */
    const projectorTurns = createTurnProjector()(core)
    check(
      !projectorTurns.some((t) => t.kind === 'user' && isSubagentNotice(t.msg.text)),
      '分组投影里没有通知用户轮（导航 / 队列同源）'
    )
  }

  /* ------------------------------------------------ 6. JSONL 计时恢复按真实边界锚定 */
  console.log('\n--- 6. 历史计时日志按用户 / 通知边界恢复，不串段不覆写 ---')
  {
    const g1 = { durationMs: 1200, ttftMs: 200, decodeMs: 1000 }
    const g2 = { durationMs: 300, ttftMs: 50, decodeMs: 250 }
    /* 重载后 id 由 normalize 顺序生成：用户 m0、助手 m1、通知 m2、助手 m3。 */
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

  /* ------------------------------------------------ 7. tracker 真实锚定路径 */
  console.log('\n--- 7. TurnTimingTracker 为通知后的 run 单独锚定 ---')
  {
    const tracker = new TurnTimingTracker()
    tracker.elapsedMs = 1200
    tracker.runId = 'run-1'
    tracker.terminal = 'completed'
    tracker.messageIds = ['m1']
    await tracker.persist(true, 'tracker-notice.jsonl', [user('m0', '把登录改好'), asst('m1', '已改好。')])

    /* 新 run（子代理通知触发的后续运行）：agent_start 重置了 messageIds / runId。 */
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

  /* ------------------------------------------------ 8. 老记录无法确认时保持未知不串 */
  console.log('\n--- 8. 老记录 / 数据不完整时保持未知，不猜不串 ---')
  {
    /* 锚找不到 → 回退 sourceIds；生成计时数量对不上 → 整段未知。 */
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

    /* 旧记录没有 final → 不误报中断；没有 generationTimings → 保持未知。 */
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

  /* ------------------------------------------------ 9. 根因复现（修复前源码） */
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
      const oldOut = join(process.cwd(), 'out', 'test', 'subagent-notice-old.mjs')
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

  console.log(`\n子代理通知计时定向检查：${checks} 项通过（现场编译 / 临时目录，不代替真实模型验收）`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
