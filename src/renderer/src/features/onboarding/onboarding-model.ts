export const ONBOARDING_STEP_IDS = ['welcome', 'theme', 'sound', 'auth', 'context', 'done'] as const

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number]

export type OnboardingStepKind = 'intro' | 'setting' | 'auth' | 'outro'

export interface OnboardingStepDef {
  readonly id: OnboardingStepId
  readonly kind: OnboardingStepKind
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

export function stepProgress(index: number): { n: number; total: number } {
  return { n: clampStepIndex(index) + 1, total: ONBOARDING_STEP_COUNT }
}
