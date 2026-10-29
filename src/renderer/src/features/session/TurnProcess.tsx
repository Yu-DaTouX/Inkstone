import { useLayoutEffect, useState, type JSX, type RefCallback } from 'react'
import { useT } from '../../i18n'
import type { TurnSegment } from '../../../../shared/turns'
import { Markdown } from './Markdown'
import { ToolSteps, ToolTallyScope } from './ToolSteps'
import { ThinkingLine } from './Thinking'
import { Button, Collapsible, CollapsibleChevron, CollapsibleHeader, CollapsiblePanel, DiffStat, TermSpinner } from '../../ui'
import { formatDuration } from '../../../../shared/duration'
import { useSessionText } from './text'
import { conciseSegment, mergeQuietSegments, pickLiveSegments, processPreview, processSummary, segmentSteps, stageSegmentCount, withoutThinking, type ProcessFileChange, type ProcessSummary } from './turn-process'
import { useToolExpansion } from './use-tool-run'
import type { TranscriptView } from './transcript-view-model'

const NO_APPROVALS: ReadonlySet<string> = new Set()

function useSteadyHeight(active: boolean): { ref: RefCallback<HTMLDivElement>; minHeight: number | undefined } {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [minHeight, setMinHeight] = useState(0)
  useLayoutEffect(() => {
    if (!active || !node) {
      setMinHeight(0)
      return undefined
    }
    let width = node.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const box = node.getBoundingClientRect()
      if (Math.abs(box.width - width) > 0.5) {
        width = box.width
        setMinHeight(0)
        return
      }
      setMinHeight((current) => (box.height > current + 0.5 ? box.height : current))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [active, node])
  return { ref: setNode, minHeight: active && minHeight > 0 ? minHeight : undefined }
}

export function TurnProcess({ process, live, alertFailures, view, sessionId, turnId, approvalIds = NO_APPROVALS, glowId, elapsedMs, filesShownBelow = false }: {
  process: TurnSegment[]
  live: boolean
  alertFailures: boolean
  view: TranscriptView
  sessionId: string | null
  turnId?: string
  approvalIds?: ReadonlySet<string>
  glowId?: string | null
  elapsedMs?: number
  filesShownBelow?: boolean
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
  const steady = useSteadyHeight(live)
  const source = stage ? process.map(view === 'side' ? withoutThinking : conciseSegment) : process
  const merged = mergeQuietSegments(source)
  const picked = stage
    ? pickLiveSegments(merged, stageSegmentCount(merged))
    : live && showAll !== true ? pickLiveSegments(merged) : { shown: merged, hidden: 0 }
  const single = summary.thinking === 1 && !summary.actions
  const elapsed = !live && elapsedMs && elapsedMs > 0 ? formatDuration(elapsedMs) : null
  const preview = live ? '' : processPreview(process)
  const tip = [preview, processBreakdown(summary, tt)].filter(Boolean).join('\n')

  const body = (
    <div ref={steady.ref} className="v3-process-body" role="group" aria-label={t('proc.title')} data-stage={stage || undefined} data-testid="v3-process-body" style={steady.minHeight ? { minHeight: steady.minHeight } : undefined}>
      {picked.hidden > 0 && !stage ? (
        <Button size="sm" variant="ghost" className="v3-process-more" onPress={() => setShowAll(true)} data-testid="v3-process-more">
          {tt('moreItems', { n: picked.hidden })}
        </Button>
      ) : null}
      <ToolTallyScope.Provider value>
        {picked.shown.map((segment) => (
          <ProcessSegment key={segment.id} segment={segment} sessionId={sessionId} approvalIds={approvalIds} glowId={glowId} openThinking={single} alertFailures={alertFailures} />
        ))}
      </ToolTallyScope.Provider>
    </div>
  )

  return (
    <Collapsible className="v3-process" data-open={open || undefined} data-live={live || undefined} data-headless={headless || undefined} data-testid="v3-process" isExpanded={open} onExpandedChange={setManual}>
      {headless ? null : (
        <CollapsibleHeader
          className="v3-process-head"
          size="compact"
          chevron="none"
          icon={live ? <TermSpinner className="v3-process-spin" /> : <CollapsibleChevron className="ui-collapsible__chevron" />}
          tone="emphasized"
          data-testid="v3-process-toggle"
        >
          <span className="v3-process-line" title={tip || undefined} data-testid="v3-process-line">
            {processParts(summary, tt, filesShownBelow && !live).map((part) => (
              <span key={part.key} className="v3-process-count" data-kind={part.kind}>
                {part.text}
                {part.file && part.file.added !== null && part.file.removed !== null && part.file.added + part.file.removed > 0 ? <DiffStat className="v3-process-diff" added={part.file.added} removed={part.file.removed} /> : null}
              </span>
            ))}
            {elapsed ? <span className="v3-process-count ui-num" data-kind="elapsed">{elapsed}</span> : null}
            {summary.failed ? <span className={alertFailures ? 'v3-steps-stats err' : 'v3-steps-stats'} data-kind="failed" data-testid="v3-process-failed">{t('tool.wsFailed', { n: summary.failed })}</span> : null}
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

type SessionText = ReturnType<typeof useSessionText>
type TextKey = Parameters<SessionText>[0]

function countText(tt: SessionText, n: number, one: TextKey, many: TextKey): string {
  return n === 1 ? tt(one) : tt(many, { n })
}

function fileText(tt: SessionText, list: readonly ProcessFileChange[], single: TextKey, many: TextKey): string {
  return list.length === 1 ? tt(single, { file: list[0].base }) : tt(many, { n: list.length })
}

function processParts(summary: ProcessSummary, tt: SessionText, filesShownBelow = false): ProcessPart[] {
  const parts: ProcessPart[] = []
  const commands = summary.commands + summary.code
  if (!summary.actions && summary.thinking) parts.push({ key: 'thinking', kind: 'thinking', text: countText(tt, summary.thinking, 'processThinking1', 'processThinking') })
  if (commands) parts.push({ key: 'commands', kind: 'commands', text: countText(tt, commands, 'processCommandCount1', 'processCommandCount') })
  if (summary.tools) parts.push({ key: 'tools', kind: 'tools', text: countText(tt, summary.tools, 'processToolCount1', 'processToolCount') })
  if (!filesShownBelow) {
    if (summary.edits.length) parts.push({ key: 'edits', kind: 'edits', text: fileText(tt, summary.edits, 'processEditFile', 'processEdits'), file: summary.edits.length === 1 ? summary.edits[0] : totalLines(summary.edits) })
    if (summary.creates.length) parts.push({ key: 'creates', kind: 'creates', text: fileText(tt, summary.creates, 'processCreateFile', 'processCreates'), file: summary.creates.length === 1 ? summary.creates[0] : totalLines(summary.creates) })
  }
  if (!parts.length && summary.actions) parts.push({ key: 'actions', kind: 'actions', text: countText(tt, summary.actions, 'processActions1', 'processActions') })
  return parts
}

function processBreakdown(summary: ProcessSummary, tt: SessionText): string {
  const all: [number, TextKey, TextKey][] = [
    [summary.commands + summary.code, 'processCommands1', 'processCommands'],
    [summary.reads, 'processReads1', 'processReads'],
    [summary.searches, 'processSearch1', 'processSearch'],
    [summary.lists, 'processList1', 'processList'],
    [summary.web, 'processWeb1', 'processWeb'],
    [summary.fetches, 'processFetch1', 'processFetch'],
    [summary.agents, 'processAgent1', 'processAgent'],
    [summary.other, 'processOther1', 'processOther']
  ]
  const phrases = all.filter(([n]) => n > 0).map(([n, one, many]) => countText(tt, n, one, many))
  if (summary.edits.length) phrases.push(fileText(tt, summary.edits, 'processEditFile', 'processEdits'))
  if (summary.creates.length) phrases.push(fileText(tt, summary.creates, 'processCreateFile', 'processCreates'))
  return phrases.join(tt('processKindJoin'))
}

function ProcessSegment({ segment, sessionId, approvalIds, glowId, openThinking, alertFailures }: {
  segment: TurnSegment
  sessionId: string | null
  approvalIds: ReadonlySet<string>
  glowId?: string | null
  openThinking: boolean
  alertFailures: boolean
}): JSX.Element {
  return (
    <div className="v3-process-seg">
      {segmentSteps(segment).map((step) => step.kind === 'tools'
        ? <ToolSteps key={step.key} tools={step.tools} approvalIds={approvalIds} glowId={glowId} alertFailures={alertFailures} />
        : step.kind === 'notes'
          ? (
              <div key={step.key} className="v3-process-notes">
                {step.notes.map((part) => (
                  <div key={part.id} className="v3-para">
                    <Markdown text={part.text} sourceCwd={part.sourceCwd} live={false} sessionId={sessionId} messageId={part.id} />
                  </div>
                ))}
              </div>
            )
          : <ThinkingLine key={step.key} text={step.thinking.text} ms={step.thinking.ms} live={step.thinking.live} step defaultOpen={openThinking} expansionId={`${segment.id}:${step.key}`} />)}
    </div>
  )
}
