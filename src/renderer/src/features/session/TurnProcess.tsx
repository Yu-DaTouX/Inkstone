import type { JSX } from 'react'
import { useT } from '../../i18n'
import type { TurnSegment } from '../../../../shared/turns'
import { formatDuration } from '../../../../shared/duration'
import { Markdown } from './Markdown'
import { Icon } from './Icon'
import { ToolSteps } from './ToolSteps'
import { ThinkingLine } from './Thinking'
import { ToolRunStats } from './ToolRunStats'
import { runningCallLabel } from './tool-summary'
import { Badge, Button } from '../../ui'
import { useSessionText } from './text'
import { formatToolRun, summarizeToolRun } from './tool-run-model'
import { useHeldRunLabel, useToolExpansion } from './use-tool-run'
import { mergeQuietSegments, narrationLine, pickLiveSegments, processNotes, processTools, segmentSteps } from './turn-process'

const NO_APPROVALS: ReadonlySet<string> = new Set()

export function TurnProcess({ process, elapsedMs, live, sessionId, turnId, approvalIds = NO_APPROVALS }: {
  process: TurnSegment[]
  elapsedMs?: number
  live: boolean
  sessionId: string | null
  turnId?: string
  approvalIds?: ReadonlySet<string>
}): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const [manual, setManual] = useToolExpansion(`process:${turnId ?? process[0]?.id ?? ''}`)
  const open = manual ?? live

  const tools = processTools(process)
  const notes = processNotes(process)
  const summary = summarizeToolRun(tools, approvalIds)
  const current = live ? summary.running : null
  const summaryLabel = tools.length ? formatToolRun(summary, tt) : t('proc.title')
  const latest = notes.length ? narrationLine(notes[notes.length - 1]) : ''
  const held = useHeldRunLabel(current ? current.id : null, current ? runningCallLabel(current, t('tool2.generatingArgs')) : '')
  const label = open
    ? t('proc.title')
    : held.key !== null && live
      ? held.label
      : live && latest
        ? latest
        : summaryLabel
  const time = !live && elapsedMs && elapsedMs > 0 ? formatDuration(elapsedMs) : null
  const merged = mergeQuietSegments(process)
  const { shown: groups, hidden } = open && live && manual === undefined ? pickLiveSegments(merged) : { shown: merged, hidden: 0 }

  return (
    <section className="v3-steps v3-process" data-testid="v3-process" data-state={summary.state} aria-label={t('proc.title')}>
      <button
        className="v3-steps-sum v3-process-sum"
        aria-expanded={open}
        onClick={() => setManual(!open)}
        data-testid="v3-process-toggle"
      >
        <span className="v3-steps-label v3-process-label" title={label}>{label}</span>
        {!open ? <ToolRunStats summary={summary} /> : null}
        {!open && summary.needsApproval ? <Badge tone="ask" className="v3-steps-badge" data-testid="v3-process-approval">{tt('runNeedsApproval')}</Badge> : null}
        <Icon name="chevron-right" size={14} className="v3-chev" />
        {time ? <span className="v3-act-time v3-process-time">{time}</span> : null}
      </button>

      {open ? (
        <div className="v3-process-body" data-testid="v3-process-body">
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
                      <div key={part.id} className="v3-process-note">
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
      ) : null}
    </section>
  )
}
