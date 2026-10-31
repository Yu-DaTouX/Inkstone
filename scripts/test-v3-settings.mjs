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

const types = await loadTs('../src/renderer/src/features/settings/types.ts')
const { SETTINGS_SECTIONS, DEFAULT_SETTINGS_SECTION, isSettingsSectionId, resolveLegacyView } = types

assert.deepEqual(
  [...SETTINGS_SECTIONS.map((section) => section.id)].sort(),
  ['about', 'appearance', 'capabilities', 'code', 'data', 'devices', 'models', 'notifications', 'security', 'session', 'shortcuts'],
  '分区清单完整，上下文并入会话分区、用量不再单列'
)
assert.ok(
  SETTINGS_SECTIONS.every((section) => typeof section.icon === 'string' && section.icon),
  '每个分区都有图标 id'
)
assert.equal(DEFAULT_SETTINGS_SECTION, 'models', '模型是默认页')

const mappedCases = [
  ['appearance', 'appearance'],
  ['input', 'appearance'],
  ['sound', 'appearance'],
  ['context', 'session'],
  ['sync', 'data'],
  ['auth', 'models'],
  ['models', 'models'],
  ['capabilities', 'capabilities'],
  ['voice', 'capabilities'],
  ['knowledge', 'capabilities'],
  ['packages', 'capabilities'],
  ['market', 'capabilities'],
  ['usage', 'usage'],
  ['workspace', 'session'],
  ['devices', 'devices'],
  ['remote', 'devices'],
  ['peer', 'devices'],
  ['about', 'about'],
  ['status', 'about'],
  ['git', 'code'],
  ['github', 'code']
]
for (const [view, section] of mappedCases) {
  assert.deepEqual(resolveLegacyView(view), { kind: 'section', view, section }, `${view} → ${section}`)
}
for (const view of ['nonsense', '', '   ']) {
  assert.equal(resolveLegacyView(view).kind, 'unknown', `未知页「${view}」如实提示`)
}
assert.equal(resolveLegacyView(undefined).kind, 'unknown')
assert.equal(resolveLegacyView(null).kind, 'unknown')
const { groupSettingsNav, settingsNavEntries, settingsViewFromHash, SETTINGS_NAV_GROUPS, CAPABILITIES_TABS } = types
assert.deepEqual([...CAPABILITIES_TABS], ['skills', 'mcp', 'tools', 'market'], '能力页四个子页')
assert.ok(
  settingsNavEntries().every((entry) => (entry.section === 'capabilities') === (entry.tab !== undefined) && entry.icon),
  '只有能力子页带 tab，每个条目都有图标'
)
assert.deepEqual(
  [...new Set(settingsNavEntries().map((entry) => entry.section))].sort(),
  SETTINGS_SECTIONS.map((section) => section.id).sort(),
  '导航条目覆盖全部分区'
)
assert.deepEqual(
  groupSettingsNav().flatMap((group) => group.entries.map((item) => item.key)).sort(),
  settingsNavEntries().map((entry) => entry.key).sort(),
  '分组后不丢条目'
)
assert.ok([...SETTINGS_NAV_GROUPS].every((group) => settingsNavEntries().some((entry) => entry.group === group)), '每个导航分组都有条目')
assert.equal(settingsViewFromHash('#/settings'), '', '#/settings 打开弹层不指定分区')
assert.equal(settingsViewFromHash('#settings'), '')
assert.equal(settingsViewFromHash('#/settings/models'), 'models', '#/settings/<分区> 定位分区')
assert.equal(settingsViewFromHash('#/settings/'), '')
assert.equal(settingsViewFromHash('#/settings/a/b'), null, '多段路径不是设置深链')
assert.equal(settingsViewFromHash('#/settings/%E0%A4%A'), null, '坏编码不抛错')
assert.equal(settingsViewFromHash('#/'), null)
assert.equal(settingsViewFromHash('#/schedule'), null)
assert.equal(settingsViewFromHash('#/settingsx'), null)
assert.equal(isSettingsSectionId('usage'), true)
assert.equal(isSettingsSectionId('auth'), false)

const usage = await loadTs('../src/renderer/src/features/settings/usage/usage-model.ts')
const fmt = await loadTs('../src/renderer/src/features/usage/usage-format.ts')
const { modelShare, peakHourText, USAGE_RANGES } = usage
const { compactNumber, shareText } = fmt
assert.deepEqual([...USAGE_RANGES], ['all', '30d', '7d'], '范围取值与后端一致')
assert.equal(compactNumber(0), '0')
assert.equal(compactNumber(-5), '0')
assert.equal(compactNumber(Number.NaN), '0', 'NaN 不显示成字面量')
assert.equal(compactNumber(Number.POSITIVE_INFINITY), '0')
assert.equal(compactNumber(999), '999')
assert.equal(compactNumber(10_000), '10K')
assert.equal(compactNumber(1_500_000), '1.5M')
assert.equal(compactNumber(1e9), '1.0B')
assert.equal(compactNumber(1e10), '10B')
assert.equal(modelShare(25, 100), 0.25)
assert.equal(modelShare(1, 0), 0, '总数为 0 不产生 NaN')
assert.equal(modelShare(200, 100), 1, '占比夹在 0–1')
assert.equal(shareText(0.25), '25%')
assert.equal(shareText(0.005), '<1%')
assert.equal(shareText(Number.NaN), '<1%', 'NaN 占比不显示成 NaN%')
assert.equal(peakHourText(9), '09:00')
assert.equal(peakHourText(0), '00:00')
assert.equal(peakHourText(null), null)
assert.equal(peakHourText(24), null)
const opusModels = [{ provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'claude-opus-5-5' }, { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }]
assert.equal(usage.usageModelName({ key: 'claude-opus-5-5', sources: ['anthropic/claude-opus-5-5', 'claude-bridge/claude-opus-5-5'] }, opusModels), 'Claude Opus 5.5', '合并模型优先显示带名称的供应商模型')
assert.equal(usage.usageModelName({ key: 'deepseek-v4.1-flash', sources: ['commandcode/deepseek/deepseek-v4.1-flash'] }, []), 'deepseek-v4.1-flash', '没有模型信息时显示去掉前缀的模型 ID')

console.log('v3 设置：旧深链接映射 / 用量数值 / 分区入口与测试 id 检查通过')

const syncTextModule = await loadTs('../src/renderer/src/features/settings/sync/text.ts')
const { syncText, syncNoteText, conflictsPendingText, conflictTitle } = syncTextModule
const zhSync = syncText('zh-CN')
const enSync = syncText('en-US')
assert.equal(conflictsPendingText(enSync, 1), '1 conflict waiting.', '单条冲突用单数')
assert.equal(conflictsPendingText(enSync, 3), '3 conflicts waiting.', '多条冲突用复数')
assert.equal(conflictsPendingText(zhSync, 1), '有 1 条冲突待处理。')
assert.equal(conflictTitle(zhSync, 'prompt:hello'), '提示词 · hello', '冲突标题显示可读类别与名称')
assert.equal(conflictTitle(enSync, 'skill:my-skill'), 'Skill · my-skill')
assert.equal(conflictTitle(enSync, 'settings'), 'Settings', '设置冲突只显示类别')
assert.equal(syncNoteText(enSync, { code: 'folder.missing', params: { path: 'D:/sync' } }), 'Sync folder not found: D:/sync')
assert.equal(syncNoteText(zhSync, { code: 'folder.missing', params: { path: 'D:/sync' } }), '同步文件夹不存在：D:/sync')
assert.equal(syncNoteText(zhSync, { code: 'sync.raw', params: { text: '旧版中文错误' } }), '旧版中文错误', '旧记录原样显示')
assert.equal(syncNoteText(enSync, undefined), '')

console.log('v3 同步设置文案：单复数 / 冲突可读名称 / 结构化错误码通过')
