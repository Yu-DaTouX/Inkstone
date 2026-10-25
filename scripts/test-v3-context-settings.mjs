import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const { CONTEXT_TRIM_STEPS, AUTO_COMPACT_STEPS, DEFAULT_CONTEXT_TRIM_TOKENS, DEFAULT_AUTO_COMPACT_TOKENS, autoCompactAt, contextTrimAt, pickTokenStep } = limits
assert.deepEqual([...CONTEXT_TRIM_STEPS], [50_000, 80_000, 120_000, 200_000, 300_000], '裁剪档位与随包扩展一致')
assert.deepEqual([...AUTO_COMPACT_STEPS], [100_000, 250_000, 300_000, 400_000, 600_000, 800_000], '压缩档位与随包扩展一致')
assert.equal(autoCompactAt(400_000, 1_000_000), 400_000, '窗口足够时不提前')
assert.equal(autoCompactAt(400_000, 300_000), 270_000, '窗口小按 90% 提前')
assert.equal(autoCompactAt(400_000, 0), 400_000, '窗口未知时用设置值')
assert.equal(contextTrimAt(120_000, 300_000), 90_000, '裁剪线不超过窗口 30%')
assert.equal(contextTrimAt(80_000, 0), 80_000, '窗口未知时用设置值')
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
assert.deepEqual(
  SETTINGS_SECTIONS.map((section) => section.id),
  ['models', 'appearance', 'session', 'notifications', 'security', 'devices', 'data', 'shortcuts', 'about', 'capabilities'],
  '上下文并入会话与上下文分区'
)
assert.equal(isSettingsSectionId('context'), false, 'context 不再是独立分区')
assert.deepEqual(resolveLegacyView('context'), { kind: 'section', view: 'context', section: 'session' }, '旧深链接 context 落到会话与上下文分区')

const textMod = await loadTs('../src/renderer/src/features/settings/settings-text.ts')
const zh = textMod.settingsText('zh-CN')
const en = textMod.settingsText('en-US')
const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()
assert.deepEqual(zhKeys, enKeys, '中英文案键一一对应')
for (const key of ['sectionSession', 'contextAutoCompact', 'contextCompactAt', 'contextTrim', 'contextTrimAt', 'contextCompactNow', 'usageByDay', 'usageByModel', 'usageDailyCap']) {
  assert.ok(zh[key] && en[key], `文案键 ${key} 中英都有值`)
}
assert.ok(!/isSelected|checked/.test(zh.contextAutoCompact), '文案键不含控件属性')

const ctx = readFileSync(here('../src/renderer/src/features/settings/context/ContextSettings.tsx'), 'utf8')
for (const id of ['v3-context-settings', 'v3-ctx-compact-now', 'v3-ctx-used', 'v3-ctx-window']) {
  assert.ok(ctx.includes(id), `上下文页保留测试 id ${id}`)
}
assert.ok(ctx.includes("from '../../../ui'"), '上下文页控件来自 v3 ui/')
for (const forbidden of ['components/ui', 'components/settings', "'../../../styles", '@fontsource']) {
  assert.ok(!ctx.includes(forbidden), `上下文页不引入旧值依赖 ${forbidden}`)
}
for (const action of ['patchSettings', 'setAutoCompaction', 'compact']) {
  assert.ok(ctx.includes(action), `上下文页复用现有 store 动作 ${action}`)
}
assert.ok(ctx.includes('AUTO_COMPACT_STEPS') && ctx.includes('CONTEXT_TRIM_STEPS'), '上下文页复用 shared 档位')
assert.ok(ctx.includes('isSelected'), '开关用 RAC 的 isSelected 受控属性')
assert.ok(!ctx.includes('checked='), '不混用 v2 的 checked 属性')
assert.ok(!ctx.includes('window.yan'), '上下文页不直接调用 IPC')
const infoHook = readFileSync(here('../src/renderer/src/features/settings/context/use-compaction-info.ts'), 'utf8')
assert.deepEqual([...infoHook.matchAll(/window\.yan\.(\w+)/g)].map((m) => m[1]), ['compactionInfo'], '压缩说明只读一个只读接口')

const session = readFileSync(here('../src/renderer/src/features/settings/general/SessionSettings.tsx'), 'utf8')
assert.ok(session.includes('<ContextSettings'), '会话与上下文分区挂载上下文组件')
const root = readFileSync(here('../src/renderer/src/features/settings/root/SettingsPage.tsx'), 'utf8')
assert.ok(root.includes("section === 'session'"), '根页渲染会话与上下文分支')
assert.ok(!root.includes('ContextSettings'), '根页不再单独渲染上下文分区')
assert.ok(!root.includes('components/settings'), '根页不引入 v2 旧设置组件')

console.log('v3 上下文设置 / 用量图表：阈值、分组、深链接、文案与源码契约检查通过')
