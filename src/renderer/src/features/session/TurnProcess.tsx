import type { JSX } from 'react'
import { useT } from '../../i18n'
import type { TurnSegment } from '../../../../shared/turns'
import { Markdown } from './Markdown'
import { ToolSteps } from './ToolSteps'
import { ThinkingLine } from './Thinking'
import { Button, Collapsible, CollapsibleHeader, CollapsiblePanel, DiffStat } from '../../ui'
import { formatDuration } from '../../../../shared/duration'
import { openPanelTool } from '../workbench/panel-actions'
import { useSessionText } from './text'
import { conciseSegment, mergeQuietSegments, pickLiveSegments, processPreview, processSummary, segmentSteps, withoutThinking, type ProcessFileChange, type ProcessSummary } from './turn-process'
import { useToolExpansion } from './use-tool-run'
import type { TranscriptView } from './transcript-view-model'

const NO_APPROVALS: ReadonlySet<string> = new Set()
const STAGE_SEGMENTS = 1

export function TurnProcess({ process, live, alertFailures, view, sessionId, turnId, approvalIds = NO_APPROVALS, glowId, elapsedMs }: {
  process: TurnSegment[]
  live: boolean
  alertFailures: boolean
  view: TranscriptView
  sessionId: string | null
  turnId?: string
  approvalIds?: ReadonlySet<string>
  glowId?: string | null
  elapsedMs?: number
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
  const changed = !live && (summary.edits.length > 0 || summary.creates.length > 0)
  const elapsed = !live && elapsedMs && elapsedMs > 0 ? formatDuration(elapsedMs) : null
  const preview = live || open ? '' : processPreview(process)

  const body = (
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
  )

  return (
    <Collapsible className="v3-process" data-open={open || undefined} data-live={live || undefined} data-headless={headless || undefined} data-testid="v3-process" isExpanded={open} onExpandedChange={setManual}>
      {headless ? null : (
        <CollapsibleHeader
          className="v3-process-head"
          size="compact"
          chevron="end"
          data-testid="v3-process-toggle"
          actions={changed ? (
            <Button size="sm" variant="ghost" className="v3-process-changes" onPress={() => openPanelTool('changes')} data-testid="v3-process-view-changes">
              {tt('processViewChanges')}
            </Button>
          ) : undefined}
        >
          <span className="v3-process-line">
            {processParts(summary, tt).map((part) => (
              <span key={part.key} className="v3-process-count" data-kind={part.kind}>
                {part.text}
                {part.file && part.file.added !== null && part.file.removed !== null && part.file.added + part.file.removed > 0 ? <DiffStat className="v3-process-diff" added={part.file.added} removed={part.file.removed} /> : null}
              </span>
            ))}
            {elapsed ? <span className="v3-process-count" data-kind="elapsed">{elapsed}</span> : null}
            {summary.failed ? <span className={alertFailures ? 'v3-steps-stats err' : 'v3-steps-stats'} data-kind="failed" data-testid="v3-process-failed">{t('tool.wsFailed', { n: summary.failed })}</span> : null}
            {preview ? <span className="v3-process-preview" data-testid="v3-process-preview" title={preview}>{preview}</span> : null}
          </span>
        </CollapsibleHeader>
      )}
      <CollapsiblePanel className="v3-step-panel">{open ? body : null}</CollapsiblePanel>
      {stage ? body : null}
    </Collapsible>
  )
}

interface ProcessPart {
  key: string
  kind: string
  text: string
  file?: Pick<ProcessFileChange, 'added' | 'removed'>
}

function totalLines(files: readonly ProcessFileChange[]): Pick<ProcessFileChange, 'added' | 'removed'> {
  if (files.some((file) => file.added === null || file.removed === null)) return { added: null, removed: null }
  return { added: files.reduce((sum, file) => sum + (file.added ?? 0), 0), removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0) }
}

function processParts(summary: ProcessSummary, tt: ReturnType<typeof useSessionText>): ProcessPart[] {
  const parts: ProcessPart[] = []
  const count = (kind: string, n: number, one: Parameters<typeof tt>[0], many: Parameters<typeof tt>[0]): void => {
    if (n) parts.push({ key: kind, kind, text: n === 1 ? tt(one) : tt(many, { n }) })
  }
  const files = (kind: string, list: readonly ProcessFileChange[], single: Parameters<typeof tt>[0], many: Parameters<typeof tt>[0]): void => {
    if (!list.length) return
    parts.push(list.length === 1
      ? { key: kind, kind, text: tt(single, { file: list[0].base }), file: list[0] }
      : { key: kind, kind, text: tt(many, { n: list.length }), file: totalLines(list) })
  }
  count('thinking', summary.thinking, 'processThinking1', 'processThinking')
  count('commands', summary.commands, 'processCommands1', 'processCommands')
  count('code', summary.code, 'processCode1', 'processCode')
  count('reads', summary.reads, 'processReads1', 'processReads')
  files('edits', summary.edits, 'processEditFile', 'processEdits')
  files('creates', summary.creates, 'processCreateFile', 'processCreates')
  count('other', summary.other, 'processOther1', 'processOther')
  if (parts.length === (summary.thinking ? 1 : 0) && summary.actions) count('actions', summary.actions, 'processActions1', 'processActions')
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
