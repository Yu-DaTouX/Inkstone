/**
 * 分支摘要行（WP-21c）。
 *
 * 只读显示当前视图这条会话「分叉自哪句话」（`SessionSummary.branchOrigin`）。
 * 分支导航与右侧面板「分支」页尚未迁移，所以这里不给切换入口 —— 不画一个
 * 点不动的控件。视图身份按 `view-state.ts` 的配对规则取，不回落运行实例。
 */
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
