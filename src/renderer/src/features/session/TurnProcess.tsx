import { useLayoutEffect, useState, type JSX, type RefCallback } from 'react'
import { useT } from '../../i18n'
import type { TurnSegment } from '../../../../shared/turns'
import { Markdown } from './Markdown'
import { ToolSteps } from './ToolSteps'
import { ThinkingLine } from './Thinking'
import { Button, Collapsible, CollapsibleHeader, CollapsiblePanel, DiffStat } from '../../ui'
import { formatDuration } from '../../../../shared/duration'
import { useSessionText } from './text'
import { conciseSegment, mergeQuietSegments, pickLiveSegments, processLead, processSummary, segmentSteps, stageSegmentCount, withoutThinking, type ProcessFileChange, type ProcessSummary } from './turn-process'
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
  const lead = live ? '' : processLead(process)

  const body = (
    <div ref={steady.ref} className="v3-process-body" role="group" aria-label={t('proc.title')} data-stage={stage || undefined} data-testid="v3-process-body" style={steady.minHeight ? { minHeight: steady.minHeight } : undefined}>
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
          tone="emphasized"
          data-testid="v3-process-toggle"
        >
          <span className="v3-process-line" title={lead || undefined} data-testid="v3-process-line">
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

const SHOWN_ACTION_KINDS = 2

type TextKey = Parameters<ReturnType<typeof useSessionText>>[0]

function processParts(summary: ProcessSummary, tt: ReturnType<typeof useSessionText>, filesShownBelow = false): ProcessPart[] {
  const parts: ProcessPart[] = []
  const count = (kind: string, n: number, one: TextKey, many: TextKey): void => {
    if (n) parts.push({ key: kind, kind, text: n === 1 ? tt(one) : tt(many, { n }) })
  }
  const files = (kind: string, list: readonly ProcessFileChange[], single: Parameters<typeof tt>[0], many: Parameters<typeof tt>[0]): void => {
    if (!list.length) return
    parts.push(list.length === 1
      ? { key: kind, kind, text: tt(single, { file: list[0].base }), file: list[0] }
      : { key: kind, kind, text: tt(many, { n: list.length }), file: totalLines(list) })
  }
  const all: { kind: string; n: number; one: TextKey; many: TextKey; noun: TextKey }[] = [
    { kind: 'commands', n: summary.commands + summary.code, one: 'processCommands1', many: 'processCommands', noun: 'processKindCommands' },
    { kind: 'reads', n: summary.reads, one: 'processReads1', many: 'processReads', noun: 'processKindReads' },
    { kind: 'searches', n: summary.searches, one: 'processSearch1', many: 'processSearch', noun: 'processKindSearch' },
    { kind: 'lists', n: summary.lists, one: 'processList1', many: 'processList', noun: 'processKindList' },
    { kind: 'web', n: summary.web, one: 'processWeb1', many: 'processWeb', noun: 'processKindWeb' },
    { kind: 'fetches', n: summary.fetches, one: 'processFetch1', many: 'processFetch', noun: 'processKindFetch' },
    { kind: 'agents', n: summary.agents, one: 'processAgent1', many: 'processAgent', noun: 'processKindAgent' },
    { kind: 'other', n: summary.other, one: 'processOther1', many: 'processOther', noun: 'processKindOther' }
  ]
  const actions = all.filter((action) => action.n > 0)
  const ranked = [...actions].sort((a, b) => b.n - a.n)
  const shownCount = ranked.length <= SHOWN_ACTION_KINDS + 1 ? ranked.length : SHOWN_ACTION_KINDS
  const shown = new Set(ranked.slice(0, shownCount).map((action) => action.kind))
  const rest = ranked.slice(shownCount)
  if (!summary.actions) count('thinking', summary.thinking, 'processThinking1', 'processThinking')
  for (const action of actions) if (shown.has(action.kind)) count(action.kind, action.n, action.one, action.many)
  if (!filesShownBelow) {
    files('edits', summary.edits, 'processEditFile', 'processEdits')
    files('creates', summary.creates, 'processCreateFile', 'processCreates')
  }
  if (rest.length) parts.push({ key: 'rest', kind: 'rest', text: tt('processRest', { kinds: rest.map((action) => tt(action.noun)).join(tt('processKindJoin')), n: rest.reduce((sum, action) => sum + action.n, 0) }) })
  if (!parts.length && summary.actions) count('actions', summary.actions, 'processActions1', 'processActions')
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
