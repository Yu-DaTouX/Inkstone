#!/usr/bin/env node
import assert from 'node:assert/strict'
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
export { MAX_MOUNTED_PANES, emptyMountState, nextVisited, mountedTabs } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/mount-state'))}'
export { resolvePanelLayout, fallbackSecondary, cellForTab, extraVisibleTabs, nextSplitTab, splitTabOnPrimaryChange } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/panel-layout'))}'
export { autoCompactLimitOf, contextUsageSummary, contextOccupancy, contextPaneData, shortTokens } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/context-pane-view'))}'
export { contextFromOf, inContextMessages } from '${posix(resolve(ROOT, 'src/renderer/src/state/context-breakdown'))}'
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
    MAX_MOUNTED_PANES,
    emptyMountState,
    nextVisited,
    mountedTabs,
    resolvePanelLayout,
    fallbackSecondary,
    cellForTab,
    extraVisibleTabs,
    nextSplitTab,
    splitTabOnPrimaryChange,
    autoCompactLimitOf,
    contextUsageSummary,
    contextFromOf,
    inContextMessages,
    contextOccupancy,
    contextPaneData,
    shortTokens,
    restorableWorkbenchTab
  } = mod

  group('页签注册：上下文进入固定页签与恢复白名单（W0）')
  {
    ok(WORKBENCH_TABS.includes('context'), '上下文在固定页签里', WORKBENCH_TABS)
    ok(WORKBENCH_TABS.slice(-3).join('>') === 'branch>logs>quota', '分支页之后依次是日志、额度（日志 / 额度页签追加在末尾）', WORKBENCH_TABS)
    ok(MAX_MOUNTED_PANES === 9, '固定页签增到九个（加入日志与额度页）', MAX_MOUNTED_PANES)
    ok(!WORKBENCH_ACTIVE_TABS.has('context'), '上下文是只读页签，不需要会话激活')
    ok(restorableWorkbenchTab('context') === 'context', '只读的上下文页签原样恢复')
    ok(restorableWorkbenchTab('terminal') === 'overview', '终端降级到概览，不隐式起 PTY')
    ok(restorableWorkbenchTab('browser') === 'overview', '浏览器降级到概览，不隐式导航')

    const empty = emptyMountState()
    const splitRegistered = nextVisited(empty, { open: true, activeTab: 'changes', extra: ['context'] })
    ok(splitRegistered.has('changes') && splitRegistered.has('context'), '拆分打开时主格与下半格都登记')
    ok(nextVisited(splitRegistered, { open: true, activeTab: 'changes', extra: ['context'] }) === splitRegistered, '无变化时返回原引用')
    ok(nextVisited(splitRegistered, { open: false, activeTab: 'terminal', extra: ['terminal'] }) === splitRegistered, '关闭不注销、不动已访问集合')
    ok(mountedTabs(splitRegistered).join(',') === 'changes,context', '登记后按固定顺序渲染', mountedTabs(splitRegistered))
  }

  group('拆分与专注：上下两格、单页签最大化、两格不撞页签')
  {
    const off = resolvePanelLayout({ split: false, focus: false, activeTab: 'changes', splitTab: 'context' })
    ok(off.primary === 'changes' && off.secondary === null, '不拆分时只有主格一块')

    const on = resolvePanelLayout({ split: true, focus: false, activeTab: 'changes', splitTab: 'context' })
    ok(on.primary === 'changes' && on.secondary === 'context', '拆分时上下两格各一页签')

    const focus = resolvePanelLayout({ split: true, focus: true, activeTab: 'terminal', splitTab: 'context' })
    ok(focus.primary === 'terminal' && focus.secondary === null, '专注压过拆分：只留当前页签一块')

    const clash = resolvePanelLayout({ split: true, focus: false, activeTab: 'changes', splitTab: 'changes' })
    ok(clash.secondary !== null && clash.secondary !== clash.primary, '两格撞同一页签时兜底到另一个页签', clash)
    ok(clash.secondary === 'files', '兜底优先取只读页签而不是终端 / 浏览器', clash.secondary)

    for (const tab of WORKBENCH_TABS) {
      ok(!WORKBENCH_ACTIVE_TABS.has(fallbackSecondary(tab)), `兜底页签不从需要激活的页签里取（active=${tab}）`, fallbackSecondary(tab))
      ok(fallbackSecondary(tab) !== tab, `兜底页签不等于主格（active=${tab}）`)
    }

    ok(cellForTab(on, 'changes') === 'primary', 'cellForTab 认出主格')
    ok(cellForTab(on, 'context') === 'secondary', 'cellForTab 认出下半格')
    ok(cellForTab(on, 'files') === null, '未显示的已访问页签不属于任何格子')
    assert.deepEqual([...extraVisibleTabs(on)], ['context'], '拆分时下半格列入需要登记的页签')
    assert.deepEqual([...extraVisibleTabs(off)], [], '不拆分时没有额外登记')

    ok(nextSplitTab('context', 'changes', 'files') === 'files', '下半格可换到其它页签')
    ok(nextSplitTab('context', 'changes', 'changes') === null, '下半格不允许选主格页签')
    ok(nextSplitTab('context', 'changes', 'context') === null, '下半格选原值返回 null（不触发更新）')

    ok(
      splitTabOnPrimaryChange({ split: true, splitTab: 'context', prevActive: 'changes', nextActive: 'context' }) === 'changes',
      '主格选到下半格页签时两格互换'
    )
    ok(
      splitTabOnPrimaryChange({ split: true, splitTab: 'context', prevActive: 'changes', nextActive: 'files' }) === null,
      '主格选无关页签时不改下半格'
    )
    ok(
      splitTabOnPrimaryChange({ split: false, splitTab: 'context', prevActive: 'changes', nextActive: 'context' }) === null,
      '不拆分时不触发互换'
    )
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
    ok(warn.tone === 'warn', '≥80% 记 warn')
    const err = contextUsageSummary(
      { model: { ...model, contextWindow: 100_000 }, lastCompaction: null },
      { contextUsage: { tokens: 96_000, contextWindow: 100_000, percent: 96, modelKey: 'anthropic/claude-x' } }
    )
    ok(err.tone === 'err', '≥95% 记 err')

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
    ok(nearly.tone === 'warn', '警告色按上限算：330k / 400k 为 warn', nearly.tone)
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

  group('上下文页签数据：构成、文件与工具结果明细、压缩过滤')
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
    const tools = data.occupancy.find((r) => r.id === 'tools')
    const files = data.occupancy.find((r) => r.id === 'files')
    ok(tools && tools.count === 1, '工具结果按 toolCalls 计数', tools)
    ok(files && files.count === 1 && files.tokens === 1200, '文件 / 图片按附件数估算（单图 1200）', files)

    const unknown = contextPaneData({
      session,
      stats: { contextUsage: { tokens: null, contextWindow: 10_000, percent: null, modelKey: 'anthropic/claude-x' } },
      messages
    })
    ok(unknown.slices.length === 0 && unknown.occupancy.length === 0, '没有可信总量时不画构成与明细')

    const filtered = contextOccupancy([messages[1]], [{ id: 'tools', tokens: 5 }])
    ok(filtered.find((r) => r.id === 'files').count === 0, '不在上下文里的附件不计入')
    ok(filtered.find((r) => r.id === 'tools').count === 1, '上下文里的工具结果仍计入')
    ok(filtered.find((r) => r.id === 'tools').tokens === 5, '工具结果 token 用分类里的工具值')

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
