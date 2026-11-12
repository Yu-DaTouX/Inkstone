import { Fragment, useCallback, useContext, useId, useLayoutEffect, useMemo, useState, useSyncExternalStore, type JSX, type RefCallback } from 'react'
import { CompactionMarker } from './CompactionMarker'
import { useT } from '../../i18n'
import type { TurnSegment } from '../../../../shared/turns'
import { Markdown } from './Markdown'
import { ToolSteps, ToolTallyScope } from './ToolSteps'
import { ThinkingLine } from './Thinking'
import { AnimatedHeight, Button, Collapsible, CollapsibleHeader, DiffStat, Expand, TermSpinner } from '../../ui'
import { CirclePause } from 'lucide-react'
import { formatDuration } from '../../../../shared/duration'
import { useSessionText } from './text'
import { conciseSegment, hasSegmentContent, mergeQuietSegments, splitAtCompaction, type CompactionCut, pickLiveSegments, processSummary, segmentSteps, spreadProcess, stageSegmentCount, withoutThinking, type ProcessFileChange, type ProcessSummary } from './turn-process'
import type { StripPart } from './process-strip'
import { ToolExpansionScope, useToolExpansion } from './use-tool-run'
import { toolExpansion } from './tool-expansion'
import { useRunProgress, useWorkingLine } from './run-status'
import { isHistoryQuestionCall } from './question-receipt'
import { QuestionHistory } from './QuestionReceipt'
import type { TranscriptView } from './transcript-view-model'
import type { ApprovalReceipt } from '../../../../shared/approval'
import { TurnApprovalLine } from './ApprovalReceipt'
import { isWebTool } from './tool-run-model'
import { ToolImagePreviews, ToolImagePreviewScope } from './ToolImagePreviews'

const NO_APPROVALS: ReadonlySet<string> = new Set()
const NO_RECEIPTS: readonly ApprovalReceipt[] = []
const SPREAD_HISTORY_ITEMS = 40
const STEADY_HOLD_MS = 30000
const SHRINK_HOLD_MS = 1200
const USER_TOGGLE_MS = 500
const BOTTOM_SLACK_PX = 48

const OPEN_KINDS = ['step', 'group', 'web'] as const

function callOpened(scope: string, id: string): boolean {
  return OPEN_KINDS.some((kind) => toolExpansion.get(scope, `${kind}:${id}`) === true)
}

function openedCalls(process: readonly TurnSegment[], scope: string): string {
  let key = ''
  for (const segment of process) for (const call of segment.tools) if (callOpened(scope, call.id)) key += `${call.id}|`
  return key
}

function readingHistory(node: HTMLElement): boolean {
  const stream = node.closest<HTMLElement>('.v3-stream')
  return !!stream && stream.scrollHeight - stream.clientHeight - stream.scrollTop > BOTTOM_SLACK_PX
}

function contentBottom(node: HTMLElement): number {
  let bottom = node.getBoundingClientRect().top
  for (const child of node.children) bottom = Math.max(bottom, child.getBoundingClientRect().bottom)
  return bottom
}

function heldGapVisible(node: HTMLElement): boolean {
  const stream = node.closest<HTMLElement>('.v3-stream')
  if (!stream) return false
  const view = stream.getBoundingClientRect()
  const gapTop = contentBottom(node)
  const gapBottom = node.getBoundingClientRect().bottom
  return gapBottom - gapTop > 1 && gapTop < view.bottom && gapBottom > view.top
}

function useSteadyHeight(active: boolean): { ref: RefCallback<HTMLDivElement>; minHeight: number | undefined } {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [minHeight, setMinHeight] = useState(0)
  useLayoutEffect(() => {
    setMinHeight(0)
    if (!active || !node) return undefined
    let width = node.getBoundingClientRect().width
    let release = 0
    let suspendedUntil = 0
    let lastHeight = 0
    let held = false
    let shrinkRelease = 0
    const releaseHold = (): void => {
      window.clearTimeout(release)
      window.clearTimeout(shrinkRelease)
      shrinkRelease = 0
      held = false
      setMinHeight(0)
    }
    const releaseIfGapShows = (): void => {
      if (held && readingHistory(node) && heldGapVisible(node)) releaseHold()
    }
    const observer = new ResizeObserver(() => {
      for (const child of node.children) observer.observe(child)
      const box = node.getBoundingClientRect()
      const height = contentBottom(node) - box.top
      const shrinking = height < lastHeight - 0.5
      lastHeight = height
      const now = performance.now()
      if (now < suspendedUntil) {
        if (shrinking) suspendedUntil = now + USER_TOGGLE_MS
        return
      }
      if (Math.abs(box.width - width) > 0.5) {
        width = box.width
        releaseHold()
        return
      }
      if (held && shrinking) {
        releaseIfGapShows()
        if (held && !shrinkRelease && !readingHistory(node)) {
          shrinkRelease = window.setTimeout(() => {
            shrinkRelease = 0
            if (held && (!readingHistory(node) || heldGapVisible(node))) releaseHold()
          }, SHRINK_HOLD_MS)
        }
        return
      }
      if (shrinkRelease && height >= box.height - 0.5) {
        window.clearTimeout(shrinkRelease)
        shrinkRelease = 0
      }
      if (box.height <= 0.5) return
      held = true
      setMinHeight((current) => (box.height > current + 0.5 ? box.height : current))
      window.clearTimeout(release)
      const settle = (): void => {
        if (readingHistory(node) && !heldGapVisible(node)) {
          release = window.setTimeout(settle, STEADY_HOLD_MS)
          return
        }
        releaseHold()
      }
      release = window.setTimeout(settle, STEADY_HOLD_MS)
    })
    const releaseNow = (): void => {
      suspendedUntil = performance.now() + USER_TOGGLE_MS
      releaseHold()
    }
    const stream = node.closest<HTMLElement>('.v3-stream')
    const scope = node.closest<HTMLElement>('.v3-process') ?? node
    observer.observe(node)
    scope.addEventListener('click', releaseNow, true)
    scope.addEventListener('keydown', releaseNow, true)
    stream?.addEventListener('scroll', releaseIfGapShows, { passive: true })
    return () => {
      observer.disconnect()
      scope.removeEventListener('click', releaseNow, true)
      scope.removeEventListener('keydown', releaseNow, true)
      stream?.removeEventListener('scroll', releaseIfGapShows)
      window.clearTimeout(release)
      window.clearTimeout(shrinkRelease)
    }
  }, [active, node])
  const ref = useCallback<RefCallback<HTMLDivElement>>((element) => {
    setNode(element)
    return () => setNode((current) => (current === element ? null : current))
  }, [])
  return { ref, minHeight: active && minHeight > 0 ? minHeight : undefined }
}

export function TurnProcess({ process, live, openByDefault = false, alertFailures, showFailures = true, liveStartedAt = null, view, sessionId, turnId, approvalIds = NO_APPROVALS, glowId, compactionAfter = null }: {
  process: TurnSegment[]
  live: boolean
  openByDefault?: boolean
  alertFailures: boolean
  showFailures?: boolean
  liveStartedAt?: number | null
  view: TranscriptView
  sessionId: string | null
  turnId?: string
  approvalIds?: ReadonlySet<string>
  glowId?: string | null
  compactionAfter?: CompactionCut | null
}): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const [showAll, setShowAll] = useToolExpansion(`spread:${turnId ?? process[0]?.id ?? ''}`)
  const items = spreadProcess(process, { foldThinking: !live && view !== 'thinking' })
  const overflow = live ? 0 : Math.max(0, items.length - SPREAD_HISTORY_ITEMS)
  const skipped = overflow && showAll !== true ? overflow : 0
  const lastGroup = items.findLastIndex((item) => item.kind === 'group')
  const lastNotes = live ? items.findLastIndex((item) => item.kind === 'notes') : -1
  const cutAt = compactionAfter ? items.findLastIndex((item) => item.kind === 'group' && !!splitAtCompaction(item.segments, compactionAfter)) : -1

  return (
    <div className="v3-spread" data-live={live || undefined} data-testid="v3-spread">
      {overflow ? (
        <Button size="sm" variant="ghost" className="v3-process-more" aria-expanded={showAll === true} onPress={() => setShowAll(showAll !== true)} data-testid="v3-spread-more">
          {showAll === true ? t('proc.showRecent') : tt('moreItems', { n: overflow })}
        </Button>
      ) : null}
      {compactionAfter && cutAt >= 0 && cutAt < skipped ? <CompactionMarker /> : null}
      {items.slice(skipped).map((item, offset) => {
        const index = skipped + offset
        return item.kind === 'notes'
          ? (
              <div key={item.key} className="v3-process-notes" data-testid="v3-process-notes">
                {item.notes.map((part) => (
                  <div key={part.id} className="v3-para">
                    <Markdown text={part.text} sourceCwd={part.sourceCwd} live={false} fresh={index === lastNotes} sessionId={sessionId} messageId={part.id} />
                  </div>
                ))}
              </div>
            )
          : (
              <ProcessGroup
                key={item.key}
                groupKey={item.key}
                segments={item.segments}
                live={live && index === items.length - 1}
                openByDefault={openByDefault && index === lastGroup}
                alertFailures={alertFailures}
                showFailures={showFailures}
                liveStartedAt={liveStartedAt}
                view={view}
                approvalIds={approvalIds}
                glowId={glowId}
                compactionAfter={index === cutAt ? compactionAfter : null}
              />
            )
      })}
      {compactionAfter && cutAt < 0 ? <CompactionMarker /> : null}
    </div>
  )
}

function ProcessGroup({ segments, groupKey, live, openByDefault, alertFailures, showFailures, liveStartedAt, view, approvalIds, glowId, compactionAfter }: {
  segments: TurnSegment[]
  groupKey: string
  live: boolean
  openByDefault: boolean
  alertFailures: boolean
  showFailures: boolean
  liveStartedAt: number | null
  view: TranscriptView
  approvalIds: ReadonlySet<string>
  glowId?: string | null
  compactionAfter: CompactionCut | null
}): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const panelId = useId()
  const key = `process:${groupKey}`
  const [manual, setManual] = useToolExpansion(key)
  const summary = useMemo(() => processSummary(segments), [segments])
  const headless = (!summary.thinking && !summary.actions) || (summary.actions > 0 && segments.every((segment) => segment.tools.every(isWebTool)))
  const open = headless || (manual ?? (view === 'thinking' || (openByDefault && !live)))
  const stage = !open && live && manual !== false
  const visible = open || stage
  const steady = useSteadyHeight(live)
  const source = stage ? segments.map(view === 'side' ? withoutThinking : conciseSegment).filter(hasSegmentContent) : segments
  const halves = compactionAfter ? splitAtCompaction(source, compactionAfter) : null
  const before = halves ? mergeQuietSegments(halves.before) : null
  const merged = halves && before ? [...before, ...mergeQuietSegments(halves.after)] : mergeQuietSegments(source)
  const markerAfter = before?.at(-1)?.id ?? null
  const markerFirst = !!compactionAfter && (!halves || !before?.length)
  const expansionScope = useContext(ToolExpansionScope)
  useSyncExternalStore(toolExpansion.subscribe, () => (live ? openedCalls(segments, expansionScope) : ''), () => '')
  const userOpened = (segment: TurnSegment): boolean => segment.tools.some((call) => callOpened(expansionScope, call.id))
  const picked = stage
    ? pickLiveSegments(merged, stageSegmentCount(merged), userOpened)
    : { shown: merged, hidden: 0 }
  const single = summary.thinking === 1 && !summary.actions
  const lines = live ? null : totalLines([...summary.edits, ...summary.creates])
  const foldedQuestions = open || live ? [] : segments.flatMap((segment) => segment.tools).filter((call) => !call.parentToolCallId && isHistoryQuestionCall(call) && call.status !== 'running' && call.status !== 'pending')
  const approvals = open || live ? NO_RECEIPTS : segments.flatMap((segment) => segment.tools.flatMap((call) => (call.approval ? [call.approval] : [])))

  const body = (
    <div ref={steady.ref} style={steady.minHeight ? { minHeight: steady.minHeight } : undefined}>
    <div className="v3-process-body" role="group" aria-label={t('proc.title')} data-stage={stage || undefined} data-testid="v3-process-body">
      <ToolImagePreviewScope.Provider value={open}>
      <ToolTallyScope.Provider value>
        {markerFirst || markerAfter && !picked.shown.some((segment) => segment.id === markerAfter) && merged.findIndex((segment) => segment.id === markerAfter) < merged.indexOf(picked.shown[0]) ? <CompactionMarker /> : null}
        {picked.shown.map((segment) => (
          <Fragment key={segment.id}>
            <ProcessSegment segment={segment} approvalIds={approvalIds} glowId={glowId} openThinking={single} alertFailures={alertFailures} staged={stage} />
            {segment.id === markerAfter ? <CompactionMarker /> : null}
          </Fragment>
        ))}
      </ToolTallyScope.Provider>
      </ToolImagePreviewScope.Provider>
    </div>
    </div>
  )

  return (
    <>
    <Collapsible className="v3-process" data-open={open || undefined} data-live={live || undefined} data-headless={headless || undefined} data-testid="v3-process" isExpanded={visible} onExpandedChange={() => setManual(open ? false : stage ? true : live ? undefined : true)}>
      {headless ? null : (
        <CollapsibleHeader
          className="v3-process-head"
          size="compact"
          chevron="end"
          aria-controls={panelId}
          icon={live ? <LiveProcessIcon /> : undefined}
          actions={open ? undefined : <ToolImagePreviews calls={segments.flatMap((segment) => segment.tools)} />}
          data-testid="v3-process-toggle"
        >
          <span className="v3-process-line" data-testid="v3-process-line">
            <span className="v3-process-count" data-kind={summary.actions ? 'actions' : 'thinking'}>{groupLabel(summary, tt)}</span>
            {lines ? <DiffStat className="v3-process-diff" added={lines.added} removed={lines.removed} /> : null}
            {live ? <LiveElapsed startedAt={liveStartedAt} /> : null}
            {summary.failed && showFailures && !live ? <span className={alertFailures ? 'v3-steps-stats err' : 'v3-steps-stats'} data-kind="failed" data-testid="v3-process-failed">{t('tool.wsFailed', { n: summary.failed })}</span> : null}
          </span>
        </CollapsibleHeader>
      )}
      <Expand id={panelId} className="v3-step-panel" open={visible} role="group" aria-label={t('proc.title')} aria-hidden={!visible || undefined}>
        {visible ? <AnimatedHeight>{body}</AnimatedHeight> : null}
      </Expand>
      {compactionAfter && !open && !stage ? <CompactionMarker /> : null}
    </Collapsible>
    {foldedQuestions.length ? (
      <div className="v3-qhistory-list" data-testid="v3-question-history-list">
        {foldedQuestions.map((call) => <QuestionHistory key={call.id} call={call} />)}
      </div>
    ) : null}
    {approvals.length ? <TurnApprovalLine approvals={approvals} /> : null}
    </>
  )
}

type SessionText = ReturnType<typeof useSessionText>
type TextKey = Parameters<SessionText>[0]

function countText(tt: SessionText, n: number, one: TextKey, many: TextKey): string {
  return n === 1 ? tt(one) : tt(many, { n })
}

function fileText(tt: SessionText, list: readonly ProcessFileChange[], single: TextKey, many: TextKey): string {
  return list.length === 1 ? tt(single, { file: list[0].base }) : tt(many, { n: list.length })
}

function totalLines(list: readonly ProcessFileChange[]): { added: number; removed: number } | null {
  let added = 0
  let removed = 0
  for (const file of list) {
    if (file.added === null || file.removed === null) return null
    added += file.added
    removed += file.removed
  }
  return added + removed > 0 ? { added, removed } : null
}

function LiveProcessIcon(): JSX.Element {
  const line = useWorkingLine()
  return line?.kind === 'waiting' ? <CirclePause size={13} className="v3-process-wait" /> : <TermSpinner className="v3-process-spin" />
}

function LiveElapsed({ startedAt }: { startedAt: number | null }): JSX.Element | null {
  const progress = useRunProgress()
  if (!progress) return null
  const elapsedMs = startedAt !== null ? Math.max(0, Date.now() - startedAt) : progress.elapsedMs
  return <span className="v3-process-count ui-num" data-kind="elapsed">{formatDuration(elapsedMs)}</span>
}

function joinActivities(phrases: readonly string[], join: string): string {
  return phrases.map((phrase, index) => index && /^[A-Z][a-z]/.test(phrase) ? phrase.charAt(0).toLowerCase() + phrase.slice(1) : phrase).join(join)
}

export function ProcessStrip({ parts }: { parts: readonly StripPart[] }): JSX.Element {
  return (
    <span className="v3-process-strip" aria-hidden="true" data-testid="v3-process-strip">
      {parts.map((part, index) => <i key={index} data-kind={part.kind} style={{ flexGrow: part.ms }} />)}
    </span>
  )
}

function activityCounts(summary: ProcessSummary): [number, TextKey, TextKey][] {
  return [
    [summary.commands + summary.code, 'processCommands1', 'processCommands'],
    [summary.reads, 'processReads1', 'processReads'],
    [summary.searches, 'processSearch1', 'processSearch'],
    [summary.lists, 'processList1', 'processList'],
    [summary.web, 'processWeb1', 'processWeb'],
    [summary.fetches, 'processFetch1', 'processFetch'],
    [summary.agents, 'processAgent1', 'processAgent'],
    [summary.questions, 'processQuestion1', 'processQuestion'],
    [summary.other, 'processOther1', 'processOther']
  ]
}

function groupLabel(summary: ProcessSummary, tt: SessionText): string {
  const phrases: string[] = []
  if (summary.edits.length) phrases.push(fileText(tt, summary.edits, 'processEditFile', 'processEdits'))
  if (summary.creates.length) phrases.push(fileText(tt, summary.creates, 'processCreateFile', 'processCreates'))
  const counts = activityCounts(summary).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0])
  phrases.push(...counts.map(([n, one, many]) => countText(tt, n, one, many)))
  if (phrases.length) return joinActivities(phrases, tt('processKindJoin'))
  return summary.actions ? countText(tt, summary.actions, 'processActions1', 'processActions') : countText(tt, summary.thinking, 'processThinking1', 'processThinking')
}

function ProcessSegment({ segment, approvalIds, glowId, openThinking, alertFailures, staged }: {
  segment: TurnSegment
  approvalIds: ReadonlySet<string>
  glowId?: string | null
  openThinking: boolean
  alertFailures: boolean
  staged: boolean
}): JSX.Element {
  const steps = segmentSteps(segment)
  return (
    <div className="v3-process-seg" data-lead={steps[0]?.kind} data-tail={steps.at(-1)?.kind}>
      {steps.map((step) => step.kind === 'tools'
        ? <ToolSteps key={step.key} tools={step.tools} approvalIds={approvalIds} glowId={glowId} alertFailures={alertFailures} staged={staged} />
        : step.kind === 'thinking'
          ? <ThinkingLine key={step.key} text={step.thinking.text} ms={step.thinking.ms} live={step.thinking.live} startedAt={step.thinking.startedAt} step defaultOpen={openThinking} expansionId={`${segment.id}:${step.key}`} />
          : null)}
    </div>
  )
}
