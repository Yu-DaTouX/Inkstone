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
assert.equal(clampStepIndex(-1), 0, '未知步骤的索引 -1 被夹回首步，界面不会全隐藏')
assert.equal(nextStepIndex(5), 5, '最后一步不能再往后')
assert.equal(prevStepIndex(0), 0, '第一步不能再往前')
assert.equal(nextStepIndex(1), 2, '正常前进')
assert.equal(prevStepIndex(2), 1, '正常后退')
assert.equal(isFirstStep(0), true)
assert.equal(isLastStep(ONBOARDING_STEP_COUNT - 1), true)
assert.deepEqual(stepProgress(0), { n: 1, total: 6 }, '进度从 1 起')
assert.deepEqual(stepProgress(5), { n: 6, total: 6 }, '最后一步进度')

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
assert.equal(memo.get('yan.onboarded'), String(state.ONBOARDING_REVISION), '标记写入当前引导版本')
assert.equal(state.hasSeenOnboarding(), true)
assert.equal(state.shouldAutoWizard(), false, '看过之后不再自动打开')
memo.set('yan.onboarded', '1')
assert.equal(state.shouldAutoWizard(), true, '看过旧版引导的用户升级后再弹一次')
memo.set('yan.onboarded', String(state.ONBOARDING_REVISION + 1))
assert.equal(state.shouldAutoWizard(), false, '更新的引导版本标记不会被降级弹出')
state.resetOnboarded()
assert.equal(state.shouldAutoWizard(), true, '清掉标记后可重新打开')
delete globalThis.localStorage
assert.equal(state.hasSeenOnboarding(), false, '没有存储时按没看过处理')
assert.doesNotThrow(() => state.markOnboarded(), '无存储时标记不抛错')

const wizard = readFileSync(here('../src/renderer/src/features/onboarding/OnboardingWizard.tsx'), 'utf8')
assert.ok(!/credential|apiKey|auth\.json/.test(wizard) && !wizard.includes('window.yan'), '不读真实凭证、不新增 IPC')

console.log('v3 首次引导模块：步骤模型、看过标记检查通过')
