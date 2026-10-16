/**
 * v3 首次引导模块的局部检查。
 *
 * 不启动 Electron / 不读用户设置 / 不调模型 / 不读任何凭证：
 *   1. 用 esbuild 编译纯逻辑（步骤模型、看过标记、双语文案）并断言；
 *   2. 静态检查向导仍用 v3 原语、现有 `patchSettings` 与正式 `openSettings`，
 *      没引入 v2 旧组件 / 旧样式，也没新增 IPC 或读凭据。
 *
 * 可独立执行：node scripts/test-v3-onboarding.mjs
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

/* ── 1. 步骤模型（纯逻辑） ─────────────────────────────────── */
const model = await loadTs('../src/renderer/src/features/onboarding/onboarding-model.ts')
const {
  ONBOARDING_STEP_IDS,
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEPS,
  clampStepIndex,
  isFirstStep,
  isLastStep,
  isSkippableStep,
  nextStepIndex,
  prevStepIndex,
  stepAt,
  stepIndexOf,
  stepProgress
} = model

assert.deepEqual(
  [...ONBOARDING_STEP_IDS],
  ['welcome', 'theme', 'sound', 'auth', 'context', 'done'],
  '六步顺序与主区向导一致'
)
assert.equal(ONBOARDING_STEP_COUNT, 6, '步数与步骤条一致')
assert.deepEqual(
  ONBOARDING_STEPS.filter((step) => step.skippable).map((step) => step.id),
  ['theme', 'sound', 'context'],
  '可跳过的三步是外观 / 提醒 / 上下文'
)
assert.equal(isSkippableStep(stepIndexOf('auth')), false, '模型接入是必需项，不可单独跳过')

assert.equal(stepIndexOf('context'), 4, '步骤名 → 索引')
assert.equal(stepIndexOf('nope'), -1, '未知步骤返回 -1，界面不会误认')
assert.equal(stepAt(99).id, 'done', '越界索引夹到最后一步')
assert.equal(stepAt(-3).id, 'welcome', '负索引夹到第一步')
assert.equal(clampStepIndex(Number.NaN), 0, 'NaN 归零')
assert.equal(nextStepIndex(5), 5, '最后一步不能再往后')
assert.equal(prevStepIndex(0), 0, '第一步不能再往前')
assert.equal(nextStepIndex(1), 2, '正常前进')
assert.equal(prevStepIndex(2), 1, '正常后退')
assert.equal(isFirstStep(0), true)
assert.equal(isLastStep(ONBOARDING_STEP_COUNT - 1), true)
assert.deepEqual(stepProgress(0), { n: 1, total: 6 }, '进度从 1 起')
assert.deepEqual(stepProgress(5), { n: 6, total: 6 }, '最后一步进度')

/* ── 2. 看过标记（纯逻辑 + 桩 localStorage） ──────────────── */
const memo = new Map()
globalThis.localStorage = {
  getItem: (key) => (memo.has(key) ? memo.get(key) : null),
  setItem: (key, value) => memo.set(key, String(value)),
  removeItem: (key) => memo.delete(key)
}
const state = await loadTs('../src/renderer/src/features/onboarding/onboarding-state.ts')
assert.equal(state.ONBOARDED_STORAGE_KEY, 'yan.onboarded', '沿用主区同一个键')
assert.equal(state.hasSeenOnboarding(), false, '初始没看过')
assert.equal(state.shouldAutoWizard(), true, '没看过就自动打开')
state.markOnboarded()
assert.equal(memo.get('yan.onboarded'), '1', '标记写的是同一个键值')
assert.equal(state.hasSeenOnboarding(), true)
assert.equal(state.shouldAutoWizard(), false, '看过之后不再自动打开')
// 主区旧探针直接写同一个键，也要认
memo.set('yan.onboarded', '1')
assert.equal(state.shouldAutoWizard(), false, '旧探针的 setItem 也能压住弹窗')
state.resetOnboarded()
assert.equal(state.shouldAutoWizard(), true, '清掉标记后可重新打开')
// 没有 localStorage 时不抛错，按「没看过」处理
delete globalThis.localStorage
assert.equal(state.hasSeenOnboarding(), false, '没有存储时按没看过处理')
assert.doesNotThrow(() => state.markOnboarded(), '无存储时标记不抛错')

/* ── 3. 双语文案齐全、占位符一致 ──────────────────────────── */
const textMod = await loadTs('../src/renderer/src/features/onboarding/onboarding-text.ts')
const zh = textMod.onboardingText('zh-CN')
const en = textMod.onboardingText('en-US')
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '中英键一一对应')
const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
for (const key of Object.keys(zh)) {
  assert.equal(typeof zh[key], 'string', `zh.${key} 是字符串`)
  assert.ok(zh[key].length > 0, `zh.${key} 非空`)
  assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} 的中英占位符一致`)
}
for (const key of ['stepOf', 'contextNow', 'contextClamped']) {
  assert.ok(placeholders(zh[key]).length > 0, `${key} 带占位符`)
}
assert.ok(zh.authDesc.includes('不会读取'), '模型接入说明写明不读取已保存登录')
assert.ok(/credential/i.test(en.authDesc) || /does not read/i.test(en.authDesc), '英文同样说明不读凭证')

/* ── 4. 向导源码契约（静态） ───────────────────────────────── */
const wizard = readFileSync(here('../src/renderer/src/features/onboarding/OnboardingWizard.tsx'), 'utf8')
const css = readFileSync(here('../src/renderer/src/features/onboarding/onboarding.css'), 'utf8')
const barrel = readFileSync(here('../src/renderer/src/features/onboarding/index.ts'), 'utf8')

assert.ok(wizard.includes("from '../../ui'"), '向导控件来自 v3 ui/')
assert.ok(wizard.includes("'./onboarding.css'"), '向导自带 features 层样式')
for (const primitive of ['Dialog', 'ModalOverlay', 'Button', 'Switch', 'RadioGroup', 'Select', 'Slider']) {
  assert.ok(wizard.includes(primitive), `向导使用 v3 原语 ${primitive}`)
}
assert.ok(wizard.includes('patchSettings'), '每步落盘走现有 patchSettings')
assert.ok(wizard.includes('autoCompactTokens') && wizard.includes('theme') && wizard.includes('sound'), '落盘字段是现有设置键')
assert.ok(wizard.includes('AUTO_COMPACT_STEPS') && wizard.includes('DEFAULT_AUTO_COMPACT_TOKENS'), '上下文档位复用 shared，未自造缺省')
assert.ok(wizard.includes("openSettings('models')"), '模型接入只引导到设置 → 模型')
assert.ok(wizard.includes("onClose('skip')") && wizard.includes("onClose('done')"), '区分跳过与完成结果')
assert.ok(wizard.includes('isSelected'), '开关用 RAC 的 isSelected 受控属性')
assert.ok(wizard.includes('selectedKey'), '下拉用 RAC 的 selectedKey 受控属性')
assert.ok(!wizard.includes('checked='), '不混用 v2 的 checked 属性')
assert.ok(!wizard.includes('authProviders') && !wizard.includes('window.yan'), '不读真实凭证、不新增 IPC')
assert.ok(!/fetch\(/.test(wizard), '不发网络请求')

/* ── 4b. 声音滑杆用正式 ui Slider，按 SoundSettings.volume 精确换算 ── */
assert.ok(wizard.includes("from '../../ui/Slider'"), '音量用 v3 Slider 原语（ui 汇总导出后改走 barrel）')
assert.ok(wizard.includes("import '../../ui/Slider.css'"), '原语样式随组件引入，不自建滑杆外观')
for (const token of ['minValue={0}', 'maxValue={1}', 'step={0.05}']) {
  assert.ok(wizard.includes(token), `音量范围对齐 SoundSettings.volume 0~1：${token}`)
}
assert.ok(wizard.includes('isDisabled={!sound.enabled}'), '声音总开关关闭时滑杆禁用')
assert.ok(wizard.includes('aria-label={text.soundVolume}'), '滑杆有可读名称')
assert.ok(wizard.includes('Math.round(shown * 100)'), '音量按 0~1 换算成百分比显示')
assert.ok(
  /patchSettings\(\{\s*sound:\s*\{\s*\.\.\.sound,\s*volume:/.test(wizard),
  'RAC 值回调落盘走既有 patchSettings（只改 volume）'
)
assert.ok(wizard.includes('onChangeEnd'), '拖动 / 按键结束时用 RAC onChangeEnd 落盘')
assert.ok(!wizard.includes('type="range"') && !wizard.includes('.v3-ob-range'), '不再保留原生 range 控件')
assert.ok(!wizard.includes('previewSound'), '引导不试听系统通知 / 提示音')
assert.ok(!css.includes('.v3-ob-range'), '旧原生 range 外观规则已移除')
assert.ok(css.includes('.v3-ob-slider'), '滑杆只在行内限定占位')

for (const forbidden of ["components/ui", "components/settings", "../styles", "../../styles", '@fontsource', 'useT(']) {
  assert.ok(!wizard.includes(forbidden), `向导不引入旧值依赖 ${forbidden}`)
}

for (const id of [
  'v3-ob-step-',
  'v3-ob-panel-',
  'v3-ob-progress',
  'v3-ob-back',
  'v3-ob-next',
  'v3-ob-done',
  'v3-ob-theme-light',
  'v3-ob-sound-toggle',
  'v3-ob-ctx-now',
  'v3-ob-open-models'
]) {
  assert.ok(wizard.includes(id) || css.includes(id), `保留稳定测试 id ${id}`)
}

/* ── 5. 样式只落在 features 层，不自建控件外观 ────────────── */
assert.ok(css.startsWith('@layer features {'), '样式落在 features 层')
assert.ok(!/\.v3-ob-[\w-]*(?:-btn|-tab|-chip)\b/.test(css), '不为步骤条/页脚新建控件类')
assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'CSS 不写死色值，全部引用 token')

/* ── 6. 模块入口导出 ──────────────────────────────────────── */
for (const name of [
  'OnboardingWizard',
  'shouldAutoWizard',
  'markOnboarded',
  'hasSeenOnboarding',
  'ONBOARDING_STEP_IDS',
  'onboardingText'
]) {
  assert.ok(barrel.includes(name), `入口导出 ${name}`)
}

console.log('v3 首次引导模块：步骤模型、看过标记、双语文案与源码契约检查通过')
