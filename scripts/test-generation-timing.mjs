/**
 * 每次模型请求计时（generationTiming）与历史恢复的定向测试。
 *
 * 被测三块：
 *   · `src/shared/turn-timing.ts` 的 `generationTiming()` / `decodeTokensPerSecond()`：
 *     从单调时刻算「请求时长 / TTFT / 解码时长」，没有首 token 时不编 TTFT；
 *   · `src/main/agent.ts`：假事件驱动 `handleEvent`，验证 message_start/update/end/flush
 *     真的把计时挂到对应 assistant 消息上（流式逐帧 + 收尾权威值）；
 *   · `src/main/turn-timing-store.ts` + `turn-timing-tracker.ts`：落盘、按次序恢复、
 *     同 run 快照后者胜、多 run 合并不重复、压缩重排不串消息。
 *
 * 为什么必须单测：这些数字在界面上「看着正常」时也可能已经错了 ——
 * 挂错回合、跨请求累加、拿墙钟冒充模型时间都不会报错。所以这里用受控的
 * 单调时刻与临时目录把它钉死。
 *
 * 现场编译 + 临时目录，不启动 Electron / pi / 模型。用法：
 *   node scripts/test-generation-timing.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'yan-generation-timing-'))
const dataDir = join(temp, 'data')
/* 必须在 bundle 求值前设好：`paths.ts` 在导入时就把 YAN_DIR 定死。 */
process.env.YAN_DATA_DIR = dataDir
process.env.YAN_PI_DIR = join(temp, 'pi')

let checks = 0
const check = (condition, message, extra) => {
  assert.ok(condition, extra === undefined ? message : `${message}（${extra}）`)
  checks += 1
  console.log(`✓ ${message}`)
}
const near = (a, b, eps = 1) => Math.abs(a - b) <= eps
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  /*
   * 编译产物放 `out/test/`（项目内，已被 Git 忽略）：bundle 里的 external
   * （如 `@modelcontextprotocol/sdk`）要能从项目 node_modules 解析；临时目录
   * 里加载会找不到包。测试数据仍在临时目录。
   */
  const outfile = join(process.cwd(), 'out', 'test', 'generation-timing.mjs')
  await build({
    stdin: {
      contents: `
        export { generationTiming, decodeTokensPerSecond } from './src/shared/turn-timing'
        export { toolWaitSpans, waitSpansMs } from './src/shared/turns'
        export * as store from './src/main/turn-timing-store'
        export { TurnTimingTracker } from './src/main/turn-timing-tracker'
        export { AgentController } from './src/main/agent'
        export { buildSubagentNotice, isSubagentNotice } from './src/shared/subagent-notice'
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    plugins: [
      {
        name: 'generation-timing-electron-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'gt-electron' }))
          builder.onLoad({ filter: /.*/, namespace: 'gt-electron' }, () => ({
            contents: `
              export class BrowserWindow { constructor() { throw new Error('Native browser requires an Electron integration test') } }
              export const session = { fromPartition() { throw new Error('Native session requires an Electron integration test') } }
            `,
            loader: 'js'
          }))
        }
      }
    ],
    logLevel: 'silent'
  })

  const mod = await import(pathToFileURL(outfile).href)
  const { generationTiming, decodeTokensPerSecond, store, TurnTimingTracker, AgentController, toolWaitSpans, waitSpansMs, buildSubagentNotice, isSubagentNotice } = mod
  const noticeText = buildSubagentNotice({
    id: 'sub-1',
    task: '检查登录流程',
    status: 'done',
    isolation: 'controlled-cwd',
    model: 'gpt-x',
    result: { summary: '完成' }
  })

  /* ------------------------------------------------------------------ 纯算术 */
  console.log('\n--- 1. 一次请求的计时口径（纯函数）---')
  {
    const g = generationTiming({ startedMono: 1000, endedMono: 3000, firstContentMono: 1500 })
    check(g && g.durationMs === 2000, '请求时长 = message_start → message_end 的单调差', JSON.stringify(g))
    check(g.ttftMs === 500, 'TTFT = message_start → 首个真正内容的差', String(g.ttftMs))
    check(g.decodeMs === 1500, 'decodeMs = 首个真正内容 → message_end 的差', String(g.decodeMs))
    check(near(g.ttftMs + g.decodeMs, g.durationMs, 1), 'TTFT + decode ≈ 请求时长（同一段墙钟不重叠）')

    const noFirst = generationTiming({ startedMono: 1000, endedMono: 3000 })
    check(noFirst.durationMs === 2000, '没有首个内容时仍给请求时长')
    check(noFirst.ttftMs === undefined && noFirst.decodeMs === undefined, '没有首个内容就不编 TTFT / decodeMs')

    check(generationTiming({ startedMono: Number.NaN, endedMono: 3000 }) === undefined, '起点 NaN → 不产出记录')
    check(generationTiming({ startedMono: 0, endedMono: Number.POSITIVE_INFINITY }) === undefined, '终点 Infinity → 不产出记录')
    const marked = generationTiming({ startedMono: 1000, endedMono: 3000, firstContentMono: 1500, startEvent: 'turn_start' })
    check(marked.startEvent === 'turn_start', '传入原生起点语义时原样带出 startEvent 标记')
    check(g.startEvent === undefined, '未传 startEvent 时不猜、不带标记（caller 必须明确）')
    const badFirst = generationTiming({ startedMono: 1000, endedMono: 3000, firstContentMono: Number.NaN })
    check(badFirst.ttftMs === undefined && badFirst.decodeMs === undefined, '首 token 非有限值 → 当作没有首 token')

    const reversed = generationTiming({ startedMono: 5000, endedMono: 4000, firstContentMono: 4500 })
    check(
      reversed.durationMs === 1 && reversed.ttftMs === 1 && reversed.decodeMs === 1,
      '时间倒挂钳到 ≥ 1ms，不出现 0 / 负数'
    )

    check(near(decodeTokensPerSecond(100, 2000), 50), 'TPS 用真实 usage 输出 ÷ 解码时长（100tok/2s=50）')
    check(decodeTokensPerSecond(undefined, 2000) === undefined, '没有真实用量输出 → 不给 TPS')
    check(decodeTokensPerSecond(0, 2000) === undefined, '输出为 0 → 不给 TPS')
    check(decodeTokensPerSecond(100, undefined) === undefined, '没有解码时长（无首 token）→ 不给 TPS')
    check(decodeTokensPerSecond(100, 0) === undefined, '解码时长为 0 → 不给 TPS')
  }

  /* --------------------------------------------------------- 落盘 / 次序恢复 */
  console.log('\n--- 2. 生成计时落盘与按次序恢复（store）---')
  const base = {
    v: 1,
    logicalTurnId: 'm0',
    startedAt: 1000,
    endedAt: 5000,
    elapsedMs: 4000,
    terminalReason: 'completed',
    anchorId: 'm0',
    sourceIds: ['m1', 'm2', 'm3']
  }
  const g1 = { durationMs: 100, ttftMs: 20, decodeMs: 80 }
  const g2 = { durationMs: 200, ttftMs: 50, decodeMs: 150 }
  const g3 = { durationMs: 300, ttftMs: 90, decodeMs: 210 }
  const asst = (id, timing) => ({ id, role: 'assistant', text: id, ...(timing ? { generationTiming: timing } : {}) })
  const user = (id) => ({ id, role: 'user', text: id })

  {
    check(await store.appendTurnTiming(dataDir, 'sess-a', { ...base, generationTimings: [g1, g2, g3] }), '带生成计时的记录写入成功')
    const [rec] = await store.readTurnTimings(dataDir, 'sess-a')
    check(rec?.generationTimings?.length === 3, '生成计时原样读回（长度）', String(rec?.generationTimings?.length))
    check(JSON.stringify(rec.generationTimings[1]) === JSON.stringify(g2), '次序保留（第二条 = 第二个请求）', JSON.stringify(rec.generationTimings[1]))

    /* 重载：消息 id 是重读历史重新生成的，顺序不变 */
    const messages = [user('m0'), asst('m1'), asst('m2'), asst('m3'), user('m4'), asst('m5')]
    const applied = store.applyTurnTimings(messages, [rec])
    check(JSON.stringify(applied[1].generationTiming) === JSON.stringify(g1), '重载后第一条请求拿回自己的计时')
    check(JSON.stringify(applied[2].generationTiming) === JSON.stringify(g2), '重载后第二条请求拿回自己的计时')
    check(JSON.stringify(applied[3].generationTiming) === JSON.stringify(g3), '重载后第三条请求拿回自己的计时')
    check(applied[5].generationTiming === undefined, '下一回合的请求不被污染')
    check(applied[0].generationTiming === undefined && applied[4].generationTiming === undefined, '用户消息不挂生成计时')
    check(applied[3].turnTiming?.elapsedMs === 4000, '整轮用时仍挂在最后一条助手消息上')
  }

  /* 次序锚定：id 漂移（压缩 / 重排）也按助手次序挂，不按 id 查表 */
  {
    const record = { ...base, generationTimings: [g1, g2] }
    const shifted = [user('m0'), asst('m7'), asst('m8')]
    const applied = store.applyTurnTimings(shifted, [record])
    check(
      JSON.stringify(applied[1].generationTiming) === JSON.stringify(g1) &&
        JSON.stringify(applied[2].generationTiming) === JSON.stringify(g2),
      '消息 id 漂移后仍按「本轮助手出现次序」挂（不拿 live id 索引）',
      `${JSON.stringify(applied[1].generationTiming)} / ${JSON.stringify(applied[2].generationTiming)}`
    )
  }

  /* 数量对不上 → 整轮未知，不硬 zip 串到别的请求 */
  {
    const record = { ...base, generationTimings: [g1, g2, g3] }
    const onlyOne = [user('m0'), asst('m1'), user('m9')]
    const applied = store.applyTurnTimings(onlyOne, [record])
    check(applied[1].generationTiming === undefined, '助手数量对不上时不挂生成计时（保持未知，不串消息）')
    check(applied[1].turnTiming?.elapsedMs === 4000, '数量对不上不影响整轮用时的恢复')
  }

  /* 空位保持次序：某次请求没有计时（中途被打断）也不能让后面的前移 */
  {
    const record = { ...base, generationTimings: [null, g2] }
    const applied = store.applyTurnTimings([user('m0'), asst('m1'), asst('m2')], [record])
    check(applied[1].generationTiming === undefined, '空位（无计时的请求）保持未知')
    check(JSON.stringify(applied[2].generationTiming) === JSON.stringify(g2), '空位之后的请求仍拿回自己的计时（没有错位）')
  }

  /* 两个回合各自按键：不串回合 */
  {
    const recA = { ...base, logicalTurnId: 'm0', sourceIds: ['m1'], generationTimings: [g1] }
    const recB = {
      ...base,
      logicalTurnId: 'm4',
      anchorId: 'm4',
      sourceIds: ['m5'],
      generationTimings: [g3],
      startedAt: 6000,
      endedAt: 9000,
      elapsedMs: 3000
    }
    const messages = [user('m0'), asst('m1'), user('m4'), asst('m5')]
    const applied = store.applyTurnTimings(messages, [recA, recB])
    check(
      JSON.stringify(applied[1].generationTiming) === JSON.stringify(g1) &&
        JSON.stringify(applied[3].generationTiming) === JSON.stringify(g3),
      '两个回合各挂各的生成计时，互不串线'
    )
  }

  /* 旧记录没有生成计时 → 保持未知，不伪造 */
  {
    const legacy = {
      v: 1,
      logicalTurnId: 'm0',
      startedAt: 1000,
      endedAt: 2000,
      elapsedMs: 1000,
      terminalReason: 'completed',
      anchorId: 'm0',
      sourceIds: ['m1']
    }
    const applied = store.applyTurnTimings([user('m0'), asst('m1')], [legacy])
    check(applied[1].generationTiming === undefined, '旧记录缺生成计时 → 保持未知（不拿整轮墙钟冒充模型时间）')
    check(applied[1].turnTiming?.elapsedMs === 1000, '旧记录的整轮用时照常恢复')
  }

  /* 坏条目 / 非有限值：保持数组长度，坏位置留空 */
  {
    const raw = {
      ...base,
      logicalTurnId: 'g-bad',
      anchorId: 'm0',
      sourceIds: ['m1', 'm2', 'm3', 'm4', 'm5'],
      generationTimings: [
        g1,
        null,
        { durationMs: -5 },
        { durationMs: 'x' },
        { durationMs: 50, ttftMs: Number.POSITIVE_INFINITY }
      ]
    }
    await writeFile(join(dataDir, 'turn-timing', 'bad-gen.jsonl'), `${JSON.stringify(raw)}\n`, 'utf8')
    const [rec] = await store.readTurnTimings(dataDir, 'bad-gen')
    check(rec?.generationTimings?.length === 5, '坏条目仍保持数组长度（次序不错位）', String(rec?.generationTimings?.length))
    check(rec.generationTimings[1] === null && rec.generationTimings[2] === null && rec.generationTimings[3] === null, 'null / 负数 / 字符串被丢弃为空位')
    check(rec.generationTimings[4].durationMs === 50, '同一格里合法的 durationMs 保留')
    check(rec.generationTimings[4].ttftMs === undefined, '非有限的 ttftMs 被丢掉（不是 0，也不是编造值）')
    const applied = store.applyTurnTimings(
      [user('m0'), asst('m1'), asst('m2'), asst('m3'), asst('m4'), asst('m5')],
      [rec]
    )
    check(
      applied[1].generationTiming && applied[5].generationTiming && applied[2].generationTiming === undefined,
      '坏行恢复后合法位置仍按次序挂上'
    )
  }

  /* --------------------------------------------- 工具起止从 waitSpans 恢复 */
  console.log('\n--- 3. 历史工具 start/end 从 waitSpans 恢复 ---')
  {
    const tool = (id, name, timing) => ({ id, name, args: {}, status: 'ok', ...(timing ?? {}) })
    const asstWithTools = (id, calls) => ({ id, role: 'assistant', text: id, toolCalls: calls })

    /* 并行两把工具：区间重叠，并集 = 1000→5000 = 4000（不是 2000+3000=5000） */
    const parallel = {
      ...base,
      logicalTurnId: 'm0',
      anchorId: 'm0',
      sourceIds: ['m1'],
      waitSpans: [
        { id: 't1', name: 'bash', startedAt: 1000, endedAt: 3000 },
        { id: 't2', name: 'bash', startedAt: 2000, endedAt: 5000 }
      ]
    }
    const reloaded = store.applyTurnTimings(
      [user('m0'), asstWithTools('m1', [tool('t1', 'bash'), tool('t2', 'bash')])],
      [parallel]
    )
    check(
      reloaded[1].toolCalls[0].startedAt === 1000 && reloaded[1].toolCalls[0].endedAt === 3000,
      '重载后第一把工具拿回真实起止',
      JSON.stringify(reloaded[1].toolCalls[0])
    )
    check(
      reloaded[1].toolCalls[1].startedAt === 2000 && reloaded[1].toolCalls[1].endedAt === 5000,
      '重载后第二把并行工具也拿回起止（按 id + name 命中）'
    )
    check(
      waitSpansMs(toolWaitSpans(reloaded[1].toolCalls)) === 4000,
      '并行工具区间取并集，值正确（不把重叠段重复相加）',
      String(waitSpansMs(toolWaitSpans(reloaded[1].toolCalls)))
    )

    /* 已有实时计时的字段优先，不被历史值覆盖 */
    const liveFull = store.applyTurnTimings(
      [user('m0'), asstWithTools('m1', [tool('t1', 'bash', { startedAt: 10, endedAt: 20 })])],
      [parallel]
    )
    check(
      liveFull[1].toolCalls[0].startedAt === 10 && liveFull[1].toolCalls[0].endedAt === 20,
      '已有真实 live 起止的工具不被历史记录覆盖',
      JSON.stringify(liveFull[1].toolCalls[0])
    )
    const livePartial = store.applyTurnTimings(
      [user('m0'), asstWithTools('m1', [tool('t1', 'bash', { startedAt: 10 })])],
      [parallel]
    )
    check(
      livePartial[1].toolCalls[0].startedAt === 10 && livePartial[1].toolCalls[0].endedAt === 3000,
      '只有 live 起点时只补缺失的终点，起点保持原值',
      JSON.stringify(livePartial[1].toolCalls[0])
    )

    /* 同 id 不同回合：各归各的，不串 */
    const recA = { ...parallel, logicalTurnId: 'm0', anchorId: 'm0', sourceIds: ['m1'] }
    const recB = {
      ...parallel,
      logicalTurnId: 'm2',
      anchorId: 'm2',
      sourceIds: ['m3'],
      waitSpans: [{ id: 't1', name: 'bash', startedAt: 7000, endedAt: 8000 }]
    }
    const twoTurns = store.applyTurnTimings(
      [user('m0'), asstWithTools('m1', [tool('t1', 'bash')]), user('m2'), asstWithTools('m3', [tool('t1', 'bash')])],
      [recA, recB]
    )
    check(
      twoTurns[1].toolCalls[0].startedAt === 1000 && twoTurns[3].toolCalls[0].startedAt === 7000,
      '不同回合的同一工具 id 各挂各的，不互相污染',
      `${twoTurns[1].toolCalls[0].startedAt} / ${twoTurns[3].toolCalls[0].startedAt}`
    )

    /* 锚丢失：整轮用时仍可按 sourceIds 回退，但工具起止不补（宁缺勿串） */
    const lostAnchor = {
      ...parallel,
      anchorId: 'm-ghost',
      sourceIds: ['m1'],
      waitSpans: [{ id: 't1', name: 'bash', startedAt: 1000, endedAt: 3000 }]
    }
    const ghosted = store.applyTurnTimings(
      [user('m0'), asstWithTools('m1', [tool('t1', 'bash')])],
      [lostAnchor]
    )
    check(ghosted[1].turnTiming?.elapsedMs === 4000, '锚丢失时整轮用时仍按 sourceIds 回退恢复')
    check(
      ghosted[1].toolCalls[0].startedAt === undefined && ghosted[1].toolCalls[0].endedAt === undefined,
      '锚丢失的回退路径不补工具起止（保持未知，不串到别回合）'
    )

    /* 锚定成功但 id + name 都对不上：保持未知 */
    const mismatched = store.applyTurnTimings(
      [user('m0'), asstWithTools('m1', [tool('t1', 'read')])],
      [parallel]
    )
    check(
      mismatched[1].toolCalls[0].startedAt === undefined && mismatched[1].toolCalls[0].endedAt === undefined,
      '锚定成功但工具 name 对不上 → 保持未知（id + name 才算同一条）'
    )

    /* 非法值：非有限 / 时间倒挂一律丢弃（不写进消息） */
    const invalid = store.applyTurnTimings(
      [user('m0'), asstWithTools('m1', [tool('t1', 'bash'), tool('t2', 'bash')])],
      [
        {
          ...parallel,
          waitSpans: [
            { id: 't1', name: 'bash', startedAt: Number.NaN, endedAt: 3000 },
            { id: 't2', name: 'bash', startedAt: 5000, endedAt: 4000 }
          ]
        }
      ]
    )
    check(
      invalid[1].toolCalls[0].startedAt === undefined && invalid[1].toolCalls[1].startedAt === undefined,
      '非有限 / 时间倒挂的等待分段被丢弃，不写进工具行'
    )
  }

  /* --------------------------------------------------------- 快照 / 多 run 合并 */
  console.log('\n--- 4. 同 run 快照后者胜、多 run 合并不重复 ---')
  {
    await store.appendTurnTiming(dataDir, 'sess-runs', {
      ...base,
      runId: 'run-1',
      logicalTurnId: 'm0',
      sourceIds: ['m1'],
      generationTimings: [g1],
      final: false
    })
    await store.appendTurnTiming(dataDir, 'sess-runs', {
      ...base,
      runId: 'run-1',
      logicalTurnId: 'm0',
      sourceIds: ['m1', 'm2'],
      elapsedMs: 4200,
      endedAt: 5200,
      generationTimings: [g1, g2],
      final: true
    })
    const sameRun = await store.readTurnTimings(dataDir, 'sess-runs')
    check(sameRun.length === 1, '同一 run 的中途 + 收尾快照只出一个回合', String(sameRun.length))
    check(sameRun[0].generationTimings?.length === 2, '同一 run 取收尾快照（不是两次相加）', String(sameRun[0].generationTimings?.length))
    check(JSON.stringify(sameRun[0].generationTimings) === JSON.stringify([g1, g2]), '同一 run 后者胜，计时不重复')

    await store.appendTurnTiming(dataDir, 'sess-runs', {
      ...base,
      runId: 'run-2',
      logicalTurnId: 'm0',
      sourceIds: ['m3'],
      startedAt: 9000,
      endedAt: 11000,
      elapsedMs: 2000,
      generationTimings: [g3],
      final: true
    })
    const merged = await store.readTurnTimings(dataDir, 'sess-runs')
    check(merged.length === 1, '自动继续（第二个 run）归同一个逻辑回合', String(merged.length))
    check(
      JSON.stringify(merged[0].generationTimings) === JSON.stringify([g1, g2, g3]),
      '跨 run 的生成计时按时间顺序拼接，不重复也不丢失',
      JSON.stringify(merged[0].generationTimings)
    )
    check(merged[0].elapsedMs === 6200, '跨 run 的整轮用时仍相加（旧语义不变）', String(merged[0].elapsedMs))
    const applied = store.applyTurnTimings(
      [user('m0'), asst('m1'), asst('m2'), asst('m3')],
      merged
    )
    check(
      JSON.stringify(applied.slice(1).map((m) => m.generationTiming)) === JSON.stringify([g1, g2, g3]),
      '多 run 恢复后每条请求对号入座'
    )
  }

  /* ------------------------------------------------------- tracker 落盘 */
  console.log('\n--- 5. TurnTimingTracker 把生成计时写进回合计时日志 ---')
  {
    const tracker = new TurnTimingTracker()
    tracker.elapsedMs = 2000
    tracker.runId = 'run-1'
    tracker.terminal = 'completed'
    tracker.messageIds = ['m1', 'm2']
    const messages = [user('m0'), asst('m1', g1), asst('m2', g2)]
    await tracker.persist(true, 'tracker.jsonl', messages)
    const [rec] = await store.readTurnTimings(dataDir, 'tracker')
    check(rec?.generationTimings?.length === 2, 'tracker 落盘带上两条请求的生成计时', String(rec?.generationTimings?.length))
    check(JSON.stringify(rec.generationTimings[0]) === JSON.stringify(g1), 'tracker 落盘的生成计时与消息一致', JSON.stringify(rec.generationTimings[0]))
    check(rec.anchorId === 'm0', '锚定用户消息（恢复时按它的回合找回次序）')

    /* 中途快照 + 收尾快照：同一 run 后者胜 */
    const tracker2 = new TurnTimingTracker()
    tracker2.elapsedMs = 1000
    tracker2.runId = 'run-1'
    tracker2.messageIds = ['m1']
    await tracker2.persist(false, 'tracker-dup.jsonl', [user('m0'), asst('m1', g1)])
    tracker2.messageIds = ['m1', 'm2']
    tracker2.elapsedMs = 2500
    await tracker2.persist(true, 'tracker-dup.jsonl', [user('m0'), asst('m1', g1), asst('m2', g2)])
    const [dup] = await store.readTurnTimings(dataDir, 'tracker-dup')
    check(dup?.generationTimings?.length === 2, '中途 + 收尾快照合并成一条，不重复', String(dup?.generationTimings?.length))
    check(dup.elapsedMs === 2500, '收尾快照的用时覆盖中途值', String(dup.elapsedMs))

    /* 会话日志真的落在临时目录里（没有写到真实用户数据） */
    const raw = await readFile(join(dataDir, 'turn-timing', 'tracker.jsonl'), 'utf8')
    check(raw.includes('"generationTimings"'), '生成计时确实写进了 turn-timing 日志')
  }

  /* ------------------------------------------------ AgentController 假事件 */
  console.log('\n--- 6. 假事件驱动 streaming：start / update / end / flush ---')
  {
    const pushes = []
    const ctl = new AgentController({ push: (m) => pushes.push(m), cwd: process.cwd() })
    const emit = (e) => ctl.handleEvent(e)
    const updates = () => pushes.filter((m) => m.ch === 'msg-update')
    const lastUpdate = () => updates().at(-1)

    /* 一次正常请求：原生 turn_start 先到（请求准备起点），再来空 delta、真正内容 */
    emit({ type: 'turn_start' })
    emit({ type: 'message_start', message: { role: 'assistant' } })
    const addPush = pushes.find((m) => m.ch === 'msg-add')
    const idA = addPush.payload.id
    check(!!addPush, 'message_start 推了 msg-add')

    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' }, usage: { output: 10 } })
    await wait(40)
    const afterEmpty = lastUpdate()
    check(
      afterEmpty?.payload.patch.generationTiming?.durationMs >= 1,
      '空 delta 不产生首 token，但仍给出真实的 durationMs'
    )
    check(
      afterEmpty.payload.patch.generationTiming.ttftMs === undefined &&
        afterEmpty.payload.patch.generationTiming.decodeMs === undefined,
      '没有真正内容时 flush 不编 TTFT / decodeMs'
    )

    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' }, usage: { output: 30 } })
    await wait(40)
    const afterContent = lastUpdate()
    check(
      afterContent.payload.id === idA && afterContent.payload.patch.generationTiming.ttftMs >= 1,
      '首个真正内容到达后 flush 给出 TTFT',
      JSON.stringify(afterContent.payload.patch.generationTiming)
    )
    check(
      afterContent.payload.patch.generationTiming.startEvent === 'turn_start',
      '拿到原生 turn_start 时 GT 带 startEvent 标记（duration 也是请求起点口径）'
    )
    check(
      afterContent.payload.patch.generationTiming.decodeMs >= 1,
      'flush 同时给出解码时长（首 token → 当前）'
    )

    emit({
      type: 'message_end',
      message: { role: 'assistant', text: '你好', usage: { output: 40 }, stopReason: 'stop', timestamp: 1 }
    })
    const endPatch = lastUpdate().payload.patch
    check(lastUpdate().payload.id === idA, '收尾补丁仍然指向同一条请求消息')
    const genA = endPatch.generationTiming
    check(
      genA && genA.durationMs >= 1 && genA.ttftMs >= 1 && genA.decodeMs >= 1,
      'message_end 的 generationTiming 三个字段齐全',
      JSON.stringify(genA)
    )
    check(near(genA.ttftMs + genA.decodeMs, genA.durationMs, 2), '收尾时 TTFT + decode ≈ 请求时长')

    /* toolcall_start 也算首个真正内容 */
    emit({ type: 'turn_start' })
    emit({ type: 'message_start', message: { role: 'assistant' } })
    const idB = pushes.filter((m) => m.ch === 'msg-add').at(-1).payload.id
    emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', id: 't1', toolName: 'bash' } })
    await wait(30)
    check(lastUpdate().payload.patch.generationTiming.ttftMs >= 1, 'toolcall_start 被当成首个真正内容（TTFT 有值）')
    emit({
      type: 'message_end',
      message: { role: 'assistant', usage: { output: 5 }, stopReason: 'stop', timestamp: 2 }
    })
    check(lastUpdate().payload.id === idB && lastUpdate().payload.patch.generationTiming.ttftMs >= 1, '工具调用请求收尾也有完整计时')

    /* 没有任何内容的请求：只给时长 */
    emit({ type: 'turn_start' })
    emit({ type: 'message_start', message: { role: 'assistant' } })
    const idC = pushes.filter((m) => m.ch === 'msg-add').at(-1).payload.id
    emit({ type: 'message_end', message: { role: 'assistant', usage: { output: 0 }, stopReason: 'stop', timestamp: 3 } })
    const genC = lastUpdate().payload.patch.generationTiming
    check(lastUpdate().payload.id === idC, '第三次请求的收尾补丁归属正确')
    check(
      genC && genC.durationMs >= 1 && genC.ttftMs === undefined && genC.decodeMs === undefined,
      '没有首个内容的请求只给 durationMs（无首 token 不编 TTFT / decode）',
      JSON.stringify(genC)
    )

    /* 没拿到原生 turn_start（事件缺失 / 回退）：duration 只当下限，不保存伪 TTFT */
    emit({ type: 'message_start', message: { role: 'assistant' } })
    const idD = pushes.filter((m) => m.ch === 'msg-add').at(-1).payload.id
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '回退' }, usage: { output: 7 } })
    await wait(30)
    emit({ type: 'message_end', message: { role: 'assistant', usage: { output: 7 }, stopReason: 'stop', timestamp: 4 } })
    const genD = lastUpdate().payload.patch.generationTiming
    check(lastUpdate().payload.id === idD, '回退请求的收尾补丁归属正确')
    check(genD && genD.startEvent === undefined, '回退起点不带 turn_start 标记')
    check(genD.durationMs >= 1, '回退仍给真实的 duration 下限')
    check(genD.ttftMs === undefined, '回退不保存伪 TTFT（不含请求准备 / 网络等待）')
    check(genD.decodeMs >= 1, '回退仍给真实的 decodeMs（首内容 → 结束）')

    /* 多个 assistant 请求：各自一条，id 不串 */
    const finalIds = updates()
      .filter((m) => m.payload.patch.text !== undefined)
      .map((m) => m.payload.id)
    check(new Set([idA, idB, idC, idD]).size === 4, '四个 assistant 请求拿到四个不同的消息 id')
    check(finalIds.every((id) => [idA, idB, idC, idD].includes(id)), '收尾补丁没有挂到别的不存在的消息上')
  }

  /* ------------------------------------------------ 原生 turn_start 覆盖请求准备等待 */
  console.log('\n--- 7. 原生 turn_start 作请求准备起点：duration/ttft 含等待，decode 不含 ---')
  {
    const pushes = []
    const ctl = new AgentController({ push: (m) => pushes.push(m), cwd: process.cwd() })
    const emit = (e) => ctl.handleEvent(e)
    const lastUpdate = () => pushes.filter((m) => m.ch === 'msg-update').at(-1)

    /* 模拟请求已发出、header 500ms 后才回来：turn_start 早于 assistant message_start */
    emit({ type: 'turn_start' })
    await wait(500)
    emit({ type: 'message_start', message: { role: 'assistant' } })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '内容' }, usage: { output: 5 } })
    emit({ type: 'message_end', message: { role: 'assistant', usage: { output: 5 }, stopReason: 'stop', timestamp: 1 } })
    const g = lastUpdate().payload.patch.generationTiming
    check(g.startEvent === 'turn_start', 'GT 带原生起点标记', JSON.stringify(g))
    check(g.durationMs >= 450, 'duration 包含请求准备 / header 等待（>=450ms）', String(g.durationMs))
    check(g.ttftMs >= 450, 'TTFT 也从请求准备起点算（含等待）', String(g.ttftMs))
    check(g.decodeMs < 450, 'decode 只从首内容到结束，不含等待', String(g.decodeMs))

    /* 下一次请求缺原生 turn_start → 回退，不拿流下限当请求首包延迟 */
    emit({ type: 'message_start', message: { role: 'assistant' } })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' }, usage: { output: 5 } })
    emit({ type: 'message_end', message: { role: 'assistant', usage: { output: 5 }, stopReason: 'stop', timestamp: 2 } })
    const fb = lastUpdate().payload.patch.generationTiming
    check(fb.startEvent === undefined && fb.ttftMs === undefined, '缺原生 turn_start 的回退不保存伪 TTFT', JSON.stringify(fb))
    check(fb.decodeMs >= 1, '回退仍有 decodeMs')
  }

  /* ------------------------------------------------ 同一 native run 内通知分段 + 恢复 */
  console.log('\n--- 8. 同一 native run 内消费官方通知：旧段冻结 final / 新段独立 / 恢复配对 ---')
  {
    const byIdOf = (list) => new Map(list.map((m) => [m.id, m]))

    /*
     * 驱动与 vendor 同序的事件流：agent_start → 每个请求前 turn_start →
     * assistant message_start/end。oldCount 条旧助手之后，官方通知作为 followUp
     * 以 user 角色到达（同一 run，不新开 agent_start），随后一个新助手。
     */
    const runScenario = async (sessionName, oldCount) => {
      const ctl = new AgentController({ push: () => {}, cwd: process.cwd() })
      ctl.state = { sessionFile: join(temp, sessionName) }
      const emit = (e) => ctl.handleEvent(e)
      emit({ type: 'agent_start' })
      const run1 = ctl.turn.runId
      emit({ type: 'turn_start' })
      emit({ type: 'message_start', message: { role: 'user', content: '原始问题' } })
      for (let i = 0; i < oldCount; i += 1) {
        if (i > 0) emit({ type: 'turn_start' })
        emit({ type: 'message_start', message: { role: 'assistant' } })
        emit({ type: 'message_end', message: { role: 'assistant', usage: { output: 5 + i }, stopReason: 'stop', timestamp: 1 } })
      }
      /* 通知触发的新请求：turn_start 先到（pending 不能被通知分段清掉） */
      emit({ type: 'turn_start' })
      emit({ type: 'message_start', message: { role: 'user', content: noticeText } })
      const pendingKept = ctl.pendingRequestMono !== undefined
      emit({ type: 'message_start', message: { role: 'assistant' } })
      emit({ type: 'message_end', message: { role: 'assistant', usage: { output: 9 }, stopReason: 'stop', timestamp: 2 } })
      await ctl.persistTurnTiming()
      const records = await store.readTurnTimings(dataDir, sessionName.replace(/\.jsonl$/, ''))
      return { ctl, run1, pendingKept, records }
    }

    for (const oldCount of [2, 1]) {
      const { ctl, run1, pendingKept, records } = await runScenario(`native-notice-${oldCount}.jsonl`, oldCount)
      check(isSubagentNotice(noticeText), '构造的官方通知能被 isSubagentNotice 识别')
      check(records.length === 2, `旧段 ${oldCount} 条助手：旧 / 新两条逻辑回合`, String(records.length))
      const oldRec = records.find((r) => r.anchorId === 'm0')
      const newRec = records.find((r) => r.anchorId !== 'm0')
      check(!!oldRec && !!newRec, '旧段锚在通知前最后一条真实 user（m0），新段锚在通知')
      check(oldRec.final === true && oldRec.terminalReason === 'completed', '旧段以 final=true / completed 冻结，不遗留误 interrupted')
      check(newRec.final === true && newRec.terminalReason === 'completed', '新段也正常收尾')
      check(oldRec.runId === run1 && newRec.runId !== run1, '新段换独立 runId（不同 run 用时相加而非后者胜）')
      check(
        oldRec.sourceIds.length === oldCount && oldRec.generationTimings?.length === oldCount,
        `旧段真实恢复 ${oldCount}/${oldCount} 条 gt`,
        JSON.stringify(oldRec.sourceIds)
      )
      check(oldRec.generationTimings.every((gt) => gt && gt.startEvent === 'turn_start'), '旧段每条 gt 都带原生起点标记')
      check(newRec.sourceIds.length === 1 && newRec.generationTimings?.length === 1, '新段恢复 1/1 条 gt')
      check(pendingKept, '通知分段后 pendingRequestMono 未被清掉（新请求 GT 起点不丢）')

      const stripped = ctl.messages.map((m) => ({ ...m, generationTiming: undefined, turnTiming: undefined }))
      const applied = byIdOf(store.applyTurnTimings(stripped, records))
      const assistants = ctl.messages.filter((m) => m.role === 'assistant')
      const oldAssistants = assistants.slice(0, oldCount)
      const newAssistant = assistants[oldCount]
      const oldLast = oldAssistants[oldAssistants.length - 1]
      check(
        applied.get(newAssistant.id).turnTiming?.elapsedMs === newRec.elapsedMs,
        '新段 elapsed 独立，等于新段记录值',
        String(newRec.elapsedMs)
      )
      check(
        applied.get(oldLast.id).turnTiming?.elapsedMs === oldRec.elapsedMs &&
          applied.get(oldLast.id).turnTiming?.terminalReason === 'completed',
        '旧段 elapsed 冻结在旧段记录值且为 completed（不含新段）',
        String(oldRec.elapsedMs)
      )
      check(
        oldAssistants.every((m, i) => applied.get(m.id).generationTiming?.durationMs === oldRec.generationTimings[i].durationMs),
        '旧段每条助手按次序恢复自己的 gt'
      )
      check(
        applied.get(newAssistant.id).generationTiming?.durationMs === newRec.generationTimings[0].durationMs,
        '新段助手恢复自己的 gt'
      )
      const noticeId = ctl.messages.find((m) => isSubagentNotice(m.text)).id
      check(applied.get(noticeId)?.turnTiming === undefined, '通知消息本身不挂计时')
      check(applied.get(noticeId) !== undefined, `重载历史里通知 id ${noticeId} 存在`)
    }

    /* 普通用户插话不改变分段 */
    const ctl3 = new AgentController({ push: () => {}, cwd: process.cwd() })
    ctl3.state = { sessionFile: join(temp, 'native-ordinary.jsonl') }
    const emit3 = (e) => ctl3.handleEvent(e)
    emit3({ type: 'agent_start' })
    const runA = ctl3.turn.runId
    emit3({ type: 'turn_start' })
    emit3({ type: 'message_start', message: { role: 'assistant' } })
    emit3({ type: 'message_end', message: { role: 'assistant', usage: { output: 1 }, stopReason: 'stop', timestamp: 1 } })
    emit3({ type: 'message_start', message: { role: 'user', content: '普通插话，不是通知' } })
    check(ctl3.turn.runId === runA, '普通用户 steer 不切段（runId 不变）')
    check(ctl3.turn.messageIds.length === 1, '普通用户 steer 不重置段内归属')
  }

  /* ------------------------------------------------ 旧段写入不反置新段 persisted */
  console.log('\n--- 9. 旧段异步写入不反置新段 persisted（新段中途快照不被吞） ---')
  {
    const t = new TurnTimingTracker()
    t.runId = 'run-1'
    t.messageIds = ['m1']
    t.elapsedMs = 100
    const p1 = t.persist(true, 'race.jsonl', [user('m0'), asst('m1', g1)])
    /* 段边界：旧段写入还在飞行中，先同步换到 run-2 */
    t.messageIds = []
    t.elapsedMs = undefined
    t.persisted = false
    t.runId = 'run-2'
    await p1
    check(t.persisted === false, '旧段写入完成后不把新段 persisted 反置为 true')
    t.messageIds = ['m2']
    t.elapsedMs = 50
    await t.persist(false, 'race.jsonl', [user('m0'), asst('m1', g1), asst('m2', g2)])
    const raw = await readFile(join(dataDir, 'turn-timing', 'race.jsonl'), 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    check(lines.length === 2 && lines[1].runId === 'run-2', '新段第一条中途快照照常写入（旧段写入没吞它）', String(lines.length))
  }

  console.log(`\n生成计时定向检查：${checks} 项通过（现场编译 / 假事件 / 临时目录，不代替真实模型验收）`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
