import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { activeSubagentRuns, subagentScopeForView } from '../../state/subagent-view'
import { subagentOutcome } from '../../../../shared/subagent-outcome'
import { Button } from '../ui'

export function ActiveSubagents() {
  const t = useT()
  const runs = useStore((s) => s.subagents)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const sessionId = useStore((s) => s.session?.sessionId)
  const sessionFile = useStore((s) => s.session?.sessionFile)
  const conversationId = useStore((s) => s.session?.conversationId)
  const runners = useStore((s) => s.runners)

  const mine = activeSubagentRuns(
    runs,
    subagentScopeForView({ peekedSessionId, peekedPath, session: { sessionId, sessionFile, conversationId }, runners })
  )
  if (!mine.length) return null
  const live = mine.filter((run) => subagentOutcome(run).live).length
  const attention = mine.length - live
  const summary = [
    live ? t('sa.group.live', { n: live }) : '',
    attention ? t('sa.group.attention', { n: attention }) : ''
  ].filter(Boolean).join(' · ')
  const open = () => {
    if (mine.length === 1) {
      window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: `subagent:${mine[0].id}` }))
      return
    }
    window.dispatchEvent(new CustomEvent('inkstone-workspace-launch', { detail: 'agents' }))
  }
  return (
    <div className="asg" data-testid="active-subagents">
      <div className="asg-head">
        <span className="asg-label">{t('sa.tag')}</span>
        <span className="asg-summary" role="status" data-testid="active-subagents-summary">
          {summary}
        </span>
        <Button size="sm" variant="ghost" onClick={open} data-testid="active-subagents-view">
          {t('sa.viewInWorkspace')}
        </Button>
      </div>
    </div>
  )
}
