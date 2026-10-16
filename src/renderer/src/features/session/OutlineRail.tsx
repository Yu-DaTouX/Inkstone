import { useMemo, type CSSProperties, type JSX } from 'react'
import { useT } from '../../i18n'
import type { UIMessage } from '../../../../shared/ipc'
import { createOutlineProjector } from '../../../../shared/outline-turns'
import './rail.css'

export function userTurnRenderIndex(turns: readonly { kind: string }[], userIndex: number): number | undefined {
  const userTurns: number[] = []
  turns.forEach((turn, index) => {
    if (turn.kind === 'user') userTurns.push(index)
  })
  return userTurns[userIndex]
}

export interface OutlineRailProps {
  messages: UIMessage[]
  streamingId?: string
  onJump: (index: number) => void
  className?: string
}

export function OutlineRail({ messages, streamingId, onJump, className }: OutlineRailProps): JSX.Element | null {
  const t = useT()
  const projectOutline = useMemo(() => createOutlineProjector(), [])
  const turns = useMemo(() => projectOutline(messages, streamingId), [messages, streamingId, projectOutline])

  if (turns.length === 0) return null

  return (
    <div className={`v3-rail ${className ?? ''}`.trim()} data-testid="v3-outline-rail">
      <div className="v3-rail-zone" data-testid="v3-outline-zone" aria-hidden />
      <div className="v3-rail-track" role="navigation" aria-label={t('outline.label')}>
        {turns.map((turn, index) => (
          <button
            key={turn.msgId}
            type="button"
            className="v3-rail-tick"
            data-testid="v3-outline-tick"
            title={turn.user}
            aria-label={t('outline.tick', { n: index + 1 })}
            style={{ '--i': Math.min(index, 14) } as CSSProperties}
            onClick={() => onJump(index)}
          >
            <span className="v3-rail-bar" />
          </button>
        ))}
      </div>
    </div>
  )
}
