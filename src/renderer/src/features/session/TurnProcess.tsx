import type { JSX } from 'react'
import { useT } from '../../i18n'
import type { TurnSegment } from '../../../../shared/turns'
import { Markdown } from './Markdown'
import { ToolSteps } from './ToolSteps'
import { ThinkingLine } from './Thinking'
import { Button } from '../../ui'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { conciseSegment, mergeQuietSegments, pickLiveSegments, processSummary, segmentSteps, withoutThinking, type ProcessSummary } from './turn-process'
import { useToolExpansion } from './use-tool-run'
import type { TranscriptView } from './transcript-view-model'

const NO_APPROVALS: ReadonlySet<string> = new Set()
const STAGE_SEGMENTS = 1

export function TurnProcess({ process, live, alertFailures, view, sessionId, turnId, approvalIds = NO_APPROVALS, glowId }: {
  process: TurnSegment[]
  live: boolean
  alertFailures: boolean
  view: TranscriptView
  sessionId: string | null
  turnId?: string
  approvalIds?: ReadonlySet<string>
  glowId?: string | null
}): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const key = `process:${turnId ?? process[0]?.id ?? ''}`
  const [manual, setManual] = useToolExpansion(key)
  const [showAll, setShowAll] = useToolExpansion(`${key}:all`)
  const summary = processSummary(process)
  const headless = !summary.thinking && !summary.actions
  const open = headless || (manual ?? view === 'thinking')
  const stage = !open && live
  const source = stage ? process.map(view === 'side' ? withoutThinking : conciseSegment) : process
  const merged = mergeQuietSegments(source)
  const picked = stage
    ? pickLiveSegments(merged, STAGE_SEGMENTS)
    : live && showAll !== true ? pickLiveSegments(merged) : { shown: merged, hidden: 0 }
  const single = summary.thinking === 1 && !summary.actions

  return (
    <div className="v3-process" data-open={open || undefined} data-live={live || undefined} data-testid="v3-process">
      {headless ? null : (
        <button type="button" className="v3-process-head" aria-expanded={open} onClick={() => setManual(!open)} data-testid="v3-process-toggle">
          {processParts(summary, tt).map((part) => <span key={part} className="v3-process-count">{part}</span>)}
          {summary.failed ? <span className={alertFailures ? 'v3-steps-stats err' : 'v3-steps-stats'} data-kind="failed" data-testid="v3-process-failed">{t('tool.wsFailed', { n: summary.failed })}</span> : null}
          <Icon name="chevron-right" size={14} className="v3-chev" />
        </button>
      )}
      {open || stage ? (
        <div className="v3-process-body" role="group" aria-label={t('proc.title')} data-stage={stage || undefined} data-testid="v3-process-body">
          {picked.hidden > 0 && !stage ? (
            <Button size="sm" variant="ghost" className="v3-process-more" onPress={() => setShowAll(true)} data-testid="v3-process-more">
              {tt('moreItems', { n: picked.hidden })}
            </Button>
          ) : null}
          {picked.shown.map((segment) => (
            <ProcessSegment key={segment.id} segment={segment} sessionId={sessionId} approvalIds={approvalIds} glowId={glowId} openThinking={single} alertFailures={alertFailures} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function processParts(summary: ProcessSummary, tt: ReturnType<typeof useSessionText>): string[] {
  const parts: string[] = []
  if (summary.thinking) parts.push(summary.thinking === 1 ? tt('processThinking1') : tt('processThinking', { n: summary.thinking }))
  if (summary.actions) parts.push(summary.actions === 1 ? tt('processActions1') : tt('processActions', { n: summary.actions }))
  return parts
}

function ProcessSegment({ segment, sessionId, approvalIds, glowId, openThinking, alertFailures }: {
  segment: TurnSegment
  sessionId: string | null
  approvalIds: ReadonlySet<string>
  glowId?: string | null
  openThinking: boolean
  alertFailures: boolean
}): JSX.Element {
  const { lead, steps } = segmentSteps(segment)
  return (
    <div className="v3-process-seg">
      {lead.map((part, index) => (
        <ThinkingLine key={`lead:${index}`} text={part.text} ms={part.ms} live={part.live} step defaultOpen={openThinking} expansionId={`${segment.id}:lead:${index}`} />
      ))}
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
        ? <ToolSteps key={step.key} tools={step.tools} approvalIds={approvalIds} glowId={glowId} alertFailures={alertFailures} />
        : <ThinkingLine key={step.key} text={step.thinking.text} ms={step.thinking.ms} live={step.thinking.live} step defaultOpen={openThinking} expansionId={`${segment.id}:${step.key}`} />)}
    </div>
  )
}
