import { useMemo, type JSX } from 'react'
import { Badge } from '../../ui'
import { Card, CardHead, CardTitle } from '../../ui/Card'
import type { AssistantTurn } from '../../../../shared/turns'
import { TurnChanges } from './TurnChanges'
import { useStore } from '../../state/store'
import { Markdown } from './Markdown'
import { useSessionText } from './text'
import { decisionTitle, outcomeFiles, replyFileLinks, type DecisionOutcome } from './turn-outcome'
import { WrapUpText } from './WrapUpCard'
import type { TurnChanges as TurnChangeSet } from './turn-changes'
import './turn-outcome.css'

const OUTCOME_TEXT = { running: 'decisionRunning', failed: 'decisionFailed', stopped: 'decisionStopped' } as const

export function DecisionBlock({ question, sourceCwd, sessionId, messageId, answer, outcome = null, arrive = false }: {
  arrive?: boolean
  question: string
  sourceCwd?: string
  sessionId: string | null
  messageId: string
  answer: string | null
  outcome?: DecisionOutcome | null
}): JSX.Element {
  const tt = useSessionText()
  const answered = answer !== null
  const status = answered ? tt('decisionReplied') : tt('wrapUpDecide')
  const { title, rest } = useMemo(() => decisionTitle(question), [question])
  const heading = title ? plainTitle(title) : ''
  const reply = answer?.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const result = !outcome ? '' : outcome.state === 'done' ? outcome.text : tt(OUTCOME_TEXT[outcome.state])
  return (
    <Card as="section" padding="none" receipt={answered} className="v3-decision" data-state={answered ? 'answered' : 'open'} data-arrive={arrive ? '' : undefined} aria-label={heading.replace(/`/g, '') || status} data-testid="v3-decision">
      <CardHead className="v3-decision-head">
        <CardTitle className="v3-decision-title" data-testid="v3-decision-title">{heading ? <WrapUpText text={heading} /> : status}</CardTitle>
        {heading ? <Badge tone={answered ? 'neutral' : 'ask'} className="v3-decision-status" data-testid="v3-decision-status">{status}</Badge> : null}
      </CardHead>
      {rest ? (
        <div className="v3-para v3-decision-body">
          <Markdown text={rest} sourceCwd={sourceCwd} sessionId={sessionId} messageId={`${messageId}:decision`} />
        </div>
      ) : null}
      {answered && (reply || result) ? (
        <dl className="v3-decision-trail" data-testid="v3-decision-trail">
          {reply ? (
            <div className="v3-decision-step" data-kind="reply">
              <dt>{tt('decisionYourReply')}</dt>
              <dd title={answer ?? undefined}>{reply}</dd>
            </div>
          ) : null}
          {result && outcome ? (
            <div className="v3-decision-step" data-kind="outcome" data-state={outcome.state}>
              <dt>{tt('decisionOutcome')}</dt>
              <dd>{result}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </Card>
  )
}

function plainTitle(title: string): string {
  return title.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__)(.+?)\1/g, '$2')
}

const NO_PATHS: readonly string[] = []

export function TurnResult({ turn, changes, cwd, readOnly, rewindOwner, text, sourceCwd, arrive = false }: { turn: AssistantTurn; changes: TurnChangeSet | null; cwd?: string; readOnly: boolean; rewindOwner: string | null; text: string; sourceCwd?: string; arrive?: boolean }): JSX.Element {
  const sessionCwd = useStore((s) => s.session?.cwd)
  const changedPaths = useMemo(() => changes?.files.map((file) => file.path) ?? NO_PATHS, [changes])
  const hasTools = turn.tools.length > 0
  const deliverables = useMemo(() => (hasTools ? outcomeFiles(replyFileLinks(text), changedPaths) : []), [hasTools, text, changedPaths])
  return (
    <div className="v3-result" data-testid="v3-turn-result" data-arrive={arrive ? '' : undefined}>
      <TurnChanges turn={turn} changes={changes} deliverables={deliverables} cwd={cwd} previewCwd={sourceCwd || sessionCwd || undefined} readOnly={readOnly} rewindOwner={rewindOwner} />
    </div>
  )
}
