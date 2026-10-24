export const ONBOARDED_STORAGE_KEY = 'yan.onboarded'
export const ONBOARDING_REVISION = 2

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function hasSeenOnboarding(): boolean {
  try {
    return Number(storage()?.getItem(ONBOARDED_STORAGE_KEY)) >= ONBOARDING_REVISION
  } catch {
    return false
  }
}

export function markOnboarded(): void {
  try {
    storage()?.setItem(ONBOARDED_STORAGE_KEY, String(ONBOARDING_REVISION))
  } catch {
  }
}

export function shouldAutoWizard(): boolean {
  return !hasSeenOnboarding()
}

export function resetOnboarded(): void {
  try {
    storage()?.removeItem(ONBOARDED_STORAGE_KEY)
  } catch {
  }
}
