import { useStore } from '../../state/store'

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
