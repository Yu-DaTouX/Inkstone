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
  buildRailStats,
  clockText,
  costText,
  countText,
  GLANCE_BARS,
  hasRailStats,
  hitText,
  railTimeText,
  spanText,
  steadyCount,
  sumTime,
  tokenText,
  tpsNumber,
  tpsText
} = mod

const t = (key, vars) => (vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key)
const money = (usd) => `$${usd.toFixed(2)}`
const metrics = (over = {}) => ({
  turns: 3,
  steps: 7,
  tps: 42.345,
  tpsPartial: false,
  modelMs: 192_000,
  modelPartial: false,
  toolMs: 65_000,
  toolPartial: false,
  ttftMs: 1240,
  ttftPartial: false,
  total: 12_345,
  input: 1000,
  output: 2000,
  cacheRead: 9000,
  cacheWrite: 345,
  hitRate: 90.7,
  latestHitRate: 95.5,
  overheadExcluded: false,
  partial: false,
  source: 'messages',
  cost: null,
  costEstimated: 0,
  costZero: false,
  ...over
})
const build1 = (over = {}, input = {}) =>
  buildRailStats({ metrics: metrics(over), historyPartial: false, subagentTokens: 0, money, t, ...input })

assert.equal(abbrevCount(1000), '1K', '收起行摘要沿用原缩写')
assert.equal(abbrevToken(12_345, 'tok'), '12.3K tok')
assert.equal(steadyCount(999), '999')
assert.equal(steadyCount(1000), '1.0K', '展开内容跨档保持一位小数')
assert.equal(steadyCount(707_100), '707.1K')
assert.equal(steadyCount(999_960), '1.0M', '四舍五入到 1000.0K 时进位到 M')
assert.equal(steadyCount(2_000_000), '2.0M')
assert.equal(steadyCount(Number.NaN), '0')

assert.equal(clockText(450), '450ms')
assert.equal(clockText(12_400), '12s')
assert.equal(clockText(65_000), '1m 05s', '秒位补零，位数不跳')
assert.equal(clockText(257_000), '4m 17s')
assert.equal(clockText(3_725_000), '1h 02m')
assert.equal(spanText(1240), '1.2s')
assert.equal(spanText(850), '850ms')
assert.equal(spanText(12_000), '12s')
assert.equal(sumTime(null, true), '—')
assert.equal(sumTime(450, true), '≥450ms')
assert.equal(hitText(80.99), '80%')
assert.equal(hitText(140), '100%')
assert.equal(hitText(null), null)
assert.equal(countText(5, true), '≥5')
assert.equal(tokenText(1234, true, 'tok'), `≥${(1234).toLocaleString()} tok`)
assert.equal(tpsText(123.6, 'tok/s'), '124 tok/s')
assert.equal(tpsNumber(42.345), '42.3')

assert.equal(costText(metrics({ cost: 0.42 }), money), '$0.42')
assert.equal(costText(metrics({ cost: 0.42, costEstimated: 0.1 }), money), '≈$0.42', '含估算费用加 ≈')
assert.equal(costText(metrics({ cost: 0, costZero: true }), money), null, '报 0 不显示费用')
assert.equal(costText(metrics({ cost: null }), money), null)

assert.equal(hasRailStats(metrics({ turns: 0, steps: 0, total: null })), false)
assert.equal(hasRailStats(metrics({ turns: 0, steps: 0, total: 0 })), true)
assert.equal(build1({ turns: 0, steps: 0, total: null }), null)
assert.notEqual(build1({ turns: 0, steps: 0, total: null }, { counts: { turns: 1, steps: 1 } }), null, '首步进行中也有头部')

const full = build1()
assert.equal(full.headline, 'sm.headline(turns=3,steps=7)')
assert.deepEqual(full.summary, { turns: 3, total: '12.3K tok.unit' }, '收起行摘要口径不变')
assert.equal(full.tokens.total, '12.3K')
assert.equal(full.tokens.unit, 'tok.unit')
assert.equal(full.tokens.hit, 'sm.cacheHit(pct=90%)')
assert.ok(full.tokens.hitTitle.includes('90.70%'))
assert.deepEqual(full.tokens.segments.map((s) => s.key), ['input', 'cacheRead', 'cacheWrite', 'output'])
assert.deepEqual(full.tokens.segments.map((s) => s.text), ['1.0K', '9.0K', '345', '2.0K'])
assert.equal(full.tokens.segments[0].label, 'sm.inputNew')
assert.equal(new Set(full.tokens.segments.map((s) => s.tone)).size, 4, '构成四段颜色不同')
assert.equal(full.tokens.title.split('\n')[0], `sm.total ${(12_345).toLocaleString()} tok.unit`)
assert.equal(full.extras, null, '无子 Agent、无费用时省略小字行')

assert.equal(full.time.baseMs, 257_000, '用时 = 模型 + 工具')
assert.equal(railTimeText(full.time), '4m 17s')
assert.equal(railTimeText(full.time, 3000), '4m 20s', '运行中按秒累加')
assert.equal(full.time.partial, false)
assert.deepEqual(full.time.segments.map((s) => [s.key, s.value]), [['model', 192_000], ['tool', 65_000]])
assert.equal(full.time.detail, 'sm.modelShort 3m 12s · sm.toolShort 1m 05s · sm.ttftShort 1.2s')
assert.equal(full.time.title, null)

assert.equal(full.speed.value, '42.3', '只有平均速度时也显示')
assert.equal(full.speed.caption, '')
const withSpeed = build1({}, { speeds: [10, 0, 20, Number.NaN, 52] })
assert.equal(withSpeed.speed.value, '52.0', '主数字显示最近一步，不混用会话均速')
assert.equal(withSpeed.speed.title, 'sm.outputSpeedTip', '明确只计算模型生成输出')
assert.deepEqual(withSpeed.speed.bars, [10, 20, 52])
assert.equal(withSpeed.speed.live, undefined)
assert.equal(withSpeed.speed.caption, 'sm.recentSteps(n=3) · sm.latestSpeed(speed=52.0 tok.perSec)')
const liveSpeed = build1({}, { speeds: [10, 20], liveSpeed: 48 })
assert.equal(liveSpeed.speed.live, 48)
assert.equal(liveSpeed.speed.value, '48.0', '当前一步有可靠速度时显示当前值')
assert.ok(liveSpeed.speed.caption.endsWith(' · sm.liveStep'), '进行中柱旁标进行中')
const liveUnknown = build1({}, { speeds: [10, 20], liveSpeed: null })
assert.equal(liveUnknown.speed.live, null, '进行中但还算不出速度时仍保留虚线柱')
const liveEstimated = build1({}, { speeds: [10, 20], liveSpeed: 48, liveSpeedEstimated: true })
assert.equal(liveEstimated.speed.value, '≈48.0', '进行中估算速度加 ≈')
assert.equal(liveEstimated.speed.estimated, true)
assert.ok(liveEstimated.speed.title.includes('sm.liveSpeedEstimate'), 'tooltip 说明进行中为估算')
assert.equal(build1({}, { speeds: [10, 20], liveSpeed: 48 }).speed.estimated, false, '真实速度不加 ≈')
assert.equal(liveUnknown.speed.value, '—', '不能拿过去均速冒充当前速度')
assert.equal(build1({ tps: null }, { speeds: [], liveSpeed: 60 }).speed.value, '60.0', '首步没有历史样本时也能显示当前输出速度')
assert.equal(build1({ tps: null }, { speeds: [], liveSpeed: null }).speed.value, '—', '首步等待可靠输出计时时不估算')
assert.equal(build1({ tps: null }, { speeds: [] }).speed, null)

const extras = build1({ cost: 0.42, costEstimated: 0.05 }, { subagentTokens: 120_000 })
assert.equal(extras.extras, 'sm.withSubagents +120.0K · sm.costLine(cost=≈$0.42)')
assert.ok(extras.extrasTitle.includes(`sm.withSubagents ${(132_345).toLocaleString()} tok.unit`))
assert.ok(extras.extrasTitle.includes('sm.costEstimatedTip'))
assert.equal(build1({ cost: 0.42 }).extras, 'sm.costLine(cost=$0.42)')
assert.equal(build1({ cost: 0, costZero: true }, { subagentTokens: 5 }).extras, 'sm.withSubagents +5')

const noWrite = build1({ cacheWrite: null })
assert.deepEqual(noWrite.tokens.segments.map((s) => s.key), ['input', 'cacheRead', 'output'], '缓存写入为空时省略该段')

const noTotal = build1({ tps: null, total: null, input: null, output: null, cacheRead: null, cacheWrite: null, hitRate: null, latestHitRate: null })
assert.equal(noTotal.tokens, null)
assert.equal(noTotal.summary.total, null)

const noTime = build1({ modelMs: null, toolMs: 0, ttftMs: null })
assert.equal(noTime.time, null, '没有任何用时数据时整块不显示')
const noTools = build1({ toolMs: 0 })
assert.deepEqual(noTools.time.segments.map((s) => s.key), ['model'])
assert.equal(noTools.time.detail, 'sm.modelShort 3m 12s · sm.ttftShort 1.2s')

const partial = build1({ partial: true, toolPartial: true }, { historyPartial: true })
assert.equal(partial.headline, 'sm.headline(turns=≥3,steps=≥7)')
assert.equal(partial.headlineTitle, 'sm.historyPartialTip')
assert.equal(partial.tokens.total, '≥12.3K')
assert.deepEqual(partial.tokens.title.split('\n').slice(1), ['sm.historyPartialTip', 'sm.partialTip'])
assert.equal(partial.time.partial, true)
assert.equal(railTimeText(partial.time), '≥4m 17s')
assert.equal(partial.time.detail, 'sm.modelShort 3m 12s · sm.toolShort ≥1m 05s · sm.ttftShort 1.2s')
assert.equal(partial.time.title, 'sm.timingPartialTip')
assert.equal(build1({ toolMs: null }).time.partial, true, '有工具但无计时也算缺数据')

const counted = build1({}, { counts: { turns: 4, steps: 8 }, liveSince: 1000 })
assert.equal(counted.headline, 'sm.headline(turns=4,steps=8)', '头部轮数与步数含进行中的一步')
assert.equal(counted.summary.turns, 4)
assert.equal(counted.liveSince, 1000)

assert.equal(full.glance.hit, 90.7, '收起行圆环用累计命中率')
assert.equal(full.glance.hitText, '90%')
assert.deepEqual(full.glance.metric, { kind: 'speed', value: '42.3', unit: 'tok.perSec', bars: null, pending: null }, '空闲时显示平均速度')
assert.ok(full.glance.title.startsWith('sm.headline(turns=3,steps=7)\nsm.total'), 'tooltip 给完整信息')
assert.ok(full.glance.title.includes('sm.hitRate 90.70%'))
const glanceLive = build1({}, { speeds: [5, 10, 20, 30, 40], liveSpeed: 48 })
assert.deepEqual(glanceLive.glance.metric, { kind: 'speed', value: '48.0', unit: 'tok.perSec', bars: [20, 30, 40], pending: 48 }, '运行中显示当前步速度与最近 3 根柱 + 虚线柱')
assert.ok(glanceLive.glance.title.endsWith('sm.liveStep 48.0 tok.perSec'))
const glanceEstimated = build1({}, { speeds: [5, 10, 20], liveSpeed: 48, liveSpeedEstimated: true })
assert.equal(glanceEstimated.glance.metric.value, '≈48.0', '收起摘要同样标出估算')
assert.equal(glanceEstimated.glance.metric.estimated, true)
const glanceLiveUnknown = build1({}, { speeds: [], liveSpeed: null })
assert.deepEqual(glanceLiveUnknown.glance.metric, { kind: 'speed', value: '—', unit: 'tok.perSec', bars: [], pending: null }, '运行中尚无速度时显示 —')
const glanceTokens = build1({ tps: null }, { speeds: [] })
assert.deepEqual(glanceTokens.glance.metric, { kind: 'tokens', value: '12.3K', unit: 'tok.unit' }, '没有速度时显示总 token')
const glanceCounts = build1({ tps: null, total: null, hitRate: null })
assert.deepEqual(glanceCounts.glance.metric, { kind: 'counts', text: 'sm.headline(turns=3,steps=7)' }, '连用量都没有时显示轮数与步数')
assert.equal(glanceCounts.glance.hit, null)
assert.equal(build1({}, { speeds: [10, 20, 76.6] }).glance.metric.value, '76.6', '收起与展开使用同一最近一步速度')
assert.ok(build1({}, { speeds: [76.6] }).glance.title.includes('76.6 tok.perSec'))
assert.ok(!glanceLive.glance.title.includes('42.3'), '当前步 tooltip 不再混入旧会话均速')
assert.equal(GLANCE_BARS, 3)

const latestUnknown = build1({}, { speeds: [200, 1387], latestSpeed: null })
assert.equal(latestUnknown.glance.metric.value, '—', '最新一步缺可靠计时，不回退为较早步骤的高速样本')
assert.equal(latestUnknown.speed.value, '—', '展开与收起的未知状态一致')
assert.equal(build1({}, { speeds: [200, 1387], latestSpeed: 139 }).glance.metric.value, '139', '优先使用最新步骤的实际测速')

console.log('rail-stats ok')
