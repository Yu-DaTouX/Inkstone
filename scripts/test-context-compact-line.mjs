import { fileURLToPath } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const rel = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url))

await runSuite(import.meta.url, async (ok, compile) => {
  const { contextUsageSummary, autoCompactDistance, shortTokens } = await compile(rel('src/renderer/src/features/workbench/context-pane-view.ts'))
  const { withLastCompactionAfter } = await compile(rel('src/renderer/src/features/workbench/context-compactions.ts'))

  const model = { provider: 'fake', id: 'fake-model', contextWindow: 400_000 }
  const usage = (tokens) => ({ contextUsage: { tokens, contextWindow: 400_000, modelKey: 'fake/fake-model' } })
  const session = { model, lastCompaction: null }

  const at355 = contextUsageSummary(session, usage(355_000), 400_000)
  ok(at355.windowSize === 400_000 && at355.compactAt === 360_000, '上限等于窗口时分母仍是完整窗口，压缩线按 0.9 落在 360k', JSON.stringify(at355))
  const near = autoCompactDistance(at355, true)
  ok(near.kind === 'limit' && near.remaining === 5_000, '355k 时再用 5k 触发自动压缩，而不是剩余 45k', JSON.stringify(near))
  ok(autoCompactDistance(contextUsageSummary(session, usage(372_000), 400_000), true).kind === 'reached', '超过 360k 线时显示已到自动压缩上限')
  const capped = contextUsageSummary(session, usage(100_000), 300_000)
  ok(capped.windowSize === 300_000 && capped.compactAt === 300_000, '上限小于窗口时分母与压缩线都是上限，不画额外刻度')
  ok(autoCompactDistance(contextUsageSummary(session, usage(100_000)), false).kind === 'off', '关掉自动压缩时不算压缩线')
  ok(contextUsageSummary(session, usage(100_000)).compactAt === null, '没有上限时没有压缩线')
  ok(shortTokens(16_734) === '16.7k', '面板、输入框与设置页共用一位小数的 k 写法')

  const items = [{ id: 'c2', at: 2, tokensBefore: 372_100, summaryTokens: 235 }, { id: 'c1', at: 1, tokensBefore: 300_000, tokensAfter: 60_000, summaryTokens: 100 }]
  const fresh = withLastCompactionAfter(items, { status: 'completed', beforeTokens: 372_100, afterTokens: 16_700 })
  ok(fresh[0].tokensAfter === 16_700 && fresh[0].afterEstimated === true && fresh[1] === items[1], '刚压缩完没有实测时用 pi 的估算补上压缩后用量并标成估算')
  const measured = withLastCompactionAfter(items, { status: 'completed', beforeTokens: 372_100, afterTokens: 90_000, afterMeasured: true })
  ok(measured[0].tokensAfter === 90_000 && !measured[0].afterEstimated, '下一轮实测回填后不再标估算')
  ok(withLastCompactionAfter(items, { status: 'completed', beforeTokens: 500_000, afterTokens: 1 })[0].tokensAfter === undefined, '对不上的压缩不借用数字')
  ok(withLastCompactionAfter(items, { status: 'failed', beforeTokens: 372_100, afterTokens: 1 })[0].tokensAfter === undefined, '失败的压缩不补')
})
