import { fileURLToPath } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { contextUsageSummary, contextPaneData, autoCompactDistance } = await compile(
    fileURLToPath(new URL('../src/renderer/src/features/workbench/context-pane-view.ts', import.meta.url))
  )
  const model = { provider: 'fake', id: 'fake-model', contextWindow: 400_000 }
  const lastCompaction = { status: 'completed', startedAt: 100, endedAt: 200, afterTokens: 24_000 }
  const session = { model, lastCompaction }
  const stats = { contextUsage: { tokens: null, contextWindow: 400_000, percent: null, modelKey: 'fake/fake-model' } }
  const before = JSON.stringify({ session, stats })
  const summary = contextUsageSummary(session, stats, 100_000)
  ok(summary.known && summary.tokens === 24_000, '压缩后待回报时仍显示 pi 给出的上下文估算')
  ok(summary.estimated === true && summary.afterCompactUnknown === false, '估算显式标记，不再作为空值隐藏')
  ok(summary.percent === 24 && summary.windowSize === 100_000, '估算仍使用当前自动压缩上限计算百分比')
  ok(autoCompactDistance(summary, true)?.remaining === 76_000, '剩余空间与压缩后的估算一致')
  ok(JSON.stringify({ session, stats }) === before, '仅作显示回退，不改写原生统计或会话状态')

  const data = contextPaneData({ session, stats, messages: [] })
  ok(data.usage.estimated && data.slices.reduce((sum, row) => sum + row.tokens, 0) === 24_000, '侧栏与上下文详情使用同一估算口径')

  for (const tokens of [0, 31_000]) {
    const measured = contextUsageSummary(session, { contextUsage: { ...stats.contextUsage, tokens } }, 100_000)
    ok(measured.known && measured.tokens === tokens && !measured.estimated, `下一次实际用量 ${tokens} 优先于旧估算`)
  }
  const oldModel = contextUsageSummary(session, { contextUsage: { ...stats.contextUsage, modelKey: 'fake/other' } })
  ok(!oldModel.known && !oldModel.estimated, '旧模型的统计不借压缩估算冒充当前模型用量')
  ok(!contextUsageSummary(session, null).known, '没有当前模型统计时不凭历史压缩记录填数')
  ok(!contextUsageSummary({ ...session, model: { ...model, contextWindow: 0 } }, { contextUsage: { ...stats.contextUsage, contextWindow: 0 } }).known, '窗口未知时不显示百分比')

  for (const afterTokens of [undefined, null, -1, NaN, Infinity, '24000']) {
    const unknown = contextUsageSummary({ ...session, lastCompaction: { ...lastCompaction, afterTokens } }, stats)
    ok(!unknown.known && !unknown.estimated && unknown.afterCompactUnknown, `无有效压缩后估算时继续保持未知：${String(afterTokens)}`)
  }
  const empty = contextUsageSummary({ ...session, lastCompaction: { ...lastCompaction, afterTokens: 0 } }, stats)
  ok(empty.known && empty.tokens === 0 && empty.estimated, '有效的零估算不会被当成缺失值')

  for (const status of ['running', 'failed', 'cancelled', 'declined']) {
    const unknown = contextUsageSummary({ ...session, lastCompaction: { ...lastCompaction, status } }, stats)
    ok(!unknown.known && !unknown.estimated, `${status} 压缩不能提供已完成的上下文估算`)
  }
  const backfilled = contextUsageSummary({ ...session, lastCompaction: { ...lastCompaction, afterMeasured: true } }, stats)
  ok(!backfilled.known && !backfilled.estimated, '已被实测覆盖的历史压缩量不再冒充即时估算')
  const recent = contextUsageSummary({ ...session, lastCompaction: { ...lastCompaction, afterTokens: 10_000 } }, stats)
  ok(recent.tokens === 10_000 && recent.estimated, '再次压缩后采用最新估算，不保留旧压缩前占用')
})
