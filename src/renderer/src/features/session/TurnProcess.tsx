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
import { conciseSegment, hasSegmentContent, mergeQuietSegments, splitAtCompaction, type CompactionCut, pickLiveSegments, processPreview, processSummary, segmentSteps, stageSegmentCount, withoutThinking, type ProcessFileChange, type ProcessSummary } from './turn-process'
import { ToolExpansionScope, useToolExpansion } from './use-tool-run'
import { toolExpansion } from './tool-expansion'
import { useRunProgress, useWorkingLine } from './run-status'
import { isHistoryQuestionCall } from './question-receipt'
import { QuestionHistory } from './QuestionReceipt'
import type { TranscriptView } from './transcript-view-model'
import type { ApprovalReceipt } from '../../../../shared/approval'
import { TurnApprovalLine } from './ApprovalReceipt'

const NO_APPROVALS: ReadonlySet<string> = new Set()
const NO_RECEIPTS: readonly ApprovalReceipt[] = []
const HISTORY_SEGMENTS = 12
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

export function TurnProcess({ process, live, openByDefault = false, alertFailures, showFailures = true, liveStartedAt = null, view, sessionId, turnId, approvalIds = NO_APPROVALS, glowId, elapsedMs, filesShownBelow = false, compactionAfter = null, approvals = NO_RECEIPTS }: {
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
  elapsedMs?: number
  filesShownBelow?: boolean
  compactionAfter?: CompactionCut | null
  approvals?: readonly ApprovalReceipt[]
}): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const panelId = useId()
  const key = `process:${turnId ?? process[0]?.id ?? ''}`
  const [manual, setManual] = useToolExpansion(key)
  const [showAll, setShowAll] = useToolExpansion(`${key}:all`)
  const summary = useMemo(() => processSummary(process), [process])
  const headless = !summary.thinking && !summary.actions
  const open = headless || (manual ?? (view === 'thinking' || (openByDefault && !live)))
  const stage = !open && live && manual !== false
  const visible = open || stage
  const steady = useSteadyHeight(live)
  const source = stage ? process.map(view === 'side' ? withoutThinking : conciseSegment).filter(hasSegmentContent) : process
  const halves = compactionAfter ? splitAtCompaction(source, compactionAfter) : null
  const before = halves ? mergeQuietSegments(halves.before) : null
  const merged = halves && before ? [...before, ...mergeQuietSegments(halves.after)] : mergeQuietSegments(source)
  const markerAfter = before?.at(-1)?.id ?? null
  const markerFirst = !!compactionAfter && (!halves || !before?.length)
  const expansionScope = useContext(ToolExpansionScope)
  const tracksOpened = live || process.length > HISTORY_SEGMENTS
  useSyncExternalStore(toolExpansion.subscribe, () => (tracksOpened ? openedCalls(process, expansionScope) : ''))
  const userOpened = (segment: TurnSegment): boolean => segment.tools.some((call) => callOpened(expansionScope, call.id))
  const picked = stage
    ? pickLiveSegments(merged, stageSegmentCount(merged), userOpened)
    : showAll !== true && (live || (open && merged.length > HISTORY_SEGMENTS)) ? pickLiveSegments(merged, live ? undefined : HISTORY_SEGMENTS, userOpened) : { shown: merged, hidden: 0 }
  const single = summary.thinking === 1 && !summary.actions
  const elapsed = !live && elapsedMs && elapsedMs > 0 ? formatDuration(elapsedMs) : null
  const preview = live ? '' : processPreview(process)
  const tip = [preview, processBreakdown(summary, tt), live && summary.failed ? t('tool.wsFailed', { n: summary.failed }) : ''].filter(Boolean).join('\n')
  const foldedQuestions = open || live ? [] : process.flatMap((segment) => segment.tools).filter((call) => !call.parentToolCallId && isHistoryQuestionCall(call) && call.status !== 'running' && call.status !== 'pending')

  const body = (
    <div ref={steady.ref} className="v3-process-body" role="group" aria-label={t('proc.title')} data-stage={stage || undefined} data-testid="v3-process-body" style={steady.minHeight ? { minHeight: steady.minHeight } : undefined}>
      {stage || picked.hidden > 0 || showAll === true ? (
        <Button size="sm" variant="ghost" className="v3-process-more" aria-expanded={showAll === true} onPress={() => { if (stage) setManual(true); setShowAll(showAll !== true) }} data-testid="v3-process-more">
          {stage ? t('proc.showAll') : showAll === true ? t('proc.showRecent') : tt('moreItems', { n: picked.hidden })}
        </Button>
      ) : null}
      <ToolTallyScope.Provider value>
        {markerFirst || markerAfter && !picked.shown.some((segment) => segment.id === markerAfter) && merged.findIndex((segment) => segment.id === markerAfter) < merged.indexOf(picked.shown[0]) ? <CompactionMarker /> : null}
        {picked.shown.map((segment) => (
          <Fragment key={segment.id}>
            <ProcessSegment segment={segment} sessionId={sessionId} approvalIds={approvalIds} glowId={glowId} openThinking={single} alertFailures={alertFailures} staged={stage} />
            {segment.id === markerAfter ? <CompactionMarker /> : null}
          </Fragment>
        ))}
      </ToolTallyScope.Provider>
    </div>
  )

  return (
    <>
    <Collapsible className="v3-process" data-open={open || undefined} data-live={live || undefined} data-headless={headless || undefined} data-testid="v3-process" isExpanded={visible} onExpandedChange={setManual}>
      {headless ? null : (
        <CollapsibleHeader
          className="v3-process-head"
          size="compact"
          chevron="start"
          rowHover
          aria-controls={panelId}
          icon={live ? <LiveProcessIcon /> : undefined}
          tone="emphasized"
          data-testid="v3-process-toggle"
        >
          <span className="v3-process-line" title={tip || undefined} data-testid="v3-process-line">
            {processParts(summary, tt, filesShownBelow && !live, live).map((part) => (
              <span key={part.key} className="v3-process-count" data-kind={part.kind}>
                {part.text}
                {part.file && part.file.added !== null && part.file.removed !== null && part.file.added + part.file.removed > 0 ? <DiffStat className="v3-process-diff" added={part.file.added} removed={part.file.removed} /> : null}
              </span>
            ))}
            {live ? <LiveElapsed startedAt={liveStartedAt} /> : elapsed ? <span className="v3-process-count ui-num" data-kind="elapsed">{elapsed}</span> : null}
            {summary.failed && showFailures && !live ? <span className={alertFailures ? 'v3-steps-stats err' : 'v3-steps-stats'} data-kind="failed" data-testid="v3-process-failed">{t('tool.wsFailed', { n: summary.failed })}</span> : null}
          </span>
        </CollapsibleHeader>
      )}
      {preview && !open ? <div className="v3-process-preview" data-testid="v3-process-preview">{preview}</div> : null}
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
    {approvals.length && !open ? <TurnApprovalLine approvals={approvals} /> : null}
    </>
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

const LEAD_ACTIVITIES = 2

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

function activityText(summary: ProcessSummary, tt: SessionText): string {
  const kinds = activityCounts(summary).filter(([n]) => n > 0)
  const named = kinds.filter(([, one]) => one !== 'processOther1')
  const lead = [...(named.length ? named : kinds)].sort((a, b) => b[0] - a[0]).slice(0, LEAD_ACTIVITIES)
  const shown = kinds.filter((kind) => lead.includes(kind)).map(([n, one, many]) => countText(tt, n, one, many))
  const text = joinActivities(shown, tt('processKindJoin'))
  return kinds.length > lead.length ? `${text}${tt('processMoreSteps', { n: summary.actions })}` : text
}

function processParts(summary: ProcessSummary, tt: SessionText, filesShownBelow = false, live = false): ProcessPart[] {
  const parts: ProcessPart[] = []
  if (!summary.actions && summary.thinking) parts.push({ key: 'thinking', kind: 'thinking', text: countText(tt, summary.thinking, 'processThinking1', 'processThinking') })
  const activity = activityText(summary, tt)
  if (activity) parts.push({ key: 'activity', kind: 'activity', text: activity })
  if (live) return parts.length ? parts : summary.actions ? [{ key: 'actions', kind: 'actions', text: countText(tt, summary.actions, 'processActions1', 'processActions') }] : parts
  if (summary.edits.length) parts.push({ key: 'edits', kind: 'edits', text: countText(tt, summary.edits.length, 'processEdits1', 'processEdits'), file: filesShownBelow ? undefined : totalLines(summary.edits) })
  if (summary.creates.length) parts.push({ key: 'creates', kind: 'creates', text: countText(tt, summary.creates.length, 'processCreates1', 'processCreates'), file: filesShownBelow ? undefined : totalLines(summary.creates) })
  if (!parts.length && summary.actions) parts.push({ key: 'actions', kind: 'actions', text: countText(tt, summary.actions, 'processActions1', 'processActions') })
  return parts
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

function processBreakdown(summary: ProcessSummary, tt: SessionText): string {
  const phrases = activityCounts(summary).filter(([n]) => n > 0).map(([n, one, many]) => countText(tt, n, one, many))
  if (summary.edits.length) phrases.push(fileText(tt, summary.edits, 'processEditFile', 'processEdits'))
  if (summary.creates.length) phrases.push(fileText(tt, summary.creates, 'processCreateFile', 'processCreates'))
  return joinActivities(phrases, tt('processKindJoin'))
}

function ProcessSegment({ segment, sessionId, approvalIds, glowId, openThinking, alertFailures, staged }: {
  segment: TurnSegment
  sessionId: string | null
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
        : step.kind === 'notes'
          ? (
              <div key={step.key} className="v3-process-notes">
                {step.notes.map((part) => (
                  <div key={part.id} className="v3-para dim">
                    <Markdown text={part.text} sourceCwd={part.sourceCwd} live={false} sessionId={sessionId} messageId={part.id} />
                  </div>
                ))}
              </div>
            )
          : <ThinkingLine key={step.key} text={step.thinking.text} ms={step.thinking.ms} live={step.thinking.live} startedAt={step.thinking.startedAt} step defaultOpen={openThinking} expansionId={`${segment.id}:${step.key}`} />)}
    </div>
  )
}
