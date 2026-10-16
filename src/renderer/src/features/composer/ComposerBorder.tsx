import { useStore } from '../../state/store'

/**
 * 输入框顶边。
 *
 * v2 的顶边内嵌「阶段文字 + 计时」，v3 只保留一条装饰边：空闲时整条不可见，
 * `data-state='working'` 时才按 `data-level` 的档位色亮起（与模型菜单里的小点、
 * 档位字同一套档位色）。`data-phase` 是运行钩子，供样式与诊断读取，不常驻文字。
 * 阶段文字与计时在回合活动行上，不在这里重复。
 */
export function ComposerBorder() {
  const level = useStore((s) => s.session?.thinkingLevel ?? 'off')
  const phase = useStore((s) => {
    if (s.session?.isCompacting) return 'compacting'
    if (s.session?.isStreaming) return 'responding'
    if (s.session?.isAgentRunning) return 'running'
    return 'idle'
  })
  return (
    <div
      className="cborder"
      data-level={level}
      data-state={phase === 'idle' ? 'idle' : 'working'}
      data-phase={phase}
      data-testid="composer-border"
      aria-hidden
    />
  )
}
