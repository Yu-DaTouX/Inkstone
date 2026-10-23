#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

const report = { pass: 0, fail: 0 }

function group(name) {
  process.stdout.write(`\n▌${name}\n`)
}

function ok(cond, label, detail) {
  const pass = !!cond
  if (pass) report.pass += 1
  else report.fail += 1
  const extra = pass ? '' : `  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}`
  process.stdout.write(`${pass ? '  ✓' : '  ✗'} ${label}${extra}\n`)
  return pass
}

const entry = `
export { WORKBENCH_TABS, WORKBENCH_ACTIVE_TABS } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/types'))}'
export { autoCompactDistance, autoCompactLimitOf, contextUsageSummary, contextPaneData, contextPaneToolCalls, largestToolCalls, shortTokens, turnAnchorIds } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/context-pane-view'))}'
export { compactionHistory, compactionReclaim, loadCompactionHistory } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/context-compactions'))}'
export { contextBreakdown, contextFromOf, inContextMessages } from '${posix(resolve(ROOT, 'src/renderer/src/state/context-breakdown'))}'
export { restorableWorkbenchTab } from '${posix(resolve(ROOT, 'src/renderer/src/state/ui-v3'))}'
`

async function load() {
  const result = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'v3-workbench-context-entry.ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

async function main() {
  const mod = await load()
  const {
    WORKBENCH_TABS,
    WORKBENCH_ACTIVE_TABS,
    autoCompactLimitOf,
    contextUsageSummary,
    contextFromOf,
    inContextMessages,
    contextBreakdown,
    contextPaneData,
    contextPaneToolCalls,
    largestToolCalls,
    turnAnchorIds,
    autoCompactDistance,
    compactionHistory,
    compactionReclaim,
    loadCompactionHistory,
    shortTokens,
    restorableWorkbenchTab
  } = mod

  group('页签注册：上下文进入固定页签与恢复白名单（W0）')
  {
    ok(WORKBENCH_TABS.includes('context'), '上下文在固定页签里', WORKBENCH_TABS)
    ok(WORKBENCH_TABS.slice(-3).join('>') === 'branch>logs>quota', '分支页之后依次是日志、额度（日志 / 额度页签追加在末尾）', WORKBENCH_TABS)
    ok(!WORKBENCH_ACTIVE_TABS.has('context'), '上下文是只读页签，不需要会话激活')
    ok(restorableWorkbenchTab('context') === 'context', '只读的上下文页签原样恢复')
    ok(restorableWorkbenchTab('terminal') === 'overview', '终端降级到概览，不隐式起 PTY')
    ok(restorableWorkbenchTab('browser') === 'overview', '浏览器降级到概览，不隐式导航')
  }

  group('上下文用量：只认同模型对齐后的 agent 总量')
  {
    const model = { provider: 'anthropic', id: 'claude-x', contextWindow: 200_000 }
    const good = contextUsageSummary(
      { model, lastCompaction: null },
      { contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25, modelKey: 'anthropic/claude-x' } }
    )
    ok(good.known && good.tokens === 50_000 && good.windowSize === 200_000, '模型对齐且总量可用时 known=true', good)
    ok(good.percent === 25 && good.tone === 'ok', '正常占用 tone=ok')

    const stale = contextUsageSummary(
      { model, lastCompaction: null },
      { contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25, modelKey: 'anthropic/claude-old' } }
    )
    ok(stale.known === false && stale.percent === null, '旧模型快照不可信：known=false', stale)

    const afterCompact = contextUsageSummary(
      { model, lastCompaction: null },
      { contextUsage: { tokens: null, contextWindow: 200_000, percent: null, modelKey: 'anthropic/claude-x' } }
    )
    ok(afterCompact.known === false, '压缩后还没回报时 known=false')
    ok(afterCompact.afterCompactUnknown === true, '压缩后待测单独标记，界面不写 0')

    const fallbackWindow = contextUsageSummary(
      { model, lastCompaction: null },
      { contextUsage: { tokens: 10_000, contextWindow: 0, percent: null, modelKey: 'anthropic/claude-x' } }
    )
    ok(fallbackWindow.windowSize === 200_000 && fallbackWindow.known, '窗口缺失时退回模型窗口')

    const none = contextUsageSummary({ model, lastCompaction: null }, null)
    ok(none.known === false && none.windowSize === 200_000, '没有统计时不编百分比，但窗口仍可取模型值')

    const warn = contextUsageSummary(
      { model: { ...model, contextWindow: 100_000 }, lastCompaction: null },
      { contextUsage: { tokens: 85_000, contextWindow: 100_000, percent: 85, modelKey: 'anthropic/claude-x' } }
    )
    ok(warn.tone === 'ask', '≥80% 记 ask')
    const err = contextUsageSummary(
      { model: { ...model, contextWindow: 100_000 }, lastCompaction: null },
      { contextUsage: { tokens: 96_000, contextWindow: 100_000, percent: 96, modelKey: 'anthropic/claude-x' } }
    )
    ok(err.tone === 'fail', '≥95% 记 fail')

    ok(contextFromOf({ lastCompaction: { status: 'completed', startedAt: 123, firstKeptEntryId: 'k' } })?.compactedAt === 123, '已完成压缩给出上下文起点')
    ok(contextFromOf({ lastCompaction: { status: 'running', startedAt: 123 } }) === undefined, '进行中的压缩不作为起点')
    ok(contextFromOf({ lastCompaction: null }) === undefined, '没有压缩记录就不切')
    ok(contextFromOf({ contextFrom: { firstKeptEntryId: 'f' }, lastCompaction: { status: 'completed', startedAt: 1 } })?.firstKeptEntryId === 'f', '会话状态里的起点（含重开会话从文件读到的）优先')
    const assumed = contextUsageSummary(
      { model: { ...model, contextWindow: 128_000, contextWindowAssumed: true }, lastCompaction: null },
      { contextUsage: { tokens: 10_000, contextWindow: 128_000, percent: 7.8, modelKey: 'anthropic/claude-x' } }
    )
    ok(assumed.windowAssumed === true, '模型窗口没配置（pi 默认 128k）时标记为假定')
    ok(good.windowAssumed === false, '已知窗口不标假定')

    ok(shortTokens(900) === '900' && shortTokens(1600) === '1.6k' && shortTokens(2_000_000) === '2M', 'token 短写法按量级收敛')
  }

  group('上下文用量：自动压缩上限小于模型窗口时按上限计算')
  {
    const model = { provider: 'anthropic', id: 'claude-x', contextWindow: 1_000_000 }
    const stats = { contextUsage: { tokens: 72_200, contextWindow: 1_000_000, percent: 7.2, modelKey: 'anthropic/claude-x' } }
    const session = { model, lastCompaction: null }
    const capped = contextUsageSummary(session, stats, 400_000)
    ok(capped.windowSize === 400_000 && capped.modelWindow === 1_000_000 && capped.cappedByLimit, '上限 400k、窗口 1M → 分母 400k，并保留模型窗口', capped)
    ok(Math.round(capped.percent) === 18, '72.2k / 400k 约 18%', capped.percent)
    const nearly = contextUsageSummary(session, { contextUsage: { ...stats.contextUsage, tokens: 330_000 } }, 400_000)
    ok(nearly.tone === 'ask', '警告色按上限算：330k / 400k 为 ask', nearly.tone)
    const off = contextUsageSummary(session, stats)
    ok(off.windowSize === 1_000_000 && !off.cappedByLimit, '自动压缩关闭（无上限）按模型窗口')
    const above = contextUsageSummary({ model: { ...model, contextWindow: 200_000 }, lastCompaction: null }, { contextUsage: { tokens: 10_000, contextWindow: 200_000, modelKey: 'anthropic/claude-x' } }, 400_000)
    ok(above.windowSize === 200_000 && !above.cappedByLimit, '上限不小于窗口时仍按模型窗口')
    const data = contextPaneData({ session, stats, messages: [], autoCompactLimit: 400_000 })
    ok(data.usage.windowSize === 400_000, 'contextPaneData 透传上限')
    ok(autoCompactLimitOf({ autoCompactionEnabled: true }, { autoCompactTokens: 300_000 }) === 300_000, '自动压缩开启取设置值')
    ok(autoCompactLimitOf({ autoCompactionEnabled: true }, {}) === 400_000, '未设置时取缺省 400k')
    ok(autoCompactLimitOf({ autoCompactionEnabled: false }, { autoCompactTokens: 300_000 }) === undefined, '自动压缩关闭无上限')
  }

  group('离自动压缩还有多远')
  {
    const model = { provider: 'anthropic', id: 'claude-x', contextWindow: 500_000 }
    const stats = { contextUsage: { tokens: 74_800, contextWindow: 500_000, modelKey: 'anthropic/claude-x' } }
    const capped = contextUsageSummary({ model, lastCompaction: null }, stats, 400_000)
    const near = autoCompactDistance(capped, true)
    ok(near.kind === 'limit' && near.remaining === 325_200, '上限 400k、已用 74.8k → 再用 325.2k 触发', near)
    ok(shortTokens(near.remaining) === '325.2k', '剩余量按短写法显示')
    const full = contextUsageSummary({ model, lastCompaction: null }, { contextUsage: { ...stats.contextUsage, tokens: 410_000 } }, 400_000)
    ok(autoCompactDistance(full, true).kind === 'reached', '超过上限记为已到上限')
    const off = autoCompactDistance(contextUsageSummary({ model, lastCompaction: null }, stats), false)
    ok(off.kind === 'off' && off.remaining === 425_200, '自动压缩关闭时按模型窗口算剩余', off)
    const open = autoCompactDistance(contextUsageSummary({ model, lastCompaction: null }, stats, 600_000), true)
    ok(open.kind === 'window', '上限不小于窗口时由模型窗口决定', open)
    ok(autoCompactDistance(contextUsageSummary({ model, lastCompaction: null }, null, 400_000), true) === null, '没有可信总量时不写剩余')
    ok(autoCompactDistance(capped, undefined) === null, '不知道开关状态时不写剩余')
  }

  group('占用最多的工具结果')
  {
    const big = 'x'.repeat(4000)
    const msgs = [
      { id: 'u1', role: 'user', text: 'go' },
      { id: 'a1', role: 'assistant', text: '', toolCalls: [
        { id: 'r1', name: 'read', args: { path: 'src/deep/ContextPane.tsx' }, output: big, status: 'ok' },
        { id: 'g1', name: 'grep', args: { pattern: 'foo' }, output: 'hit', status: 'ok' }
      ] },
      { id: 'a2', role: 'assistant', text: '', toolCalls: [
        { id: 'c1', name: 'codemode', args: { code: '\n  const a = await read("x")\nreturn a' }, output: 'y'.repeat(800), status: 'ok' },
        { id: 'c1/1', parentToolCallId: 'c1', name: 'read', args: { path: 'huge.txt' }, output: 'z'.repeat(40_000), status: 'ok' }
      ] },
      { id: 'b1', role: 'bash', text: 'out'.repeat(100), bash: { command: 'npm test\n--watch' } },
      { id: 'a3', role: 'assistant', text: 'done', toolCalls: [
        { id: 'w1', name: 'web_fetch', args: { url: 'https://example.com' }, output: 'w'.repeat(2000), images: [{ mimeType: 'image/png', data: 'x' }], status: 'ok' }
      ] }
    ]
    const anchors = turnAnchorIds(msgs)
    ok(anchors.get('a2') === 'a1' && anchors.get('a1') === 'a1', '同一轮的助手消息都锚到这一轮的首条（TurnView 的 data-turn-id）', [...anchors])
    ok(anchors.get('a3') === 'a3' && anchors.get('b1') === 'b1', '用户 / bash 消息切开新的一轮')
    const top = largestToolCalls(msgs, msgs)
    ok(top.map((r) => r.id).join() === 'w1,r1,c1,b1,g1', '按估算 token 从大到小排列', top.map((r) => `${r.id}:${r.tokens}`))
    ok(!top.some((r) => r.id === 'c1/1'), 'codemode 子调用不单列（模型只收到父调用的结果）')
    ok(top.find((r) => r.id === 'c1').target === 'const a = await read("x")', '脚本取首个非空行作目标', top.find((r) => r.id === 'c1'))
    ok(top.find((r) => r.id === 'r1').target === 'ContextPane.tsx' && top.find((r) => r.id === 'r1').anchorId === 'a1', '文件工具显示文件名并锚到所属轮次')
    ok(top.find((r) => r.id === 'b1').target === 'npm test' && top.find((r) => r.id === 'b1').anchorId === 'b1', '用户 bash 取命令首行，锚到自身')
    ok(top.find((r) => r.id === 'w1').tokens === 500 + 1200 + Math.ceil(JSON.stringify({ url: 'https://example.com' }).length / 4), '图片按 1200 计入，口径与构成一致', top.find((r) => r.id === 'w1'))
    ok(largestToolCalls(msgs, msgs, 2).length === 2, '条数有上限')
    const sliced = largestToolCalls(msgs, msgs.slice(2))
    ok(!sliced.some((r) => r.id === 'r1') && sliced.find((r) => r.id === 'c1')?.anchorId === 'a1', '只取上下文内的消息，锚点仍按完整会话计算', sliced)
    const tools = contextBreakdown(msgs, 1_000_000).find((s) => s.id === 'tools').tokens
    const listed = largestToolCalls(msgs, msgs, 99).reduce((n, r) => n + r.tokens, 0)
    ok(tools === listed, '构成里的工具一栏与列表合计口径相同（子调用不重复计）', [tools, listed])
    const model = { provider: 'anthropic', id: 'claude-x', contextWindow: 200_000 }
    const stats = { contextUsage: { tokens: 20_000, contextWindow: 200_000, modelKey: 'anthropic/claude-x' } }
    ok(contextPaneToolCalls({ session: { model, lastCompaction: null }, stats, messages: msgs }).length === 5, '面板数据给出列表')
    ok(contextPaneToolCalls({ session: { model, lastCompaction: null }, stats: null, messages: msgs }).length === 0, '没有可信总量时不列')
    const live = contextPaneToolCalls({ session: { model, lastCompaction: null, isStreaming: true }, stats, messages: msgs })
    ok(!live.some((r) => r.id === 'w1'), '输出中的末尾助手消息不计入（与构成同一范围）')
  }

  group('压缩记录：从会话条目读出')
  {
    const entries = [
      { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'hi' } },
      { type: 'compaction', id: 'k1', parentId: 'm1', timestamp: '2026-10-20T10:00:00.000Z', summary: 's'.repeat(400), firstKeptEntryId: 'm1', tokensBefore: 300_000 },
      { type: 'message', id: 'm2', parentId: 'k1', message: { role: 'assistant', stopReason: 'error', usage: { input: 9, cacheRead: 0, cacheWrite: 0 } } },
      { type: 'message', id: 'm3', parentId: 'm2', message: { role: 'assistant', usage: { input: 1000, cacheRead: 39_000, cacheWrite: 0, output: 50 } } },
      { type: 'compaction', id: 'k2', parentId: 'm3', timestamp: '2026-10-21T10:00:00.000Z', summary: 'short', tokensBefore: 380_000 },
      { type: 'compaction', id: 'kx', parentId: 'm1', timestamp: '2026-10-22T10:00:00.000Z', summary: 'other branch', tokensBefore: 1 },
      { type: 'message', id: 'm4', parentId: 'k2', message: { role: 'user', content: 'next' } }
    ]
    const items = compactionHistory(entries, 'm4')
    ok(items.map((i) => i.id).join() === 'k2,k1', '只取当前分支上的压缩，最新在上', items)
    ok(items[1].tokensBefore === 300_000 && items[1].tokensAfter === 40_000, '压缩后取下一条正常助手回复的输入量（跳过报错回复）', items[1])
    ok(items[0].tokensAfter === undefined && items[0].tokensBefore === 380_000, '还没有后续回复时只有压缩前', items[0])
    ok(items[1].at === Date.parse('2026-10-20T10:00:00.000Z') && items[1].summaryTokens === 100, '时间与摘要大小', items[1])
    ok(compactionReclaim(items[1]) === 87 && compactionReclaim(items[0]) === null, '回收比例')
    ok(compactionHistory(entries, 'missing').length === 3, '叶子缺失时退回全部压缩条目')
    ok(compactionHistory([], null).length === 0 && compactionHistory([null, 3, 'x'], null).length === 0, '空或异常条目不报错')
    const asked = []
    const loaded = await loadCompactionHistory(async (req) => { asked.push(req); return { ok: true, entries, leafId: 'm4' } }, 'sid')
    ok(loaded.ok && loaded.items.length === 2 && asked[0].action === 'entries' && asked[0].expectedSessionId === 'sid', '读取带上会话归属', asked)
    const failed = await loadCompactionHistory(async () => { throw new Error('boom') }, 'sid')
    ok(!failed.ok && failed.error === 'boom', '读取失败返回错误供界面回退')
  }

  group('上下文页签数据：构成、压缩过滤')
  {
    const model = { provider: 'anthropic', id: 'claude-x', contextWindow: 10_000 }
    const session = { model, lastCompaction: null }
    const stats = { contextUsage: { tokens: 1000, contextWindow: 10_000, percent: 10, modelKey: 'anthropic/claude-x' } }
    const messages = [
      {
        id: 'u1',
        role: 'user',
        text: 'hello world',
        images: [{ mimeType: 'image/png', data: 'x' }],
        timestamp: 200
      },
      {
        id: 'a1',
        role: 'assistant',
        text: 'hi',
        timestamp: 210,
        toolCalls: [{ id: 't1', name: 'read', args: { path: 'a' }, argsRaw: '{"path":"a"}', output: 'contents', status: 'ok' }]
      }
    ]

    const data = contextPaneData({ session, stats, messages })
    ok(data.usage.known, '有可信总量时渲染构成')
    ok(data.slices.length === 5, '构成分五类（系统 / 用户 / 助手 / 思考 / 工具）', data.slices)
    const sumParts = data.slices.reduce((n, s) => n + s.tokens, 0)
    ok(Math.abs(sumParts - 1000) <= 4, '分类估算合计贴近 agent 总量（去掉四舍五入误差）', sumParts)

    const unknown = contextPaneData({
      session,
      stats: { contextUsage: { tokens: null, contextWindow: 10_000, percent: null, modelKey: 'anthropic/claude-x' } },
      messages
    })
    ok(unknown.slices.length === 0, '没有可信总量时不画构成')

    const kept = [
      { id: 'u0', entryId: 'e0', role: 'user', text: 'old', timestamp: 10 },
      { id: 'a0', entryId: 'e1', role: 'assistant', text: 'x'.repeat(400), timestamp: 20 },
      { id: 'u1', entryId: 'e2', role: 'user', text: 'kept', timestamp: 30 },
      { id: 'a1', role: 'assistant', text: 'after', timestamp: 60 }
    ]
    ok(inContextMessages(kept, { firstKeptEntryId: 'e2', compactedAt: 50 }).map((m) => m.id).join() === 'u1,a1', '有保留起点时按 entryId 精确切分，压缩后的消息照常计入')
    const approx = [
      { id: 'u-old', role: 'user', text: 'old', timestamp: 10 },
      { id: 'a-old', role: 'assistant', text: 'y'.repeat(400_000), timestamp: 20 },
      { id: 'u0', role: 'user', text: 'q', timestamp: 30 },
      { id: 'a0', role: 'assistant', text: 'z'.repeat(80_000), timestamp: 40 },
      { id: 'a1', role: 'assistant', text: 'after', timestamp: 60 }
    ]
    ok(inContextMessages(approx, { compactedAt: 50 }).map((m) => m.id).join() === 'a0,a1', '没有 entryId 时按 pi 的保留量（约 2 万 token）从压缩点往回切')
    ok(inContextMessages(approx, undefined).length === approx.length, '没有压缩时全部计入')
    const compactedData = contextPaneData({ session: { model, lastCompaction: null, contextFrom: { compactedAt: 50 } }, stats, messages: approx })
    ok(compactedData.compacted === true, '压缩过时标记，系统一栏改称含压缩摘要')

    const settled = contextPaneData({ session, stats, messages: messages.slice(0, -1) })
    const streamingSession = { ...session, isStreaming: true }
    const growing = (text) => contextPaneData({ session: streamingSession, stats, messages: [...messages.slice(0, -1), { ...messages[1], text }] })
    const first = growing('h')
    const later = growing('h'.repeat(4000))
    const tokensOf = (d) => d.slices.map((s) => `${s.id}:${s.tokens}`).join()
    ok(tokensOf(first) === tokensOf(later), '输出中末尾助手消息增长时构成保持不变', [tokensOf(first), tokensOf(later)])
    ok(tokensOf(first) === tokensOf(settled), '输出中的助手消息不计入构成，结束后再计入', [tokensOf(first), tokensOf(settled)])
    ok(tokensOf(contextPaneData({ session, stats, messages })) !== tokensOf(first), '结束输出后构成包含末尾助手消息')
  }

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
