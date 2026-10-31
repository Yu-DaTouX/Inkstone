import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))

async function loadTs(rel) {
  const result = await build({
    entryPoints: [here(rel)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const limits = await loadTs('../src/shared/context-limits.ts')
const { AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS, autoCompactAt, pickTokenStep } = limits
assert.ok(!('CONTEXT_TRIM_STEPS' in limits) && !('contextTrimAt' in limits), '裁剪已删除，shared 不再导出裁剪档位')
assert.deepEqual([...AUTO_COMPACT_STEPS], [100_000, 250_000, 300_000, 400_000, 600_000, 800_000], '压缩档位与随包扩展一致')
assert.equal(autoCompactAt(400_000, 1_000_000), 400_000, '窗口足够时不提前')
assert.equal(autoCompactAt(400_000, 300_000), 270_000, '窗口小按 90% 提前')
assert.equal(autoCompactAt(400_000, 0), 400_000, '窗口未知时用设置值')
assert.equal(pickTokenStep(250_000, AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS), 250_000, '档位内的非缺省值保留')
assert.equal(pickTokenStep(400_000, AUTO_COMPACT_STEPS, DEFAULT_AUTO_COMPACT_TOKENS), undefined, '等于缺省值不写入设置')

const usage = await loadTs('../src/renderer/src/features/settings/usage/usage-model.ts')
const { USAGE_DIMENSIONS, DAILY_MAX_DAYS, usageBars, dailyEntries } = usage
assert.deepEqual([...USAGE_DIMENSIONS], ['day', 'model'], '两个分组维度：按日 / 按模型')
assert.equal(DAILY_MAX_DAYS, 30, '按日最多 30 天')

const bars = usageBars([
  { key: 'a', value: 100 },
  { key: 'b', value: 50 },
  { key: 'c', value: 0 }
])
assert.equal(bars.length, 3)
assert.equal(bars[0].ratio, 1, '最大值条形占满')
assert.equal(bars[1].share, 50 / 150, '占比按总量计算')
assert.equal(bars[1].ratio, 0.5, '条形按最大值归一')
assert.equal(bars[2].ratio, 0, '零值不产生 NaN')
assert.equal(bars[0].label, 'a', '缺省标签用 key')
assert.deepEqual(usageBars([]), [], '空输入返回空数组')
const zero = usageBars([{ key: 'x', value: 0 }])
assert.equal(zero[0].share, 0, '总量为 0 时占比为 0，不产生 NaN')

const heat = Array.from({ length: 40 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, tokens: i }))
assert.equal(dailyEntries(heat, '7d').length, 7, '近 7 天取尾部 7 项')
assert.equal(dailyEntries(heat, '7d').at(-1).value, 39, '取的是最近一天')
assert.equal(dailyEntries(heat, '30d').length, 30, '近 30 天取尾部 30 项')
assert.equal(dailyEntries(heat, 'all').length, 30, '全部也夹在最多 30 天')
assert.equal(dailyEntries([], 'all').length, 0, '没有热度数据时返回空')

const types = await loadTs('../src/renderer/src/features/settings/types.ts')
const { resolveLegacyView, isSettingsSectionId, SETTINGS_SECTIONS } = types
assert.ok(SETTINGS_SECTIONS.some((section) => section.id === 'session'), '会话与上下文分区存在')
assert.ok(!SETTINGS_SECTIONS.some((section) => section.id === 'context'), '上下文并入会话分区，不再独立')
assert.equal(isSettingsSectionId('context'), false, 'context 不再是独立分区')
assert.deepEqual(resolveLegacyView('context'), { kind: 'section', view: 'context', section: 'session' }, '旧深链接 context 落到会话与上下文分区')

console.log('v3 上下文设置 / 用量图表：阈值、分组、深链接检查通过')
