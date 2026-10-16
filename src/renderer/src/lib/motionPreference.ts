/**
 * 减少动态效果上报（L12）。
 *
 * 主进程没有等价的 prefers-reduced-motion API（`nativeTheme` 没有 shouldUseReducedMotion，
 * `isAccessibilitySupportEnabled` 也不是同一回事），所以由渲染端这条真实通路把系统偏好
 * 上报给宿主：挂载时上报一次，matchMedia change 时再上报。主进程只在上报后才允许托盘
 * 动画，未上报前保持静态。
 */
export function installMotionPreferenceReporter(): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const report = (): void => {
    try {
      window.yan.setMotionPreference(media.matches)
    } catch {
      /* 桥在极早期可能未就绪；下一次 change 会补报 */
    }
  }
  report()
  media.addEventListener('change', report)
  return () => media.removeEventListener('change', report)
}
