/**
 * v3 首次引导模块入口。
 *
 * 外壳侧只需要两件事：
 *   · 启动判断：`shouldAutoWizard()`（与主区 `components/settings/onboarding-state.ts`
 *     同键，读 `yan.onboarded`）；
 *   · 挂载组件：`<OnboardingWizard onClose={…} />`，关闭时调用 `markOnboarded()`。
 *
 * 真实挂载补丁见交付目录（主区 `.tmp/v3-ui/continuous/`），本模块不改外壳。
 */
export { OnboardingWizard, type OnboardingResult, type OnboardingWizardProps } from './OnboardingWizard'
export {
  hasSeenOnboarding,
  markOnboarded,
  shouldAutoWizard,
  resetOnboarded,
  ONBOARDED_STORAGE_KEY
} from './onboarding-state'
export {
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
  stepProgress,
  type OnboardingStepDef,
  type OnboardingStepId,
  type OnboardingStepKind
} from './onboarding-model'
export { onboardingText, type OnboardingText } from './onboarding-text'
