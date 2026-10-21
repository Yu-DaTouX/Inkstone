import { useState, type JSX } from 'react'
import { useT } from '../../i18n'
import type { FileDiff, UIToolCall } from '../../../../shared/ipc'
import { flattenToolNodes, type ToolCallNode } from '../../../../shared/tool-call-tree'
import { useSessionText } from './text'
import { callPath, readFileDiff } from './turn-changes'
import { generatingArgs, summarize, toolRunningLabel } from './tool-summary'
import { isDeniedCall, shellTitle, toolStepTitle } from './tool-title'
import { approvalCallIds, buildToolRows, coalesceNodes, formatToolRun, toolRunParts, type ToolRow } from './tool-run-model'
import { useStore } from '../../state/store'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { QuestionReceipt } from './QuestionReceipt'
import { isQuestionCall } from './question-receipt'
import { ToolRunStats } from './ToolRunStats'
import { useHeldRunLabel, useToolExpansion, useTranscriptViewScope } from './use-tool-run'
import { opensEverything } from './transcript-view-model'
import { Icon } from './Icon'
import { Badge, Button, CompletionSweep, IconButton, ShimmerText } from '../../ui'
import { McpAppResult, McpAppStepAudit } from '../artifacts/McpAppFrame'

const OUTPUT_PREVIEW_LINES = 16
export const NEST_VISIBLE = 3

export function visibleNestedNodes<T>(children: readonly T[], showAll: boolean): { shown: readonly T[]; earlier: number } {
  if (showAll || children.length <= NEST_VISIBLE) return { shown: children, earlier: 0 }
  return { shown: children.slice(-NEST_VISIBLE), earlier: children.length - NEST_VISIBLE }
}
const NO_APPROVALS: ReadonlySet<string> = new Set()

export function detailKind(name: string): 'command' | 'change' | 'result' {
  if (name === 'bash' || name === 'powershell' || name === 'shell' || name === 'run' || name === 'exec') return 'command'
  if (name === 'edit' || name === 'write' || name === 'multi_edit' || name === 'multiEdit' || name === 'apply_patch' || name === 'patch') return 'change'
  return 'result'
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

export function ToolSteps({ tools, approvalIds = NO_APPROVALS }: { tools: UIToolCall[]; approvalIds?: ReadonlySet<string> }): JSX.Element | null {
  const t = useT()
  const approvalCall = useCurrentApprovalCall(tools, approvalIds)
  const askedCalls = useStore((s) => s.uiRequests)
  if (!tools.length) return null
  const rows = buildToolRows(tools, approvalIds)
  return (
    <section className="v3-steps" data-testid="v3-steps" aria-label={t('proc.title')}>
      <div className="v3-steps-list" data-testid="v3-steps-list">
        {rows.map((row) => {
          if (row.kind === 'group') return <ToolGroupRow key={row.id} row={row} asking={!!approvalCall && holdsCall(row.nodes, approvalCall)} />
          if (row.standalone && isQuestionCall(row.node.call)) {
            const callId = row.node.call.id
            const asked = askedCalls.find((request) => request.toolCallId === callId)
            return asked
              ? <QuestionCard key={row.id} requestId={asked.id} />
              : <QuestionReceipt key={row.id} call={row.node.call} />
          }
          return <StepNode key={row.id} node={row.node} depth={0} blocked={row.blocked} asking={!!approvalCall && holdsCall([row.node], approvalCall)} />
        })}
      </div>
    </section>
  )
}

function ToolGroupRow({ row, asking }: { row: Extract<ToolRow, { kind: 'group' }>; asking: boolean }): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const [stored, setOpen] = useToolExpansion(row.id)
  const verbose = opensEverything(useTranscriptViewScope())
  const open = stored ?? verbose
  const { summary } = row
  const label = formatToolRun(summary, tt)
  const parts = toolRunParts(summary, tt)
  const running = summary.running
  const held = useHeldRunLabel(running ? running.id : null, running ? toolRunningLabel(running, t('tool2.generatingArgs'), tt) : label)
  const shown = held.key !== null ? held.label : label
  const members = open ? coalesceNodes(row.nodes) : []

  return (
    <div className="v3-step v3-step-group" data-state={summary.state} data-depth={0}>
      <button className="v3-step-head" aria-expanded={open} onClick={() => setOpen(!open)} title={label} data-testid="v3-step-group">
        {running ? (
          <ShimmerText className="v3-steps-label" active>{shown}</ShimmerText>
        ) : (
          <span className="v3-steps-label">
            {parts.map((part, index) => <span key={index} data-failed={part.failed || undefined}>{part.text}</span>)}
          </span>
        )}
        <ToolRunStats summary={summary} />
        {summary.needsApproval ? <Badge tone="ask" className="v3-steps-badge" data-testid="v3-step-group-approval">{tt('runNeedsApproval')}</Badge> : null}
        <Icon name="chevron-right" size={14} className="v3-chev" />
      </button>
      {asking ? <ApprovalCard inline /> : null}
      {open ? (
        <div className="v3-step-nest" role="group" aria-label={label} data-testid="v3-step-group-list">
          {members.map((member) => <StepNode key={member.node.call.id} node={member.node} depth={1} repeat={member.repeat} />)}
        </div>
      ) : null}
    </div>
  )
}

function StepNode({ node, depth, blocked = false, repeat = 1, asking = false }: { node: ToolCallNode; depth: number; blocked?: boolean; repeat?: number; asking?: boolean }): JSX.Element {
  const t = useT()
  const tt = useSessionText()
  const [stored, setOpen] = useToolExpansion(`step:${node.call.id}`)
  const [nestAll, setNestAll] = useToolExpansion(`nest:${node.call.id}`)
  const call = node.call
  const running = isRunning(call)
  const denied = isDeniedCall(call)
  const verbose = opensEverything(useTranscriptViewScope())
  const open = stored ?? verbose
  const title = toolStepTitle(call, tt)
  const meta = generatingArgs(call) ? t('tool2.generatingArgs') : title.meta || t('tool2.noTarget')
  const children = depth + 1 >= 4 ? flattenToolNodes(node.children) : node.children
  const nested = visibleNestedNodes(children, nestAll === true || verbose)

  return (
    <div className="v3-step" data-state={denied ? 'denied' : call.status} data-tool={call.name} data-depth={depth}>
      <button className="v3-step-head" aria-expanded={open} onClick={() => setOpen(!open)} title={`${title.label} ${meta}`.trim()} data-testid="v3-step">
        <CompletionSweep done={!running && !call.cancelled && !denied} settledAt={call.endedAt} />
        <span className="v3-step-label">
          <ShimmerText active={running && !blocked}>{title.label}</ShimmerText>
        </span>
        {denied ? <Icon name="deny" size={13} className="v3-step-deny" /> : null}
        <span className="v3-step-target" data-code={title.code || undefined}>
          <ShimmerText active={running && !blocked}>{meta}</ShimmerText>
        </span>
        {repeat > 1 ? <span className="v3-step-time">{tt('runRepeat', { n: repeat })}</span> : null}
        {blocked ? <Badge tone="ask" className="v3-steps-badge" data-testid="v3-step-approval">{tt('runNeedsApproval')}</Badge> : null}
        <Icon name="chevron-right" size={14} className="v3-chev" />
      </button>
      {asking ? <ApprovalCard inline /> : null}
      {open ? <StepDetail call={call} /> : null}
      {children.length ? (
        <div className="v3-step-nest" role="group" aria-label={t('tool2.nestLabel', { n: children.length })}>
          {nested.earlier ? (
            <Button variant="ghost" size="sm" className="v3-step-earlier" onPress={() => setNestAll(true)} data-testid="v3-step-earlier">
              {t('tool2.nestEarlier', { n: nested.earlier })}
            </Button>
          ) : null}
          {nested.shown.map((child) => <StepNode key={child.call.id} node={child} depth={depth + 1} />)}
        </div>
      ) : null}
    </div>
  )
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

function StepDetail({ call }: { call: UIToolCall }): JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const kind = detailKind(call.name)
  const diff = readFileDiff(call.details)
  const args = call.args as Record<string, unknown> | undefined
  const command = kind === 'command' ? commandOf(call) : ''
  const onlyCommand = !!command && Object.keys(args ?? {}).every((k) => k === 'command' || k === 'timeout')
  const argsText = onlyCommand ? '' : call.args && Object.keys(call.args as object).length ? JSON.stringify(call.args, null, 2) : call.argsRaw ?? ''
  const copyText = [command ? `$ ${command}` : '', call.args && !onlyCommand ? JSON.stringify(call.args, null, 2) : onlyCommand ? '' : call.argsRaw ?? '', call.output ?? ''].filter(Boolean).join('\n\n')
  const failed = call.status === 'error' && !call.cancelled && !isDeniedCall(call)
  const copy = (): void => {
    void navigator.clipboard.writeText(copyText || summarize(call)).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600) },
      () => undefined
    )
  }

  return (
    <div className="v3-step-detail" data-kind={kind}>
      <div className="v3-step-detail-bar">
        {call.historySummary ? <span className="v3-step-note">{t('tool2.historySummary')}</span> : null}
        <span className="v3-code-sp" />
        <IconButton size="sm" aria-label={t('tool.copyDetail')} onPress={copy}><Icon name={copied ? 'check' : 'copy'} size={14} /></IconButton>
      </div>
      {call.nestedCallsIncomplete ? <div className="v3-step-note">{t('tool2.nestedIncomplete')}</div> : null}
      {call.images?.length ? (
        <div className="v3-step-images">
          {call.images.map((im, i) => im.data ? <img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt={t('tool.image', { tool: call.name })} className="v3-md-image" /> : im.url ? <img key={i} src={im.url} alt={t('tool.image', { tool: call.name })} className="v3-md-image" /> : null)}
        </div>
      ) : null}
      {kind === 'change' ? (
        <ChangeDetail call={call} diff={diff} />
      ) : (
        <>
          {command ? (
            <div className="v3-step-cmd">
              <div className="v3-step-cmd-head">{shellTitle(call.name)}</div>
              <pre className="v3-step-cmd-line"><span className="v3-step-cmd-prompt" aria-hidden>$ </span>{command}</pre>
            </div>
          ) : null}
          {onlyCommand ? null : argsText ? <pre className="v3-step-pre args">{argsText}</pre> : null}
          {call.output ? <StepOutput text={call.output} error={failed || call.cancelled} /> : call.status === 'ok' ? <div className="v3-step-note">{t('tool.noOutput')}</div> : null}
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

function StepOutput({ text, error = false }: { text: string; error?: boolean }): JSX.Element {
  const tt = useSessionText()
  const [expanded, setExpanded] = useState(false)
  const lines = text.split('\n')
  const truncated = lines.length > OUTPUT_PREVIEW_LINES
  const shown = truncated && !expanded ? lines.slice(0, OUTPUT_PREVIEW_LINES) : lines
  return (
    <>
      <pre className="v3-step-pre out" data-testid="v3-step-output" data-error={error || undefined} role="group">{shown.join('\n')}</pre>
      {truncated ? (
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          data-testid="v3-step-output-toggle"
          onPress={() => setExpanded((v) => !v)}
        >
          {expanded ? tt('outputLess') : tt('outputMore', { n: lines.length })}
        </Button>
      ) : null}
    </>
  )
}

function ChangeDetail({ call, diff }: { call: UIToolCall; diff: FileDiff | null }): JSX.Element {
  const t = useT()
  const denied = isDeniedCall(call)
  if (!diff) {
    return (
      <>
        <div className="v3-step-path">{callPath(call) || call.name}</div>
        <div className="v3-step-note">{t('tool.diffUnavailable')}</div>
        {call.output ? <StepOutput text={call.output} error={call.status === 'error'} /> : null}
      </>
    )
  }
  const status = diff.status === 'created' ? t('tool.diffCreated') : diff.status === 'deleted' ? t('tool.diffDeleted') : diff.status === 'unchanged' ? t('tool.diffUnchanged') : ''
  const tooLarge = diff.before.tooLarge || diff.after.tooLarge
  return (
    <>
      <div className="v3-step-path">
        <Icon name="file" size={13} />
        <span title={diff.path}>{diff.path}</span>
        {status ? <span className="v3-step-status">{status}</span> : null}
        <span className="v3-code-sp" />
        {diff.added >= 0 ? <span className="v3-add">+{diff.added}</span> : null}
        {diff.removed >= 0 ? <span className="v3-del">−{diff.removed}</span> : null}
      </div>
      {call.status === 'error' && !call.cancelled && !denied ? <div className="v3-step-note err">{t('tool.notApplied')}</div> : null}
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
