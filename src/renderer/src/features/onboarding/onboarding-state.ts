export const ONBOARDED_STORAGE_KEY = 'yan.onboarded'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function hasSeenOnboarding(): boolean {
  try {
    return storage()?.getItem(ONBOARDED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function markOnboarded(): void {
  try {
    storage()?.setItem(ONBOARDED_STORAGE_KEY, '1')
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
