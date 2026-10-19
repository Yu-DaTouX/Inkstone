import { Fragment, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import type { FileDiff, UIToolCall } from '../../../../shared/ipc'
import { flattenToolNodes, type ToolCallNode } from '../../../../shared/tool-call-tree'
import { useSessionText } from './text'
import { callPath, readFileDiff } from './turn-changes'
import { generatingArgs, runningCallLabel, summarize } from './tool-summary'
import { approvalCallIds, buildToolRows, coalesceNodes, formatToolRun, type ToolRow, type ToolRunState } from './tool-run-model'
import { useStore } from '../../state/store'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { QuestionReceipt } from './QuestionReceipt'
import { isQuestionCall } from './question-receipt'
import { ToolRunStats } from './ToolRunStats'
import { useHeldRunLabel, useToolExpansion } from './use-tool-run'
import { Icon } from './Icon'
import { Badge, Button, CompletionSweep, IconButton, ShimmerText } from '../../ui'
import { McpAppResult, McpAppStepAudit } from '../artifacts/McpAppFrame'

const OUTPUT_PREVIEW_LINES = 16
const NO_APPROVALS: ReadonlySet<string> = new Set()

export function detailKind(name: string): 'command' | 'change' | 'result' {
  if (name === 'bash' || name === 'powershell' || name === 'shell' || name === 'run' || name === 'exec') return 'command'
  if (name === 'edit' || name === 'write' || name === 'multi_edit' || name === 'multiEdit' || name === 'apply_patch' || name === 'patch') return 'change'
  return 'result'
}

function durationSecs(call: UIToolCall): number | null {
  const { startedAt, endedAt } = call
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number' || endedAt <= startedAt) return null
  return Math.max(1, Math.round((endedAt - startedAt) / 1000))
}

function isRunning(call: UIToolCall): boolean {
  return call.status === 'running' || call.status === 'pending'
}

const DOT: Record<ToolRunState, string> = { blocked: 'warn', running: 'run', error: 'err', cancelled: 'warn', ok: 'ok' }

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
            return (
              <Fragment key={row.id}>
                <QuestionReceipt call={row.node.call} />
                {asked ? <QuestionCard requestId={asked.id} /> : null}
              </Fragment>
            )
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
  const open = stored ?? false
  const { summary } = row
  const label = formatToolRun(summary, tt)
  const running = summary.running
  const held = useHeldRunLabel(running ? running.id : null, running ? runningCallLabel(running, t('tool2.generatingArgs')) : label)
  const shown = held.key !== null ? held.label : label
  const members = open ? coalesceNodes(row.nodes) : []

  return (
    <div className="v3-step v3-step-group" data-state={summary.state} data-depth={0}>
      <button className="v3-step-head" aria-expanded={open} onClick={() => setOpen(!open)} title={label} data-testid="v3-step-group">
        <span className={`v3-dot ${DOT[summary.state]}`} aria-hidden />
        <ShimmerText className="v3-step-target" active={!!running}>{shown}</ShimmerText>
        <ToolRunStats summary={summary} />
        {summary.needsApproval ? <Badge tone="ask" className="v3-steps-badge" data-testid="v3-step-group-approval">{tt('runNeedsApproval')}</Badge> : null}
        {summary.failed ? <Badge tone="fail" className="v3-steps-badge">{summary.failed} {t('tool.failed')}</Badge> : null}
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
  const call = node.call
  const running = isRunning(call)
  const failed = call.status === 'error' && !call.cancelled
  const open = stored ?? false
  const secs = durationSecs(call)
  const target = generatingArgs(call) ? t('tool2.generatingArgs') : summarize(call) || t('tool2.noTarget')
  const state = blocked ? 'warn' : running ? 'run' : failed ? 'err' : call.cancelled ? 'warn' : 'ok'
  const children = depth + 1 >= 4 ? flattenToolNodes(node.children) : node.children

  return (
    <div className="v3-step" data-state={call.status} data-tool={call.name} data-depth={depth}>
      <button className="v3-step-head" aria-expanded={open} onClick={() => setOpen(!open)} title={target} data-testid="v3-step">
        <CompletionSweep done={!running && !failed && !call.cancelled} settledAt={call.endedAt} />
        <span className={`v3-dot ${state}`} aria-hidden />
        {running ? null : <Icon name={failed ? 'warn' : call.cancelled ? 'stop' : 'check'} size={13} />}
        <span className="v3-step-verb">{call.name}</span>
        <ShimmerText className="v3-step-target" active={running && !blocked} lead={detailKind(call.name) === 'command' ? <span className="v3-dollar">$ </span> : null}>{target}</ShimmerText>
        {repeat > 1 ? <span className="v3-step-time">{tt('runRepeat', { n: repeat })}</span> : null}
        {secs !== null && !running ? <span className="v3-step-time">{secs}s</span> : null}
        {blocked ? <Badge tone="ask" className="v3-steps-badge" data-testid="v3-step-approval">{tt('runNeedsApproval')}</Badge> : null}
        {failed ? <Badge tone="fail" className="v3-steps-badge">{t('tool.failed')}</Badge> : call.cancelled ? <Badge tone="stall" className="v3-steps-badge">{t('tool.cancelled')}</Badge> : call.incomplete ? <Badge tone="stall" className="v3-steps-badge">{t('tool2.incomplete')}</Badge> : null}
        <Icon name="chevron-right" size={14} className="v3-chev" />
      </button>
      {asking ? <ApprovalCard inline /> : null}
      {open ? <StepDetail call={call} /> : null}
      {children.length ? <div className="v3-step-nest" role="group" aria-label={t('tool2.nestLabel', { n: children.length })}>{children.map((child) => <StepNode key={child.call.id} node={child} depth={depth + 1} />)}</div> : null}
    </div>
  )
}

function StepDetail({ call }: { call: UIToolCall }): JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const kind = detailKind(call.name)
  const diff = readFileDiff(call.details)
  const args = call.args as Record<string, unknown> | undefined
  const onlyCommand = typeof args?.command === 'string' && Object.keys(args).every((k) => k === 'command' || k === 'timeout')
  const argsText = onlyCommand ? '' : call.args && Object.keys(call.args as object).length ? JSON.stringify(call.args, null, 2) : call.argsRaw ?? ''
  const copyText = [call.args ? JSON.stringify(call.args, null, 2) : call.argsRaw ?? '', call.output ?? ''].filter(Boolean).join('\n\n')
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
          {onlyCommand ? null : argsText ? <pre className="v3-step-pre args">{argsText}</pre> : null}
          {call.output ? <StepOutput text={call.output} /> : call.status === 'ok' ? <div className="v3-step-note">{t('tool.noOutput')}</div> : null}
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

function StepOutput({ text }: { text: string }): JSX.Element {
  const tt = useSessionText()
  const [expanded, setExpanded] = useState(false)
  const lines = text.split('\n')
  const truncated = lines.length > OUTPUT_PREVIEW_LINES
  const shown = truncated && !expanded ? lines.slice(0, OUTPUT_PREVIEW_LINES) : lines
  return (
    <>
      <pre className="v3-step-pre out" data-testid="v3-step-output">{shown.join('\n')}</pre>
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
  if (!diff) {
    return (
      <>
        <div className="v3-step-path">{callPath(call) || call.name}</div>
        <div className="v3-step-note">{t('tool.diffUnavailable')}</div>
        {call.output ? <StepOutput text={call.output} /> : null}
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
      {call.status === 'error' ? <div className="v3-step-note err">{t('tool.notApplied')}</div> : null}
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
