import { useMemo, type JSX } from 'react'
import { Button } from '../../ui'
import { Card, CardHead, CardStatus } from '../../ui/Card'
import type { AssistantTurn } from '../../../../shared/turns'
import { TurnChanges } from './TurnChanges'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { useStore } from '../../state/store'
import { Markdown } from './Markdown'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { replyFileLinks } from './turn-outcome'
import './turn-outcome.css'

export function DecisionBlock({ question, sourceCwd, sessionId, messageId, answer }: {
  question: string
  sourceCwd?: string
  sessionId: string | null
  messageId: string
  answer: string | null
}): JSX.Element {
  const tt = useSessionText()
  const answered = answer !== null
  const label = answered ? tt('decisionReplied') : tt('wrapUpDecide')
  return (
    <Card as="section" padding="none" receipt={answered} className="v3-decision" data-state={answered ? 'answered' : 'open'} aria-label={label} data-testid="v3-decision">
      <CardHead className="v3-decision-head">
        <CardStatus tone={answered ? 'muted' : 'accent'} icon={<Icon name={answered ? 'message' : 'help'} size={14} />}>{label}</CardStatus>
      </CardHead>
      <div className="v3-para v3-decision-body">
        <Markdown text={question} sourceCwd={sourceCwd} sessionId={sessionId} messageId={`${messageId}:decision`} />
      </div>
    </Card>
  )
}

export function TurnResult({ turn, readOnly, rewindOwner, text, sourceCwd }: { turn: AssistantTurn; readOnly: boolean; rewindOwner: string | null; text: string; sourceCwd?: string }): JSX.Element {
  return (
    <div className="v3-result" data-testid="v3-turn-result">
      <TurnChanges turn={turn} readOnly={readOnly} rewindOwner={rewindOwner} />
      {turn.tools.length ? <TurnFiles text={text} sourceCwd={sourceCwd} /> : null}
    </div>
  )
}

function TurnFiles({ text, sourceCwd }: { text: string; sourceCwd?: string }): JSX.Element | null {
  const tt = useSessionText()
  const previewFile = useStore((s) => s.previewFile)
  const sessionCwd = useStore((s) => s.session?.cwd)
  const files = useMemo(() => replyFileLinks(text), [text])
  if (!files.length) return null
  const cwd = sourceCwd || sessionCwd || undefined
  return (
    <div className="v3-outcome" role="group" aria-label={tt('outcomeFiles')} data-testid="v3-turn-files">
      <span className="v3-outcome-label">{tt('outcomeFiles')}</span>
      <div className="v3-outcome-files">
        {files.map((file) => (
          <Button
            key={file.path}
            size="sm"
            variant="ghost"
            className="v3-outcome-file"
            icon={<FileTypeIcon name={file.base} size={14} />}
            title={file.label && file.label !== file.base ? `${file.label}\n${file.path}` : file.path}
            onPress={() => void previewFile(file.path, file.line, cwd, file.lineEnd)}
            data-testid="v3-turn-file"
          >
            {file.base}
          </Button>
        ))}
      </div>
    </div>
  )
}
