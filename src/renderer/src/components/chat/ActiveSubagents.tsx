import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { activeSubagentRuns, subagentScopeForView } from '../../state/subagent-view'
import { subagentOutcome } from '../../../../shared/subagent-outcome'
import { Button } from '../ui'

/**
 * 输入框上方常驻的「运行中 / 需处理」子代理概览。
 *
 * 用户反馈：同一 child 在原回合卡和输入框上方各出现一次，输入区被第二套卡片撑高。
 * 这里只投影**一行**概览（运行中 a · 需处理 b）加一个查看入口，不渲染任何
 * `SubagentGroup` 卡片，也不把历史卡复制到最新消息处；原回合历史卡照旧保留。
 *
 * 查看沿现行工作区入口：
 *   · 只有一个任务时派 `inkstone-agent-open`（`subagent:<id>`），由 `RightPanel`
 *     监听并打开既有 `SubagentPanel` 的运行详情；
 *   · 多个任务时派 `inkstone-workspace-launch`（`agents`），打开既有面板的总览
 *     （列表 + 派活表单），不在这里再长出一份列表。
 *
 * 归属取**当前显示视图**（peek 优先，与 `split-view.displayedSessionOf` 同一语义），
 * 不拿 `activeRunnerId` 猜：`parentSessionId` 命中当前视图的留下；旧记录没有归属
 * 字段时，只要挂在这个视图的运行实例下（`parentRunId` 命中）也留下，避免漏掉
 * 正在跑的子代理。正常结束（`done` 无待审阅、被停止）随后续快照自动撤下。
 */
export function ActiveSubagents() {
  const t = useT()
  const runs = useStore((s) => s.subagents)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const sessionId = useStore((s) => s.session?.sessionId)
  const sessionFile = useStore((s) => s.session?.sessionFile)
  const conversationId = useStore((s) => s.session?.conversationId)
  const runners = useStore((s) => s.runners)

  /* 屏幕正在显示哪条会话：peek 优先，与 displayedSessionOf 同一口径；运行实例
     也按这条会话找，不拿 activeRunnerId 猜（后台查看 B 时 active 还是 A）。 */
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
  /* 单任务直接开它的运行详情；多任务开既有面板总览（列表），不在这里铺第二套列表。 */
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
