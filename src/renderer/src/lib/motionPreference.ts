export function installMotionPreferenceReporter(): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const report = (): void => {
    try {
      window.yan.setMotionPreference(media.matches)
    } catch {
    }
  }
  report()
  media.addEventListener('change', report)
  return () => media.removeEventListener('change', report)
}
