/**
 * v3 设置页（WP-43 / S0）的局部检查。
 *
 * 只做两件不启动 Electron / 不读用户设置 / 不调模型的事：
 *   1. 用 esbuild 编译纯逻辑（旧深链接映射、用量展示数值），在 Node 里断言；
 *   2. 静态检查 S0 源码仍保留约定的测试 id 与子模块入口、没引入 v2 旧设置组件。
 *
 * 可独立执行：node scripts/test-v3-settings.mjs
 */
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

/* ── 1. 旧深链接 → v3 分区（纯逻辑） ───────────────────────── */
const types = await loadTs('../src/renderer/src/features/settings/types.ts')
const { SETTINGS_SECTIONS, DEFAULT_SETTINGS_SECTION, isSettingsSectionId, resolveLegacyView } = types

assert.deepEqual(
  SETTINGS_SECTIONS.map((section) => section.id),
  ['appearance', 'session', 'notifications', 'context', 'models', 'capabilities', 'security', 'devices', 'data', 'usage', 'shortcuts', 'about', 'sync'],
  '分区顺序按 02§10.6：外观、会话、通知、上下文、模型、能力、权限、设备、数据、用量、快捷键、关于，同步追加在最后'
)
assert.ok(
  SETTINGS_SECTIONS.every((section) => typeof section.icon === 'string' && section.icon),
  '每个分区都有图标 id'
)
assert.equal(DEFAULT_SETTINGS_SECTION, 'appearance', '外观是默认页')

const mappedCases = [
  ['appearance', 'appearance'],
  ['input', 'appearance'],
  ['sound', 'appearance'],
  ['context', 'context'],
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
/* G1 落盘六个通用分区后，已知 v2 旧页都能落到 v3 分区，不再有 unmigrated。 */
for (const view of []) {
  assert.equal(resolveLegacyView(view).kind, 'unmigrated', `${view} 已知旧页但 v3 未迁移`)
  assert.equal(resolveLegacyView(view).view, view)
}
for (const view of ['nonsense', '', '   ']) {
  assert.equal(resolveLegacyView(view).kind, 'unknown', `未知页「${view}」如实提示`)
}
assert.equal(resolveLegacyView(undefined).kind, 'unknown')
assert.equal(resolveLegacyView(null).kind, 'unknown')
assert.equal(isSettingsSectionId('usage'), true)
assert.equal(isSettingsSectionId('auth'), false)

/* ── 2. 用量展示数值（纯逻辑） ─────────────────────────────── */
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

/* ── 3. S0 源码契约（静态） ────────────────────────────────── */
const appearance = readFileSync(here('../src/renderer/src/features/settings/appearance/AppearanceSettings.tsx'), 'utf8')
for (const id of ['v3-theme-light', 'v3-theme-dark', 'v3-switch-v2']) {
  assert.ok(appearance.includes(id), `外观页保留测试 id ${id}`)
}
assert.ok(appearance.includes('uiVersionEnv'), '外观页保留环境变量固定 v3 的提示逻辑')
assert.ok(appearance.includes("patchSettings({ theme:"), '主题改动来自用户点击')
assert.ok(!appearance.includes('components/settings'), '外观页不引入 v2 旧设置组件')

const panel = readFileSync(here('../src/renderer/src/app/SettingsPanelV3.tsx'), 'utf8')
assert.ok(panel.includes('installSettingsDeepLink'), '入口安装正式 openSettings 订阅')
assert.ok(panel.includes('onBack') && panel.includes('onRuns'), '入口保持 { onBack, onRuns } 签名')
assert.ok(!panel.includes('components/settings'), '入口不引入 v2 旧设置组件')

const root = readFileSync(here('../src/renderer/src/features/settings/root/SettingsPage.tsx'), 'utf8')
assert.ok(root.includes("import.meta.glob('../models/index"), '按 S1 入口懒加载模型分区')
assert.ok(root.includes("import.meta.glob('../capabilities/index"), '按 S2 入口懒加载能力分区')
assert.ok(root.includes('ModelsSettings') && root.includes('CapabilitiesSettings'), '按约定导出名挂载')
assert.ok(root.includes('settings-missing'), '子模块未落盘时给出明确提示')
assert.ok(!root.includes('components/settings'), '根页不引入 v2 旧设置组件')

console.log('v3 设置：旧深链接映射 / 用量数值 / 分区入口与测试 id 检查通过')
