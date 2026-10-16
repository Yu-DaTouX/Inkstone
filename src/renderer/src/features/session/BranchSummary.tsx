import type { JSX } from 'react'
import { useStore } from '../../state/store'
import { sessionViewIdentity } from './view-state'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { branchOriginOf } from './turn-lines'

export function BranchSummary(): JSX.Element | null {
  const tt = useSessionText()
  const sessions = useStore((s) => s.sessions)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const origin = branchOriginOf(sessions, view)
  if (!origin) return null
  return (
    <div className="v3-branchline" data-testid="v3-branch-summary">
      <Icon name="branch" size={13} />
      <span className="v3-branchline-text" title={origin}>{tt('branchFrom', { text: origin })}</span>
    </div>
  )
}
