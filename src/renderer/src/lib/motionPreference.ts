import { prefersReducedMotion, subscribeReducedMotion } from './reduced-motion'

export function installMotionPreferenceReporter(): () => void {
  let last: boolean | null = null
  const report = (): void => {
    const reduced = prefersReducedMotion()
    if (reduced === last) return
    last = reduced
    try {
      window.yan.setMotionPreference(reduced)
    } catch {
    }
  }
  report()
  return subscribeReducedMotion(report)
}
