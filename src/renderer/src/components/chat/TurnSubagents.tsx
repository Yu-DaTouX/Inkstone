import { useStore } from '../../state/store'
import { selectSubagentRuns } from '../../state/subagent-view'
import type { AssistantTurn } from '../../../../shared/turns'
import { SubagentGroup } from './SubagentCards'

/**
 * 挂在一个回合下面的子代理：`parentMessageId` 落在这个回合合并的任意一条助手消息上。
 * 同一回合并行启动的多个子代理排成一组，每个一行。
 */
export function TurnSubagents({ turn }: { turn: AssistantTurn }) {
  const runs = useStore((s) => s.subagents)
  const session = useStore((s) => s.session)
  if (!runs.length) return null
  const sessionIds = [session?.sessionId, session?.conversationId].filter((v): v is string => !!v)
  const ids = new Set([turn.id, ...turn.sourceIds])
  const mine = selectSubagentRuns(runs, { sessionIds }).all.filter(
    (run) => run.parentMessageId && ids.has(run.parentMessageId) && run.review !== 'merged' && run.review !== 'discarded'
  )
  if (!mine.length) return null
  return <SubagentGroup runs={[...mine].sort((a, b) => a.startedAt - b.startedAt)} />
}
