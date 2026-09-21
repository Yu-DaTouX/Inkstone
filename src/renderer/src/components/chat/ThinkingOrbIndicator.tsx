import { ThinkingOrb, type OrbState } from 'thinking-orbs'

/**
 * Yan 的小型运行态指示器。
 *
 * thinking-orbs 的 20px preset 是为行内文字调过的，不把 64px 的头像
 * 设计硬缩小。主题使用 auto，让它跟随 <html data-theme>，也能响应主题
 * 切换时的属性变化；prefers-reduced-motion 由依赖自身处理为静态帧。
 */
export function ThinkingOrbIndicator({
  state = 'working',
  className
}: {
  state?: OrbState
  className?: string
}) {
  return (
    <ThinkingOrb
      state={state}
      size={20}
      theme="auto"
      className={['thinking-orb', className].filter(Boolean).join(' ')}
      aria-hidden="true"
    />
  )
}
