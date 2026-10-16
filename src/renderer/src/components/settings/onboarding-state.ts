const SEEN_KEY = 'yan.onboarded'

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
  }
}

export function shouldAutoWizard(): boolean {
  return !hasSeenOnboarding()
}
