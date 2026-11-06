import type { JSX } from 'react'
import { useT } from '../../i18n'
import { Skeleton } from '../../ui'

export function SwitchSkeleton({ label }: { label: string }): JSX.Element {
  return (
    <div className="v3-switch-skeleton" role="status" aria-label={label} data-testid="v3-switch-skeleton">
      {[0, 1].map((round) => (
        <div key={round} className="v3-switch-skeleton__round">
          <Skeleton shape="rect" className="v3-switch-skeleton__ask" width="38%" height="var(--s-32)" />
          <Skeleton width="92%" />
          <Skeleton width="84%" />
          <Skeleton width="56%" />
        </div>
      ))}
    </div>
  )
}

export function PeerEmpty({ running }: { running: boolean }): JSX.Element {
  const t = useT()
  return (
    <div className="v3-empty">
      <p className="v3-empty-hint">{running ? t('chat.working') : ''}</p>
    </div>
  )
}
