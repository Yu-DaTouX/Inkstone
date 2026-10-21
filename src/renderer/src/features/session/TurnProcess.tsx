import type { JSX } from 'react'
import { useT } from '../../i18n'
import type { TurnSegment } from '../../../../shared/turns'
import { Markdown } from './Markdown'
import { ToolSteps } from './ToolSteps'
import { ThinkingLine } from './Thinking'
import { Button } from '../../ui'
import { useSessionText } from './text'
import { mergeQuietSegments, pickLiveSegments, segmentSteps } from './turn-process'
import { useToolExpansion, useTranscriptViewScope } from './use-tool-run'
import { opensEverything } from './transcript-view-model'

const NO_APPROVALS: ReadonlySet<string> = new Set()

export function TurnProcess({ process, live, sessionId, turnId, approvalIds = NO_APPROVALS }: {
  process: TurnSegment[]
  live: boolean
  sessionId: string | null
  turnId?: string
  approvalIds?: ReadonlySet<string>
}): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const [manual, setManual] = useToolExpansion(`process:${turnId ?? process[0]?.id ?? ''}`)
  const verbose = opensEverything(useTranscriptViewScope())
  const merged = mergeQuietSegments(process)
  const { shown: groups, hidden } = live && manual === undefined && !verbose ? pickLiveSegments(merged) : { shown: merged, hidden: 0 }

  return (
    <div className="v3-process" data-testid="v3-process" aria-label={t('proc.title')}>
      {hidden > 0 ? (
        <Button size="sm" variant="ghost" className="v3-process-more" onPress={() => setManual(true)} data-testid="v3-process-more">
          {tt('moreItems', { n: hidden })}
        </Button>
      ) : null}
      {groups.map((segment) => {
        const { lead, steps } = segmentSteps(segment)
        return (
          <div key={segment.id} className="v3-process-seg">
            {lead.map((part, index) => <ThinkingLine key={`lead:${index}`} text={part.text} ms={part.ms} live={part.live} />)}
            {segment.commentary.length ? (
              <div className="v3-process-notes">
                {segment.commentary.map((part) => (
                  <div key={part.id} className="v3-para">
                    <Markdown text={part.text} sourceCwd={part.sourceCwd} live={false} sessionId={sessionId} messageId={part.id} />
                  </div>
                ))}
              </div>
            ) : null}
            {steps.map((step) => step.kind === 'tools'
              ? <ToolSteps key={step.key} tools={step.tools} approvalIds={approvalIds} />
              : <ThinkingLine key={step.key} text={step.thinking.text} ms={step.thinking.ms} live={step.thinking.live} />)}
          </div>
        )
      })}
    </div>
  )
}
