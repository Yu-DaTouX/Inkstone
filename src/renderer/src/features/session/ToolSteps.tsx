import { memo, useRef, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { InlineImage } from '../../ui/InlineImage'
import type { FileDiff, UIToolCall } from '../../../../shared/ipc'
import { flattenToolNodes, type ToolCallNode } from '../../../../shared/tool-call-tree'
import { useSessionText } from './text'
import { callPath, editArgLines, readFileDiff, readPiDiff, type CallDiffLine } from './turn-changes'
import { generatingArgs, summarize, toolRunningLabel } from './tool-summary'
import { isDeniedCall, stepCategory, stepDescription, toolStepTitle, type ToolStepTitle } from './tool-title'
import { approvalCallIds, cachedToolRows, coalesceNodes, formatToolRun, liveToolGlowId, summarizeToolRun, toolCategory, toolNodesEqual, toolRunParts, type ToolRow, type ToolRowsCache } from './tool-run-model'
import { estimateCallLines } from './turn-process'
import { argEntries, isCodemodeTool, isTestCommand, isYanJsonCommand, parseTestSummary, parseYanSummaries, previewOutput, readLineRange, relativePath, toolOutputView, writeArgContent, type OutputNotice, type ToolOutputView, type YanSummary } from './tool-output'
import { HighlightedCode } from '../../patterns/HighlightedCode'
import { useStore } from '../../state/store'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { QuestionReceipt } from './QuestionReceipt'
import { ApprovalReceipt } from './ApprovalReceipt'
import { isQuestionCall } from './question-receipt'
import { ToolRunStats } from './ToolRunStats'
import { useHeldRunLabel, useToolExpansion } from './use-tool-run'
import { Icon, type SessionIconName } from './Icon'
import { Badge, Button, Collapsible, CollapsibleHeader, CollapsiblePanel, CompletionSweep, DiffStat, IconButton, ShimmerText, Spinner } from '../../ui'
import { McpAppResult, McpAppStepAudit } from '../artifacts/McpAppFrame'
import { SearchStepView } from './web-search/SearchStep'
import { searchStepsOf } from './web-search/model'

const OUTPUT_PREVIEW_LINES = 16
const OUTPUT_PREVIEW_CHARS = 1600
const CONTENT_PREVIEW_LINES = 40
const NEST_VISIBLE = 3

export function visibleNestedNodes<T>(children: readonly T[], showAll: boolean): { shown: readonly T[]; earlier: number } {
  if (showAll || children.length <= NEST_VISIBLE) return { shown: children, earlier: 0 }
  return { shown: children.slice(-NEST_VISIBLE), earlier: children.length - NEST_VISIBLE }
}
const NO_APPROVALS: ReadonlySet<string> = new Set()

export function detailKind(name: string): 'command' | 'code' | 'change' | 'result' {
  if (isCodemodeTool(name)) return 'code'
  if (name === 'bash' || name === 'powershell' || name === 'shell' || name === 'run' || name === 'exec') return 'command'
  if (name === 'edit' || name === 'write' || name === 'multi_edit' || name === 'multiEdit' || name === 'apply_patch' || name === 'patch') return 'change'
  return 'result'
}

export function stepIconName(call: UIToolCall): SessionIconName {
  if (isCodemodeTool(call.name)) return 'code'
  switch (toolCategory(call)) {
    case 'command': return 'terminal'
    case 'read': return 'eye'
    case 'edit':
    case 'create':
    case 'delete': return 'edit'
    case 'search': return 'search'
    case 'list': return 'folder'
    case 'fetch':
    case 'web': return 'globe'
    case 'agent': return 'bot'
    case 'todo': return 'tree'
    default: return 'wrench'
  }
}

export function groupIconName(nodes: readonly ToolCallNode[]): SessionIconName {
  const icons = new Set(flattenToolNodes([...nodes]).filter((node) => !node.children.length).map((node) => stepIconName(node.call)))
  return icons.size === 1 ? [...icons][0] : 'layers'
}

function isRunning(call: UIToolCall): boolean {
  return call.status === 'running' || call.status === 'pending'
}

function useCurrentApprovalCall(tools: readonly UIToolCall[], approvalIds: ReadonlySet<string>): string | null {
  const current = useStore((s) => s.approvals[0])
  if (!current || current.subagentId || !approvalIds.size) return null
  for (const id of approvalCallIds([current], tools)) {
    if (approvalIds.has(id) && tools.some((call) => call.id === id)) return id
  }
  return null
}

function holdsCall(nodes: readonly ToolCallNode[], id: string): boolean {
  return nodes.some((node) => node.call.id === id || holdsCall(node.children, id))
}

export function ToolSteps({ tools, approvalIds = NO_APPROVALS, glowId = liveToolGlowId(tools), alertFailures = true }: { tools: UIToolCall[]; approvalIds?: ReadonlySet<string>; glowId?: string | null; alertFailures?: boolean }): JSX.Element | null {
  const t = useT()
  const approvalCall = useCurrentApprovalCall(tools, approvalIds)
  const askedCalls = useStore((s) => s.uiRequests)
  const cache = useRef<ToolRowsCache | null>(null)
  const ready = tools.some(generatingArgs) ? tools.filter((call) => !generatingArgs(call)) : tools
  if (!ready.length) return null
  cache.current = cachedToolRows(cache.current, ready, approvalIds)
  const rows = cache.current.rows
  if (!rows.length) return null
  return (
    <section className="v3-steps" data-testid="v3-steps" aria-label={t('proc.title')}>
      <div className="v3-steps-list" data-testid="v3-steps-list">
        {rows.map((row) => {
          if (row.kind === 'group') return <MemoToolGroupRow key={row.id} row={row} glowId={glowId} alertFailures={alertFailures} asking={!!approvalCall && holdsCall(row.nodes, approvalCall)} />
          if (row.standalone && isQuestionCall(row.node.call)) {
            const callId = row.node.call.id
            const asked = askedCalls.find((request) => request.toolCallId === callId)
            return asked
              ? <QuestionCard key={row.id} requestId={asked.id} />
              : <QuestionReceipt key={row.id} call={row.node.call} />
          }
          return <MemoStepNode key={row.id} node={row.node} glowId={glowId} depth={0} blocked={row.blocked} asking={!!approvalCall && holdsCall([row.node], approvalCall)} />
        })}
      </div>
    </section>
  )
}

type StepNodeProps = { node: ToolCallNode; depth: number; glowId: string | null; blocked?: boolean; repeat?: number; asking?: boolean }

function sameStepProps(a: StepNodeProps, b: StepNodeProps): boolean {
  return a.depth === b.depth && a.glowId === b.glowId && !a.blocked === !b.blocked && (a.repeat ?? 1) === (b.repeat ?? 1) && !a.asking === !b.asking && (a.node === b.node || toolNodesEqual([a.node], [b.node]))
}

function ToolGroupRow({ row, asking, glowId, alertFailures }: { row: Extract<ToolRow, { kind: 'group' }>; asking: boolean; glowId: string | null; alertFailures: boolean }): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const [stored, setOpen] = useToolExpansion(row.id)
  const open = stored ?? false
  const { summary } = row
  const label = formatToolRun(summary, tt)
  const parts = toolRunParts(summary, tt)
  const running = summary.running
  const held = useHeldRunLabel(running ? running.id : null, running ? toolRunningLabel(running, t('tool2.generatingArgs'), tt) : label)
  const shown = held.key !== null ? held.label : label
  const members = open ? coalesceNodes(row.nodes) : []

  return (
    <Collapsible className="v3-step v3-step-group" data-state={summary.state} data-depth={0} isExpanded={open} onExpandedChange={setOpen}>
      <CollapsibleHeader className="v3-step-head" size="compact" chevron="end" data-testid="v3-step-group" icon={<Icon name={groupIconName(row.nodes)} size={13} />}>
        <span className="v3-step-line" title={label}>
          {running ? (
            <ShimmerText className="v3-steps-label" active={!open && !!glowId && holdsCall(row.nodes, glowId)}>{shown}</ShimmerText>
          ) : (
            <span className="v3-steps-label">
              {parts.map((part, index) => <span key={index} data-failed={(part.failed && alertFailures) || undefined}>{part.text}</span>)}
            </span>
          )}
          <ToolRunStats summary={summary} alertFailures={alertFailures} />
          {summary.state === 'cancelled' ? <Badge className="v3-steps-badge" data-testid="v3-step-group-cancelled">{t('run.cancelled')}</Badge> : null}
          {summary.needsApproval ? <Badge tone="ask" className="v3-steps-badge" data-testid="v3-step-group-approval">{tt('runNeedsApproval')}</Badge> : null}
        </span>
      </CollapsibleHeader>
      {asking ? <ApprovalCard inline /> : null}
      <CollapsiblePanel className="v3-step-panel" aria-label={label}>
        {open ? (
          <div className="v3-step-nest" data-testid="v3-step-group-list">
            {members.map((member) => <MemoStepNode key={member.node.call.id} node={member.node} glowId={glowId} depth={1} repeat={member.repeat} />)}
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  )
}

function StepNode({ node, depth, glowId, blocked = false, repeat = 1, asking = false }: StepNodeProps): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const [stored, setOpen] = useToolExpansion(`step:${node.call.id}`)
  const [nestAll, setNestAll] = useToolExpansion(`nest:${node.call.id}`)
  const call = node.call
  const running = isRunning(call)
  const denied = isDeniedCall(call)
  const open = stored ?? false
  const children = depth + 1 >= 4 ? flattenToolNodes(node.children) : node.children
  const nestedTitle = nestedStepTitle(call, node.children, tt)
  const title = nestedTitle ?? toolStepTitle(call, tt)
  const selfContained = !!nestedTitle || (stepCategory(call.name) === 'bash' && !!stepDescription(call))
  const meta = generatingArgs(call) ? t('tool2.generatingArgs') : title.meta || (selfContained ? '' : t('tool2.noTarget'))
  const nested = collapsedNest(visibleNestedNodes(children, nestAll === true), children, open, running)
  const searches = nestedTitle || blocked || asking ? [] : searchStepsOf(call)
  const failed = call.status === 'error' && !call.cancelled && !denied
  const kind = detailKind(call.name)
  const command = kind === 'command' ? commandOf(call) : ''
  const settledView = !running && call.output && (kind === 'command' || failed) ? toolOutputView(call.name, call.output) : null
  const exitCode = failed && settledView && settledView.exitCode !== null && settledView.exitCode !== 0 ? settledView.exitCode : null
  const tests = command && settledView && isTestCommand(command) ? parseTestSummary(settledView.body) : null
  const lines = kind === 'change' && call.status === 'ok' && !call.cancelled && !nestedTitle ? estimateCallLines(call) : null
  const tooltip = [`${title.label} ${meta}`.trim(), title.hint ?? ''].filter(Boolean).join('\n')

  const step = (
    <>
      <CollapsibleHeader className="v3-step-head" size="compact" chevron="end" data-testid="v3-step" icon={<Icon name={stepIconName(call)} size={13} />}>
        <CompletionSweep done={!running && !call.cancelled && !denied} settledAt={call.endedAt} />
        <span className="v3-step-line" title={tooltip}>
          <span className="v3-step-label">
            <ShimmerText active={running && !blocked && call.id === glowId}>{title.label}</ShimmerText>
          </span>
          {denied ? <Icon name="deny" size={13} className="v3-step-deny" /> : null}
          {meta ? (
            <span className="v3-step-target" data-code={title.code || undefined}>
              {meta}
            </span>
          ) : null}
          {lines ? <DiffStat className="v3-step-diff" added={lines.added} removed={lines.removed} data-testid="v3-step-diff-stat" /> : null}
          {tests ? <Badge tone={tests.failed ? 'fail' : 'ok'} className="v3-steps-badge" data-testid="v3-step-tests">{tt('testSummary', { p: tests.passed, f: tests.failed })}</Badge> : null}
          {kind === 'command' && running && !blocked ? <Spinner size="xs" className="v3-step-state" label={tt('stepRunningMark')} /> : null}
          {kind === 'command' && call.status === 'ok' && !call.cancelled ? <span className="v3-step-state" role="img" aria-label={tt('stepDoneMark')} data-testid="v3-step-done"><Icon name="check" size={13} /></span> : null}
          {failed ? <span className="v3-step-fail" role="img" aria-label={tt('stepFailedMark')} data-testid="v3-step-failed"><Icon name="close" size={13} /></span> : null}
          {exitCode !== null ? <span className="v3-step-time" data-testid="v3-step-exit-code">{tt('exitCode', { n: exitCode })}</span> : null}
          {call.cancelled ? <Badge className="v3-steps-badge" data-testid="v3-step-cancelled">{t('run.cancelled')}</Badge> : null}
          {repeat > 1 ? <span className="v3-step-time">{tt('runRepeat', { n: repeat })}</span> : null}
          {blocked ? <Badge tone="ask" className="v3-steps-badge" data-testid="v3-step-approval">{tt('runNeedsApproval')}</Badge> : null}
        </span>
      </CollapsibleHeader>
      {asking ? <ApprovalCard inline /> : call.approval ? <ApprovalReceipt approval={call.approval} /> : null}
      <CollapsiblePanel className="v3-step-panel">{open ? <StepDetail call={call} /> : null}</CollapsiblePanel>
      {nested.shown.length ? (
        <div className="v3-step-nest" role="group" aria-label={t('tool2.nestLabel', { n: children.length })}>
          {nested.earlier ? (
            <Button variant="ghost" size="sm" className="v3-step-earlier" onPress={() => setNestAll(true)} data-testid="v3-step-earlier">
              {t('tool2.nestEarlier', { n: nested.earlier })}
            </Button>
          ) : null}
          {nested.shown.map((child) => <MemoStepNode key={child.call.id} node={child} glowId={glowId} depth={depth + 1} />)}
        </div>
      ) : null}
    </>
  )

  return (
    <Collapsible className="v3-step" data-state={call.cancelled ? 'cancelled' : denied ? 'denied' : call.status} data-tool={call.name} data-depth={depth} isExpanded={open} onExpandedChange={setOpen}>
      {searches.length
        ? searches.map((search, i) => (
            <SearchStepView key={i} call={call} step={search} glow={call.id === glowId}>{i === 0 ? step : null}</SearchStepView>
          ))
        : step}
    </Collapsible>
  )
}

const MemoToolGroupRow = memo(ToolGroupRow)
const MemoStepNode = memo(StepNode, sameStepProps)

export function collapsedNest<T>(nested: { shown: readonly T[]; earlier: number }, children: readonly T[], open: boolean, running: boolean): { shown: readonly T[]; earlier: number } {
  if (open) return nested
  if (running && children.length) return { shown: children.slice(-1), earlier: 0 }
  return { shown: [], earlier: 0 }
}

function nestedStepTitle(call: UIToolCall, children: readonly ToolCallNode[], tt: ReturnType<typeof useSessionText>): ToolStepTitle | null {
  if (!children.length || stepDescription(call)) return null
  const label = formatToolRun(summarizeToolRun(flattenToolNodes([...children]).map((child) => child.call)), tt)
  return label ? { label, meta: '', code: false } : null
}

function commandOf(call: UIToolCall): string {
  const args = call.args as Record<string, unknown> | undefined
  if (!args || typeof args !== 'object') return ''
  for (const key of ['command', 'cmd', 'script', 'code']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

const COMMAND_ARG_KEYS = ['command', 'cmd', 'script', 'code', 'timeout', 'description']
const READ_ARG_KEYS = ['path', 'file_path', 'file', 'offset', 'limit']

function hasArgs(call: UIToolCall): boolean {
  return !!call.args && typeof call.args === 'object' && Object.keys(call.args as object).length > 0
}

function StepDetail({ call }: { call: UIToolCall }): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const cwd = useStore((s) => s.session?.cwd)
  const [copied, setCopied] = useState(false)
  const kind = detailKind(call.name)
  const diff = readFileDiff(call.details)
  const command = kind === 'command' || kind === 'code' ? commandOf(call) : ''
  const readPath = kind === 'result' && stepCategory(call.name) === 'read' ? callPath(call) : ''
  const skip = command ? COMMAND_ARG_KEYS : readPath ? READ_ARG_KEYS : []
  const entries = argEntries(call.args, skip)
  const rawArgs = !hasArgs(call) && !command && !readPath ? call.argsRaw ?? '' : ''
  const argsShown = entries.length > 0 || !!rawArgs
  const onlyCommand = !!command && !entries.length
  const copyText = [command ? (kind === 'code' ? command : `$ ${command}`) : '', call.args && !onlyCommand ? JSON.stringify(call.args, null, 2) : onlyCommand ? '' : call.argsRaw ?? '', call.output ?? ''].filter(Boolean).join('\n\n')
  const failed = call.status === 'error' && !call.cancelled && !isDeniedCall(call)
  const view = call.output ? toolOutputView(call.name, call.output) : null
  const yan = kind === 'command' && view && isYanJsonCommand(command) ? parseYanSummaries(view.body) : null
  const body = yan ? yan.rest : view?.body ?? ''
  const range = readLineRange(call.args)
  const copy = (): void => {
    void navigator.clipboard.writeText(copyText || summarize(call)).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600) },
      () => undefined
    )
  }

  return (
    <div className="v3-step-detail" data-kind={kind}>
      <div className="v3-step-detail-bar">
        <IconButton size="sm" aria-label={t('tool.copyDetail')} tooltip={t('tool.copyDetail')} onPress={copy}><Icon name={copied ? 'check' : 'copy'} size={14} /></IconButton>
      </div>
      {call.historySummary ? <div className="v3-step-note">{t('tool2.historySummary')}</div> : null}
      {call.nestedCallsIncomplete ? <div className="v3-step-note">{t('tool2.nestedIncomplete')}</div> : null}
      {call.images?.length ? (
        <div className="v3-step-images">
          {call.images.map((im, i) => im.data ? <InlineImage key={i} src={`data:${im.mimeType};base64,${im.data}`} alt={t('tool.image', { tool: call.name })} className="v3-md-image" /> : im.url ? <InlineImage key={i} src={im.url} alt={t('tool.image', { tool: call.name })} className="v3-md-image" /> : null)}
        </div>
      ) : null}
      {kind === 'change' ? (
        <ChangeDetail call={call} diff={diff} cwd={cwd} />
      ) : (
        <>
          {command && kind === 'code' ? (
            <section className="v3-step-sec" data-sec="code">
              <pre className="v3-step-code" data-testid="v3-step-code"><HighlightedCode code={command} lang="javascript" /></pre>
            </section>
          ) : command ? (
            <section className="v3-step-sec" data-sec="command">
              <pre className="v3-step-cmd-line"><span className="v3-step-cmd-prompt" aria-hidden>$ </span>{command}</pre>
            </section>
          ) : null}
          {readPath ? (
            <section className="v3-step-sec" data-sec="path">
              <div className="v3-step-path" data-testid="v3-step-read-path">
                <Icon name="file" size={13} />
                <span title={readPath}>{relativePath(readPath, cwd)}</span>
                {range ? <span className="v3-step-status">{range.to === null ? tt('stepLinesFrom', { a: range.from }) : tt('stepLines', { a: range.from, b: range.to })}</span> : null}
              </div>
            </section>
          ) : null}
          {argsShown ? (
            <section className="v3-step-sec" data-sec="args">
              <div className="v3-step-sec-head">{tt('detailArgs')}</div>
              {rawArgs ? <pre className="v3-step-pre args">{rawArgs}</pre> : <ArgList entries={entries} />}
            </section>
          ) : null}
          {view && (body || yan || view.notices.length || (view.exitCode !== null && view.exitCode !== 0)) ? (
            <section className="v3-step-sec" data-sec="output">
              {argsShown ? <div className="v3-step-sec-head">{tt('detailOutput')}</div> : null}
              {yan ? <YanSummaryList summaries={yan.summaries} /> : null}
              {body ? <StepOutput text={body} error={failed || !!call.cancelled} tail={kind !== 'result' || failed} /> : null}
              <OutputNotes view={view} />
            </section>
          ) : call.status === 'ok' ? <div className="v3-step-note">{t('tool.noOutput')}</div> : null}
          {call.name.startsWith('mcp__') ? (
            <>
              <McpAppResult callId={call.id} title={call.name} />
              <McpAppStepAudit callId={call.id} />
            </>
          ) : null}
        </>
      )}
    </div>
  )
}

function ArgList({ entries }: { entries: ReturnType<typeof argEntries> }): JSX.Element {
  return (
    <dl className="v3-step-args" data-testid="v3-step-args">
      {entries.map((entry) => (
        <div key={entry.key} className="v3-step-arg" data-block={entry.block || undefined}>
          <dt className="v3-step-arg-key">{entry.key}</dt>
          <dd className="v3-step-arg-value">{entry.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function noticeText(notice: OutputNotice, tt: ReturnType<typeof useSessionText>): string {
  if (notice.kind === 'truncated') return notice.path ? tt('outputTruncatedPath', { path: notice.path }) : tt('outputTruncated')
  if (notice.kind === 'lines') {
    const lines = tt('outputLinesOf', { a: notice.from, b: notice.to, n: notice.total })
    return notice.path ? `${lines} \u00b7 ${tt('outputTruncatedPath', { path: notice.path })}` : lines
  }
  if (notice.kind === 'more') return tt('outputMoreInFile', { n: notice.n })
  return notice.text
}

function OutputNotes({ view }: { view: ToolOutputView }): JSX.Element | null {
  const tt = useSessionText()
  const exit = view.exitCode !== null && view.exitCode !== 0 ? view.exitCode : null
  if (!view.notices.length && exit === null) return null
  return (
    <>
      {view.notices.length ? <div className="v3-step-note" data-testid="v3-step-output-notice">{view.notices.map((notice) => noticeText(notice, tt)).join(' \u00b7 ')}</div> : null}
      {exit !== null ? <div className="v3-step-exit" data-testid="v3-step-exit">{tt('exitCode', { n: exit })}</div> : null}
    </>
  )
}

function YanSummaryList({ summaries }: { summaries: readonly YanSummary[] }): JSX.Element {
  const tt = useSessionText()
  return (
    <div className="v3-step-summary" data-testid="v3-step-yan-summary">
      {summaries.map((summary, i) => (
        <div key={i} className="v3-step-summary-item">
          <div className="v3-step-summary-title">{summary.kind === 'search' ? (summary.count !== null ? tt('yanSearchResults', { n: summary.count }) : tt('yanSearch')) : summary.title}</div>
          {summary.points.length ? (
            <ul className="v3-step-summary-points">
              {summary.points.map((point, j) => <li key={j}>{point}</li>)}
            </ul>
          ) : null}
          {summary.kind === 'page' && summary.body ? <StepOutput text={summary.body} /> : null}
        </div>
      ))}
    </div>
  )
}

function StepOutput({ text, error = false, tail = false }: { text: string; error?: boolean; tail?: boolean }): JSX.Element {
  const tt = useSessionText()
  const [expanded, setExpanded] = useState(false)
  const preview = previewOutput(text, { tail, maxLines: OUTPUT_PREVIEW_LINES, maxChars: OUTPUT_PREVIEW_CHARS })
  const truncated = preview.hidden > 0
  const shown = truncated && !expanded ? preview.text : text
  const leadShown = error && (!truncated || expanded || !tail)
  const cut = shown.indexOf('\n')
  return (
    <>
      {truncated && !expanded && tail ? <div className="v3-step-note" data-testid="v3-step-output-earlier">{tt('outputEarlier', { n: preview.hidden })}</div> : null}
      <pre className="v3-step-pre out" data-testid="v3-step-output" data-error={error || undefined} role="group">
        {leadShown ? (
          <>
            <span className="v3-step-out-lead">{cut < 0 ? shown : shown.slice(0, cut)}</span>
            {cut < 0 ? null : shown.slice(cut)}
          </>
        ) : shown}
      </pre>
      {truncated ? (
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          data-testid="v3-step-output-toggle"
          onPress={() => setExpanded((v) => !v)}
        >
          {expanded ? tt('outputLess') : tt('outputMore', { n: preview.total })}
        </Button>
      ) : null}
    </>
  )
}

function DiffLines({ lines }: { lines: readonly CallDiffLine[] }): JSX.Element {
  const numbered = lines.some((line) => line.num !== null)
  return (
    <pre className="v3-step-patch" data-numbered={numbered || undefined} data-testid="v3-step-diff">
      {lines.map((line, i) => line.kind === 'skip' ? (
        <span key={i} className="v3-diff-line" data-kind="skip">{'\u22ef\n'}</span>
      ) : (
        <span key={i} className="v3-diff-line" data-kind={line.kind}>
          {numbered ? <span className="v3-diff-num" aria-hidden>{line.num ?? ''}</span> : null}
          <span className="v3-diff-sign" aria-hidden>{line.kind === 'add' ? '+' : line.kind === 'del' ? '\u2212' : ' '}</span>
          {line.text}{'\n'}
        </span>
      ))}
    </pre>
  )
}

function languageOf(path: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]
  return ext ? ext.toLowerCase() : null
}

function FileContentPreview({ path, content }: { path: string; content: string }): JSX.Element {
  const tt = useSessionText()
  const [all, setAll] = useState(false)
  const lines = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const long = lines.length > CONTENT_PREVIEW_LINES
  const shown = long && !all ? lines.slice(0, CONTENT_PREVIEW_LINES).join('\n') : lines.join('\n')
  return (
    <>
      <pre className="v3-step-patch v3-step-file" data-testid="v3-step-content"><HighlightedCode code={shown} lang={languageOf(path)} /></pre>
      {long ? (
        <Button size="sm" variant="ghost" aria-expanded={all} data-testid="v3-step-content-toggle" onPress={() => setAll((v) => !v)}>
          {all ? tt('contentLess') : tt('contentMore', { n: lines.length })}
        </Button>
      ) : null}
    </>
  )
}

function ChangeDetail({ call, diff, cwd }: { call: UIToolCall; diff: FileDiff | null; cwd?: string }): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const denied = isDeniedCall(call)
  const failed = call.status === 'error' && !call.cancelled && !denied
  if (!diff) {
    const path = callPath(call)
    const pi = readPiDiff(call.details)
    const fallback = pi ? null : editArgLines(call.args)
    const content = pi || fallback ? null : writeArgContent(call.args)
    const contentLines = content === null ? 0 : content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length
    const showOutput = !!call.output && (failed || (!pi && !fallback && content === null))
    return (
      <>
        <div className="v3-step-path">
          <Icon name="file" size={13} />
          <span title={path}>{path ? relativePath(path, cwd) : call.name}</span>
          {content !== null ? <span className="v3-step-status">{tt('contentLines', { n: contentLines })}</span> : null}
          <span className="v3-code-sp" />
          {pi ? <span className="v3-add">+{pi.added}</span> : null}
          {pi ? <span className="v3-del">−{pi.removed}</span> : null}
        </div>
        {failed ? <div className="v3-step-note err">{t('tool.notApplied')}</div> : null}
        {showOutput ? <StepOutput text={toolOutputView(call.name, call.output ?? '').body} error={failed} tail={failed} /> : null}
        {pi ? <DiffLines lines={pi.lines} /> : fallback ? (
          <>
            <div className="v3-step-note">{t('tool.diffUnavailable')}</div>
            <DiffLines lines={fallback} />
          </>
        ) : content !== null ? <FileContentPreview path={path} content={content} /> : <div className="v3-step-note">{t('tool.diffUnavailable')}</div>}
      </>
    )
  }
  const status = diff.status === 'created' ? t('tool.diffCreated') : diff.status === 'deleted' ? t('tool.diffDeleted') : diff.status === 'unchanged' ? t('tool.diffUnchanged') : ''
  const tooLarge = diff.before.tooLarge || diff.after.tooLarge
  return (
    <>
      <div className="v3-step-path">
        <Icon name="file" size={13} />
        <span title={diff.path}>{relativePath(diff.path, cwd)}</span>
        {status ? <span className="v3-step-status">{status}</span> : null}
        <span className="v3-code-sp" />
        {diff.added >= 0 ? <span className="v3-add">+{diff.added}</span> : null}
        {diff.removed >= 0 ? <span className="v3-del">−{diff.removed}</span> : null}
      </div>
      {failed ? <div className="v3-step-note err">{t('tool.notApplied')}</div> : null}
      {tooLarge ? <div className="v3-step-note">{t('tool.diffTooLarge')}</div> : null}
      {diff.patch ? (
        <pre className="v3-step-patch">
          {diff.patch.split('\n').map((line, i) => (
            <span key={i} className="v3-diff-line" data-kind={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context'}>{line}{'\n'}</span>
          ))}
        </pre>
      ) : !tooLarge && diff.status !== 'unchanged' ? <div className="v3-step-note">{t('tool.diffNoPatch')}</div> : null}
    </>
  )
}
