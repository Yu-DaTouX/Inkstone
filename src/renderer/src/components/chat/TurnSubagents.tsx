import { useStore } from '../../state/store'
import { selectSubagentRuns } from '../../state/subagent-view'
import type { AssistantTurn } from '../../../../shared/turns'
import { SubagentGroup } from './SubagentCards'

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
