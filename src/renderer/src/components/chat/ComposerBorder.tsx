import { useStore } from '../../state/store'
import { useRunProgress } from './run-status'

export function ComposerBorder() {
  const progress = useRunProgress()
  const level = useStore((s) => s.session?.thinkingLevel ?? 'off')
  return (
    <div
      className="cborder"
      data-level={level}
      data-state={progress ? 'working' : 'idle'}
      data-phase={progress?.phase ?? 'idle'}
      data-testid="composer-border"
      aria-hidden
    />
  )
}

export function ComposerBorderIdle() {
  return <div className="cborder" data-state="idle" data-phase="idle" aria-hidden />
}
