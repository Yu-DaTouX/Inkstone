import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/workbench/rail-stats.ts', import.meta.url))
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)
const {
  abbrevCount,
  abbrevToken,
  avgTime,
  buildRailStats,
  countText,
  hasRailStats,
  railStatTitle,
  shortHitRate,
  sumTime,
  tokenText,
  tpsNumber,
  tpsText
} = mod

const t = (key) => key
const metrics = (over = {}) => ({
  turns: 3,
  steps: 7,
  tps: 42.345,
  tpsPartial: false,
  modelMs: 12_000,
  modelPartial: false,
  toolMs: 800,
  toolPartial: false,
  ttftMs: 450,
  ttftPartial: false,
  total: 12_345,
  input: 1000,
  output: 2000,
  cacheRead: 9000,
  cacheWrite: 345,
  hitRate: 90,
  latestHitRate: 95.5,
  overheadExcluded: false,
  partial: false,
  source: 'messages',
  cost: null,
  costEstimated: 0,
  costZero: false,
  ...over
})
const statOf = (model, key) => model.stats.find((stat) => stat.key === key)
const detailOf = (stat, key) => stat.details.find((detail) => detail.key === key)?.value

assert.equal(abbrevCount(999), '999')
assert.equal(abbrevCount(1000), '1K')
assert.equal(abbrevCount(1500), '1.5K')
assert.equal(abbrevCount(2_000_000), '2M')
assert.equal(abbrevToken(null, 'tok'), '—')
assert.equal(abbrevToken(12_345, 'tok'), '12.3K tok')

assert.equal(countText(5, false), '5')
assert.equal(countText(5, true), '≥5')
assert.equal(tokenText(null, false, 'tok'), '—')
assert.equal(tokenText(1234, true, 'tok'), `≥${(1234).toLocaleString()} tok`)
assert.equal(tpsText(null, 'tok/s'), '—')
assert.equal(tpsText(42.345, 'tok/s'), '42.3 tok/s')
assert.equal(tpsText(123.6, 'tok/s'), '124 tok/s')
assert.equal(tpsNumber(null), '—')
assert.equal(tpsNumber(42.345), '42.3')
assert.equal(avgTime(null), '—')
assert.equal(avgTime(450), '450ms')
assert.equal(sumTime(null, true), '—')
assert.equal(sumTime(450, true), '≥450ms')
assert.ok(!sumTime(450, false).startsWith('≥'))
assert.equal(shortHitRate(null), '—')
assert.equal(shortHitRate(37.56), '37.5%')
assert.equal(shortHitRate(100), '100%')
assert.equal(shortHitRate(0), '0.0%')

assert.equal(hasRailStats(metrics({ turns: 0, steps: 0, total: null })), false)
assert.equal(hasRailStats(metrics({ turns: 0, steps: 0, total: 0 })), true)
assert.equal(hasRailStats(metrics({ turns: 0, steps: 1, total: null })), true)
assert.equal(hasRailStats(metrics({ turns: 1, steps: 0, total: null })), true)
assert.equal(buildRailStats({ metrics: metrics({ turns: 0, steps: 0, total: null }), historyPartial: false, subagentTokens: 0, t }), null)

const full = buildRailStats({ metrics: metrics(), historyPartial: false, subagentTokens: 0, speeds: [10, 0, 20, Number.NaN, 30], t })
assert.deepEqual(full.stats.map((stat) => stat.key), ['turns', 'steps', 'total', 'hitRate', 'tps'], '会话统计只留五项')
assert.equal(statOf(full, 'turns').value, '3')
assert.equal(statOf(full, 'steps').value, '7')
assert.equal(statOf(full, 'tps').value, '42.3')
assert.equal(statOf(full, 'tps').unit, 'tok.perSec')
assert.equal(statOf(full, 'total').value, '12.3K')
assert.equal(statOf(full, 'total').unit, 'tok.unit')
assert.equal(statOf(full, 'hitRate').value, '90.0%')
assert.equal(full.hitPercent, 90)
assert.deepEqual(full.speeds, [10, 20, 30], '速度序列丢掉无效值')
assert.deepEqual(full.summary, { turns: 3, total: '12.3K tok.unit' })

const tps = statOf(full, 'tps')
assert.deepEqual(tps.details.map((d) => d.key), ['modelTime', 'toolTime', 'ttft'], '计时字段进输出速度的悬停提示')
assert.equal(tps.notes.length, 0)
const total = statOf(full, 'total')
assert.deepEqual(total.details.map((d) => d.key), ['total', 'inputUncached', 'cacheRead', 'cacheWrite', 'output'], 'token 明细进总数的悬停提示')
assert.equal(detailOf(total, 'total'), `${(12_345).toLocaleString()} tok.unit`)
const hit = statOf(full, 'hitRate')
assert.equal(detailOf(hit, 'hitRate'), '90.00%')
assert.equal(detailOf(hit, 'hitRateLatest'), '95.50%')

const totalTitle = railStatTitle(total).split('\n')
assert.equal(totalTitle[0], `sm.total ${(12_345).toLocaleString()} tok.unit`, '总数提示首行用精确值')
assert.ok(totalTitle.includes(`sm.cacheRead ${(9000).toLocaleString()} tok.unit`))
assert.equal(railStatTitle(statOf(full, 'turns')), 'sm.turns 3')
assert.equal(railStatTitle(tps).split('\n')[0], 'sm.tps 42.3 tok.perSec')

const withSub = buildRailStats({ metrics: metrics(), historyPartial: false, subagentTokens: 1000, t })
assert.equal(detailOf(statOf(withSub, 'total'), 'withSubagents'), `${(13_345).toLocaleString()} tok.unit`)
assert.equal(statOf(withSub, 'total').details[1].key, 'withSubagents')

const noWrite = buildRailStats({ metrics: metrics({ cacheWrite: null }), historyPartial: false, subagentTokens: 0, t })
assert.ok(!statOf(noWrite, 'total').details.some((d) => d.key === 'cacheWrite'))
assert.deepEqual(noWrite.speeds, [])

const noTotal = buildRailStats({ metrics: metrics({ tps: null, total: null, input: null, output: null, cacheRead: null, cacheWrite: null, hitRate: null, latestHitRate: null }), historyPartial: false, subagentTokens: 0, t })
assert.equal(noTotal.summary.total, null)
assert.equal(statOf(noTotal, 'total').value, '—')
assert.equal(statOf(noTotal, 'total').unit, null)
assert.equal(statOf(noTotal, 'hitRate').value, '—')
assert.equal(statOf(noTotal, 'tps'), undefined, '没有输出速度时不占一格')
assert.deepEqual(noTotal.stats.map((stat) => stat.key), ['turns', 'steps', 'total', 'hitRate'])
assert.equal(noTotal.hitPercent, null)

const partial = buildRailStats({ metrics: metrics({ partial: true, toolPartial: true }), historyPartial: true, subagentTokens: 0, t })
assert.equal(statOf(partial, 'turns').value, '≥3')
assert.equal(statOf(partial, 'total').value, '≥12.3K')
assert.equal(detailOf(statOf(partial, 'tps'), 'toolTime'), '≥800ms')
assert.deepEqual(statOf(partial, 'turns').notes, ['sm.historyPartialTip'])
assert.deepEqual(statOf(partial, 'total').notes, ['sm.historyPartialTip', 'sm.partialTip'])
assert.deepEqual(statOf(partial, 'tps').notes, ['sm.timingPartialTip'])
assert.ok(railStatTitle(statOf(partial, 'tps')).endsWith('sm.timingPartialTip'))

const clamped = buildRailStats({ metrics: metrics({ hitRate: 140 }), historyPartial: false, subagentTokens: 0, t })
assert.equal(clamped.hitPercent, 100)

console.log('rail-stats ok')
