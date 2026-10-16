/**
 * 首次引导的纯步骤模型。
 *
 * 与主区六步向导同一套步骤顺序（开始 / 外观 / 提醒 / 模型接入 / 上下文 / 功能入口），
 * 但只用纯数据描述，不依赖 React / store / DOM，供界面与本地小测试共用。
 *
 * 每步的「可跳过」语义来自方案 D14：外观、提醒、上下文可跳过，模型接入是必需项。
 * `welcome` / `done` 是介绍与收尾，没有要落的设置。
 */

export const ONBOARDING_STEP_IDS = ['welcome', 'theme', 'sound', 'auth', 'context', 'done'] as const

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number]

export type OnboardingStepKind = 'intro' | 'setting' | 'auth' | 'outro'

export interface OnboardingStepDef {
  readonly id: OnboardingStepId
  readonly kind: OnboardingStepKind
  /** 能否用「跳过此步」直接前进；必需项不给跳过按钮（仍可关掉整个向导）。 */
  readonly skippable: boolean
}

export const ONBOARDING_STEPS: readonly OnboardingStepDef[] = [
  { id: 'welcome', kind: 'intro', skippable: false },
  { id: 'theme', kind: 'setting', skippable: true },
  { id: 'sound', kind: 'setting', skippable: true },
  { id: 'auth', kind: 'auth', skippable: false },
  { id: 'context', kind: 'setting', skippable: true },
  { id: 'done', kind: 'outro', skippable: false }
]

export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length

/** 把任意索引夹进 [0, count-1]，越界不抛错。 */
export function clampStepIndex(index: number): number {
  if (!Number.isFinite(index)) return 0
  const i = Math.trunc(index)
  if (i < 0) return 0
  if (i >= ONBOARDING_STEP_COUNT) return ONBOARDING_STEP_COUNT - 1
  return i
}

export function stepAt(index: number): OnboardingStepDef {
  return ONBOARDING_STEPS[clampStepIndex(index)]
}

export function stepIndexOf(id: OnboardingStepId): number {
  return ONBOARDING_STEP_IDS.indexOf(id)
}

export function nextStepIndex(index: number): number {
  return clampStepIndex(clampStepIndex(index) + 1)
}

export function prevStepIndex(index: number): number {
  return clampStepIndex(clampStepIndex(index) - 1)
}

export function isFirstStep(index: number): boolean {
  return clampStepIndex(index) === 0
}

export function isLastStep(index: number): boolean {
  return clampStepIndex(index) === ONBOARDING_STEP_COUNT - 1
}

export function isSkippableStep(index: number): boolean {
  return stepAt(index).skippable
}

/** 第 n / total 步（从 1 起），给步骤条与页脚显示。 */
export function stepProgress(index: number): { n: number; total: number } {
  return { n: clampStepIndex(index) + 1, total: ONBOARDING_STEP_COUNT }
}
