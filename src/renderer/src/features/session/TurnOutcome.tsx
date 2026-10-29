import { useMemo, type JSX } from 'react'
import { Badge, Button } from '../../ui'
import { Card, CardHead, CardTitle } from '../../ui/Card'
import type { AssistantTurn } from '../../../../shared/turns'
import { TurnChanges } from './TurnChanges'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { useStore } from '../../state/store'
import { Markdown } from './Markdown'
import { useSessionText } from './text'
import { decisionTitle, outcomeFiles, replyFileLinks } from './turn-outcome'
import { WrapUpText } from './WrapUpCard'
import type { TurnChanges as TurnChangeSet } from './turn-changes'
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
  const status = answered ? tt('decisionReplied') : tt('wrapUpDecide')
  const { title, rest } = useMemo(() => decisionTitle(question), [question])
  const heading = title ? plainTitle(title) : ''
  return (
    <Card as="section" padding="none" receipt={answered} className="v3-decision" data-state={answered ? 'answered' : 'open'} aria-label={heading.replace(/`/g, '') || status} data-testid="v3-decision">
      <CardHead className="v3-decision-head">
        <CardTitle className="v3-decision-title" data-testid="v3-decision-title">{heading ? <WrapUpText text={heading} /> : status}</CardTitle>
        {heading ? <Badge tone={answered ? 'neutral' : 'ask'} className="v3-decision-status" data-testid="v3-decision-status">{status}</Badge> : null}
      </CardHead>
      {rest ? (
        <div className="v3-para v3-decision-body">
          <Markdown text={rest} sourceCwd={sourceCwd} sessionId={sessionId} messageId={`${messageId}:decision`} />
        </div>
      ) : null}
    </Card>
  )
}

function plainTitle(title: string): string {
  return title.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__)(.+?)\1/g, '$2')
}

const NO_PATHS: readonly string[] = []

export function TurnResult({ turn, changes, cwd, readOnly, rewindOwner, text, sourceCwd }: { turn: AssistantTurn; changes: TurnChangeSet | null; cwd?: string; readOnly: boolean; rewindOwner: string | null; text: string; sourceCwd?: string }): JSX.Element {
  const changedPaths = useMemo(() => changes?.files.map((file) => file.path) ?? NO_PATHS, [changes])
  return (
    <div className="v3-result" data-testid="v3-turn-result">
      <TurnChanges turn={turn} changes={changes} cwd={cwd} readOnly={readOnly} rewindOwner={rewindOwner} />
      {turn.tools.length ? <TurnFiles text={text} sourceCwd={sourceCwd} changedPaths={changedPaths} changed={!!changes} /> : null}
    </div>
  )
}

function TurnFiles({ text, sourceCwd, changedPaths, changed }: { text: string; sourceCwd?: string; changedPaths: readonly string[]; changed: boolean }): JSX.Element | null {
  const tt = useSessionText()
  const previewFile = useStore((s) => s.previewFile)
  const sessionCwd = useStore((s) => s.session?.cwd)
  const files = useMemo(() => outcomeFiles(replyFileLinks(text), changedPaths), [text, changedPaths])
  if (!files.length) return null
  const cwd = sourceCwd || sessionCwd || undefined
  return (
    <div className="v3-outcome" role="group" aria-label={tt('outcomeFiles')} data-testid="v3-turn-files">
      <span className="v3-result-label" data-testid="v3-turn-files-label">{changed ? tt('outcomeFiles') : files.length === 1 ? tt('outcomeNoChanges1') : tt('outcomeNoChanges', { n: files.length })}</span>
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
