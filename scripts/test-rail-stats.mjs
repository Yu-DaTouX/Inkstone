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
const { abbrevCount, abbrevToken, avgTime, buildRailStats, countText, hasRailStats, sumTime, tokenText, tpsText } = mod

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
const valueOf = (rows, key) => rows.find((row) => row.key === key)?.value

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
assert.equal(avgTime(null), '—')
assert.equal(avgTime(450), '450ms')
assert.equal(sumTime(null, true), '—')
assert.equal(sumTime(450, true), '≥450ms')
assert.ok(!sumTime(450, false).startsWith('≥'))

assert.equal(hasRailStats(metrics({ turns: 0, steps: 0, total: null })), false)
assert.equal(hasRailStats(metrics({ turns: 0, steps: 0, total: 0 })), true)
assert.equal(hasRailStats(metrics({ turns: 0, steps: 1, total: null })), true)
assert.equal(hasRailStats(metrics({ turns: 1, steps: 0, total: null })), true)
assert.equal(buildRailStats({ metrics: metrics({ turns: 0, steps: 0, total: null }), historyPartial: false, subagentTokens: 0, t }), null)

const full = buildRailStats({ metrics: metrics(), historyPartial: false, subagentTokens: 0, t })
assert.deepEqual(
  full.session.map((row) => row.key),
  ['turns', 'steps', 'tps', 'modelTime', 'toolTime', 'ttft']
)
assert.deepEqual(
  full.tokens.map((row) => row.key),
  ['total', 'hitRate', 'hitRateLatest', 'inputUncached', 'cacheRead', 'cacheWrite', 'output']
)
assert.equal(valueOf(full.session, 'turns'), '3')
assert.equal(valueOf(full.session, 'tps'), '42.3 tok.perSec')
assert.equal(valueOf(full.tokens, 'hitRate'), '90.00%')
assert.equal(valueOf(full.tokens, 'hitRateLatest'), '95.50%')
assert.equal(full.notes.length, 0)
assert.deepEqual(full.summary, { turns: 3, total: '12.3K tok.unit' })

const withSub = buildRailStats({ metrics: metrics(), historyPartial: false, subagentTokens: 1000, t })
assert.equal(valueOf(withSub.tokens, 'withSubagents'), `${(13_345).toLocaleString()} tok.unit`)
assert.equal(withSub.tokens[1].key, 'withSubagents')

const noWrite = buildRailStats({ metrics: metrics({ cacheWrite: null }), historyPartial: false, subagentTokens: 0, t })
assert.ok(!noWrite.tokens.some((row) => row.key === 'cacheWrite'))

const noTotal = buildRailStats({ metrics: metrics({ total: null, input: null, output: null, cacheRead: null, cacheWrite: null, hitRate: null, latestHitRate: null }), historyPartial: false, subagentTokens: 0, t })
assert.equal(noTotal.summary.total, null)
assert.equal(valueOf(noTotal.tokens, 'total'), '—')
assert.equal(valueOf(noTotal.tokens, 'hitRate'), '—')

const partial = buildRailStats({ metrics: metrics({ partial: true, toolPartial: true }), historyPartial: true, subagentTokens: 0, t })
assert.equal(valueOf(partial.session, 'turns'), '≥3')
assert.equal(valueOf(partial.session, 'toolTime'), '≥800ms')
assert.ok(valueOf(partial.tokens, 'total').startsWith('≥'))
assert.deepEqual(partial.notes, ['sm.historyPartialTip', 'sm.partialTip', 'sm.timingPartialTip'])

console.log('rail-stats ok')
