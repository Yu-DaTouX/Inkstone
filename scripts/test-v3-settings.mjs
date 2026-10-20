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
  SETTINGS_SECTIONS.map((section) => section.id),
  ['models', 'appearance', 'session', 'notifications', 'security', 'usage', 'devices', 'data', 'shortcuts', 'about', 'capabilities'],
  '11 个分区按导航分组排：设置（模型、外观与语言、会话与上下文、通知、权限、用量）、此电脑（手机与远程、数据与同步、快捷键、关于）、自定义（能力）'
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
  ['status', 'about']
]
for (const [view, section] of mappedCases) {
  assert.deepEqual(resolveLegacyView(view), { kind: 'section', view, section }, `${view} → ${section}`)
}
for (const view of []) {
  assert.equal(resolveLegacyView(view).kind, 'unmigrated', `${view} 已知旧页但 v3 未迁移`)
  assert.equal(resolveLegacyView(view).view, view)
}
for (const view of ['nonsense', '', '   ']) {
  assert.equal(resolveLegacyView(view).kind, 'unknown', `未知页「${view}」如实提示`)
}
assert.equal(resolveLegacyView(undefined).kind, 'unknown')
assert.equal(resolveLegacyView(null).kind, 'unknown')
const { groupSettingsSections, groupSettingsNav, settingsNavEntries, settingsViewFromHash, SETTINGS_NAV_GROUPS, CAPABILITIES_TABS } = types
assert.deepEqual([...SETTINGS_NAV_GROUPS], ['general', 'local', 'customize'], '导航分三组：设置 / 此电脑 / 自定义')
assert.deepEqual(
  groupSettingsSections().map((entry) => [entry.group, entry.sections.map((section) => section.id)]),
  [
    ['general', ['models', 'appearance', 'session', 'notifications', 'security', 'usage']],
    ['local', ['devices', 'data', 'shortcuts', 'about']],
    ['customize', ['capabilities']]
  ],
  '分组保持分区顺序，能力页单独一组'
)
assert.deepEqual([...CAPABILITIES_TABS], ['skills', 'mcp', 'tools', 'market'], '能力页四个子页')
assert.deepEqual(
  groupSettingsNav().map((entry) => [entry.group, entry.entries.map((item) => item.key)]),
  [
    ['general', ['models', 'appearance', 'session', 'notifications', 'security', 'usage']],
    ['local', ['devices', 'data', 'shortcuts', 'about']],
    ['customize', ['capabilities-skills', 'capabilities-mcp', 'capabilities-tools', 'capabilities-market']]
  ],
  '导航条目：能力页拆成四个子页条目放在自定义组'
)
assert.ok(
  settingsNavEntries().every((entry) => (entry.section === 'capabilities') === (entry.tab !== undefined) && entry.icon),
  '只有能力子页带 tab，每个条目都有图标'
)
assert.deepEqual(
  groupSettingsSections().flatMap((entry) => entry.sections.map((section) => section.id)),
  SETTINGS_SECTIONS.map((section) => section.id),
  '分组拼接后与分区清单一致'
)
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
const { compactNumber, modelShare, shareText, peakHourText, USAGE_RANGES } = usage
assert.deepEqual([...USAGE_RANGES], ['all', '30d', '7d'], '范围取值与后端一致')
assert.equal(compactNumber(0), '0')
assert.equal(compactNumber(-5), '0')
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
assert.equal(peakHourText(9), '09:00')
assert.equal(peakHourText(0), '00:00')
assert.equal(peakHourText(null), null)
assert.equal(peakHourText(24), null)

const appearance = readFileSync(here('../src/renderer/src/features/settings/appearance/AppearanceSettings.tsx'), 'utf8')
for (const id of ['v3-theme-light', 'v3-theme-dark']) {
  assert.ok(appearance.includes(id), `外观页保留测试 id ${id}`)
}
assert.ok(!appearance.includes('uiVersion') && !appearance.includes('v3-switch-v2'), '外观页不再有界面版本切换')
assert.ok(appearance.includes("patchSettings({ theme:"), '主题改动来自用户点击')
assert.ok(!appearance.includes('components/settings'), '外观页不引入 v2 旧设置组件')

const panel = readFileSync(here('../src/renderer/src/app/SettingsPanelV3.tsx'), 'utf8')
assert.ok(panel.includes('installSettingsDeepLink'), '入口安装正式 openSettings 订阅')
assert.ok(panel.includes('onShowOnboarding'), '入口保持 { onShowOnboarding } 签名')
assert.ok(panel.includes('settingsOpen') && panel.includes('closeSettings'), '设置弹层由 store.settingsOpen 打开、closeSettings 关闭')
assert.ok(panel.includes('consumeSettingsHash'), '#/settings 深链改为打开弹层')
const shell = readFileSync(here('../src/renderer/src/app/ShellV3.tsx'), 'utf8')
assert.ok(!shell.includes("navigate({ name: 'settings' })"), '外壳不再导航到设置整页路由')
assert.ok(shell.includes('<SettingsPanelV3'), '外壳常驻挂载设置弹层宿主')
assert.ok(!panel.includes('components/settings'), '入口不引入 v2 旧设置组件')

const root = readFileSync(here('../src/renderer/src/features/settings/root/SettingsPage.tsx'), 'utf8')
assert.ok(root.includes("import.meta.glob('../models/index"), '按 S1 入口懒加载模型分区')
assert.ok(root.includes("import.meta.glob('../capabilities/index"), '按 S2 入口懒加载能力分区')
assert.ok(root.includes('ModelsSettings') && root.includes('CapabilitiesSettings'), '按约定导出名挂载')
assert.ok(root.includes('settings-missing'), '子模块未落盘时给出明确提示')
assert.ok(!root.includes('components/settings'), '根页不引入 v2 旧设置组件')

console.log('v3 设置：旧深链接映射 / 用量数值 / 分区入口与测试 id 检查通过')
