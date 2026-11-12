import { fileURLToPath } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const rel = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url))

await runSuite(import.meta.url, async (ok, compile) => {
  const { attributeCompaction, reduceCompaction, EMPTY_COMPACTION_ORIGIN, EMPTY_COMPACTION_STATE } = await compile(rel('src/main/compaction.ts'))
  const { compactionErrorText, compactionErrorTip } = await compile(rel('src/renderer/src/state/compaction-view.ts'))

  const play = (origin, events) => {
    let state = EMPTY_COMPACTION_STATE
    let at = origin
    for (const evt of events) {
      const out = attributeCompaction(at, evt)
      at = out.origin
      state = reduceCompaction(state, out.evt, 1) ?? state
    }
    return { state, origin: at }
  }

  const auto = play(EMPTY_COMPACTION_ORIGIN, [
    { type: 'compaction_start', reason: 'manual' },
    { type: 'compaction_end', reason: 'manual', result: { tokensBefore: 372_000, estimatedTokensAfter: 17_000 } }
  ])
  ok(auto.state.last.reason === 'threshold' && auto.state.last.status === 'completed', '扩展触发的原生 compact() 记为已达阈值，不算手动', JSON.stringify(auto.state.last))
  ok(!auto.origin.extensionRun, '一次压缩结束后清掉扩展标记')

  const small = play(EMPTY_COMPACTION_ORIGIN, [
    { type: 'compaction_start', reason: 'manual' },
    { type: 'compaction_end', reason: 'manual', aborted: false, errorMessage: 'Compaction failed: Nothing to compact (session too small)' }
  ])
  ok(small.state.last.reason === 'threshold' && small.state.last.status === 'declined', '自动触发时会话太短记为已跳过，不算失败', JSON.stringify(small.state.last))

  const manual = play({ manualRequests: 1, extensionRun: false }, [
    { type: 'compaction_start', reason: 'manual' },
    { type: 'compaction_end', reason: 'manual', aborted: false, errorMessage: 'Compaction failed: Nothing to compact (session too small)' }
  ])
  ok(manual.state.last.reason === 'manual' && manual.state.last.status === 'failed', '用户点立即压缩时仍是手动，失败照实记', JSON.stringify(manual.state.last))

  const native = attributeCompaction(EMPTY_COMPACTION_ORIGIN, { type: 'compaction_start', reason: 'overflow' })
  ok(native.evt.reason === 'overflow' && native.origin === EMPTY_COMPACTION_ORIGIN, '原生自动压缩的原因不改')

  const t = (key) => `[${key}]`
  ok(compactionErrorText(t, 'Compaction failed: Nothing to compact (session too small)') === '[ctx.err.nothing]', '会话太短翻成短语')
  ok(compactionErrorText(t, 'Auto-compaction failed: Already compacted') === '[ctx.err.already]', '刚压缩过翻成短语')
  ok(compactionErrorText(t, 'Compaction cancelled') === '[ctx.err.cancelled]', '取消翻成短语')
  ok(compactionErrorTip(t, 'Compaction failed: 529 overloaded') === '[ctx.err.other]\nCompaction failed: 529 overloaded', '认不出的原因只在悬停里附原文')
  ok(compactionErrorTip(t, 'Compaction failed: Nothing to compact (session too small)') === '[ctx.err.nothing]', '认得出的原因不附英文原文')
})
