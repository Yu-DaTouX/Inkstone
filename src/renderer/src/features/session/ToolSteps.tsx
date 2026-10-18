import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { useI18n, useT, type TFunc } from '../../i18n'
import type { FileDiff, UIToolCall } from '../../../../shared/ipc'
import { flattenToolNodes, isSettledToolNode, toolCallForest, type ToolCallNode } from '../../../../shared/tool-call-tree'
import { useSessionText } from './text'
import { callPath, readFileDiff } from './turn-changes'
import { generatingArgs, summarize, toolGroupLabel, toolRunLabel } from './tool-summary'
import { GROUP_EXTRAS, LIVE_STEPS, capRecent, groupConsecutive, groupExtras, isFailedCall, isLiveCall, type StepGroup } from './tool-groups'
import { Icon } from './Icon'
import { Button, CompletionSweep, IconButton, ShimmerText } from '../../ui'
import { McpAppResult, McpAppStepAudit } from '../artifacts/McpAppFrame'

const OUTPUT_PREVIEW_LINES = 16

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

function changeStats(tools: UIToolCall[]): { files: number; additions: number; deletions: number } | null {
  const paths = new Set<string>()
  let additions = 0
  let deletions = 0
  let counted = 0
  for (const call of tools) {
    if (isRunning(call)) continue
    const diff = readFileDiff(call.details)
    if (!diff || diff.status === 'unchanged') continue
    paths.add(diff.path || callPath(call) || call.id)
    if (diff.added >= 0 && diff.removed >= 0) {
      additions += diff.added
      deletions += diff.removed
      counted += 1
    }
  }
  if (!paths.size) return null
  return { files: paths.size, additions, deletions: counted > 0 ? deletions : -1 }
}

function summaryText(t: TFunc, zh: boolean, tools: UIToolCall[], failed: number): { label: string; stats: ReactNode } {
  const stats = changeStats(tools)
  const label = toolGroupLabel(tools, zh) + (failed > 0 ? (zh ? `（${failed} 个失败）` : ` (${failed} failed)`) : '')
  const statNode: ReactNode = stats
    ? stats.additions >= 0 && stats.deletions >= 0
      ? <><span className="v3-add">+{stats.additions}</span><span className="v3-del">−{stats.deletions}</span></>
      : t('tool.wsChanges', { n: stats.files })
    : null
  return { label, stats: statNode }
}

const SETTLE_LINGER_MS = 900
const NONE_LINGERING: ReadonlySet<string> = new Set()

function useRecentlySettled(forest: ToolCallNode[]): ReadonlySet<string> {
  const liveKey = forest.filter((node) => !isSettledToolNode(node)).map((node) => node.call.id).join('\n')
  const previous = useRef<string[]>([])
  const timers = useRef(new Set<number>())
  const [lingering, setLingering] = useState<ReadonlySet<string>>(NONE_LINGERING)

  useEffect(() => {
    const live = liveKey ? liveKey.split('\n') : []
    const settled = previous.current.filter((id) => !live.includes(id))
    previous.current = live
    if (!settled.length) return
    setLingering((current) => new Set([...current, ...settled]))
    const timer = window.setTimeout(() => {
      timers.current.delete(timer)
      setLingering((current) => {
        const next = new Set(current)
        for (const id of settled) next.delete(id)
        return next.size ? next : NONE_LINGERING
      })
    }, SETTLE_LINGER_MS)
    timers.current.add(timer)
  }, [liveKey])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) window.clearTimeout(timer)
    }
  }, [])

  return lingering
}

export function ToolSteps({ tools }: { tools: UIToolCall[] }): JSX.Element | null {
  const t = useT()
  const zh = useI18n().lang !== 'en-US'
  const tt = useSessionText()
  const [manual, setManual] = useState<boolean | null>(null)
  const forest = toolCallForest(tools)
  const lingering = useRecentlySettled(forest)
  if (!tools.length) return null

  const running = tools.filter(isRunning)
  const failed = tools.filter((c) => c.status === 'error' && !c.cancelled).length
  const open = manual ?? failed > 0
  const { label, stats } = summaryText(t, zh, tools, failed)
  const liveNodes = forest.filter((node) => !isSettledToolNode(node) || lingering.has(node.call.id))
  const liveCap = capRecent(liveNodes, LIVE_STEPS)

  return (
    <section className="v3-steps" data-testid="v3-steps" aria-label={t('proc.title')}>
      <button className="v3-steps-sum" aria-expanded={open} onClick={() => setManual(!open)} data-testid="v3-steps-toggle">
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="v3-chev" />
        <span className="v3-steps-label">{label}</span>
        {stats ? <span className="v3-steps-stats">{stats}</span> : null}
      </button>

      {open ? (
        <div className="v3-steps-list" data-testid="v3-steps-list">
          {groupConsecutive(forest).map((item) => item.type === 'group'
            ? <StepGroupRow key={item.group.id} group={item.group} />
            : <StepNode key={item.node.call.id} node={item.node} depth={0} />)}
        </div>
      ) : (
        running.length || lingering.size ? (
          <div className="v3-steps-live" data-testid="v3-steps-live">
            {liveCap.hidden > 0 ? <MoreRow count={liveCap.hidden} onOpen={() => setManual(true)} testId="v3-steps-more" /> : null}
            {liveCap.shown.map((node) => <StepNode key={node.call.id} node={node} depth={0} />)}
          </div>
        ) : null
      )}

      {open && tools.some((c) => detailKind(c.name) === 'command' || detailKind(c.name) === 'change') ? (
        <div className="v3-steps-note"><Icon name="external" size={13} /><span>{tt('toolDetail')}</span></div>
      ) : null}
    </section>
  )
}

function MoreRow({ count, onOpen, testId }: { count: number; onOpen: () => void; testId: string }): JSX.Element {
  const tt = useSessionText()
  return (
    <Button size="sm" variant="ghost" className="v3-steps-more" onPress={onOpen} data-testid={testId}>
      {tt('moreItems', { n: count })}
    </Button>
  )
}

function StepGroupRow({ group }: { group: StepGroup }): JSX.Element {
  const t = useT()
  const zh = useI18n().lang !== 'en-US'
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? false
  const failed = group.nodes.filter(isFailedCall).length
  const running = group.nodes.some(isLiveCall)
  const state = running ? 'run' : failed ? 'err' : 'ok'
  const label = toolRunLabel(group.name, group.nodes.length, zh)
  const extras = open ? { shown: [], hidden: 0 } : capRecent(groupExtras(group), GROUP_EXTRAS)

  return (
    <div className="v3-step v3-step-group" data-state={state} data-tool={group.name} data-depth={0}>
      <button className="v3-step-head" aria-expanded={open} onClick={() => setManual(!open)} title={label} data-testid="v3-step-group">
        <span className={`v3-dot ${state}`} aria-hidden />
        <span className="v3-step-target">{label}</span>
        {failed ? <span className="v3-badge err">{failed} {t('tool.failed')}</span> : null}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} className="v3-chev" />
      </button>
      {open ? (
        <div className="v3-step-nest" role="group" aria-label={label} data-testid="v3-step-group-list">
          {group.nodes.map((node) => <StepNode key={node.call.id} node={node} depth={1} />)}
        </div>
      ) : extras.shown.length ? (
        <div className="v3-step-nest" role="group" aria-label={label}>
          {extras.hidden > 0 ? <MoreRow count={extras.hidden} onOpen={() => setManual(true)} testId="v3-step-group-more" /> : null}
          {extras.shown.map((node) => <StepNode key={node.call.id} node={node} depth={1} />)}
        </div>
      ) : null}
    </div>
  )
}

function StepNode({ node, depth }: { node: ToolCallNode; depth: number }): JSX.Element {
  const t = useT()
  const [manual, setManual] = useState<boolean | null>(null)
  const call = node.call
  const running = isRunning(call)
  const failed = call.status === 'error' && !call.cancelled
  const open = manual ?? failed
  const secs = durationSecs(call)
  const target = generatingArgs(call) ? t('tool2.generatingArgs') : summarize(call) || t('tool2.noTarget')
  const state = running ? 'run' : failed ? 'err' : call.cancelled ? 'warn' : 'ok'
  const children = depth + 1 >= 4 ? flattenToolNodes(node.children) : node.children

  return (
    <div className="v3-step" data-state={call.status} data-tool={call.name} data-depth={depth}>
      <button className="v3-step-head" aria-expanded={open} onClick={() => setManual(!open)} title={target} data-testid="v3-step">
        <CompletionSweep done={!running && !failed && !call.cancelled} settledAt={call.endedAt} />
        <span className={`v3-dot ${state}`} aria-hidden />
        {running ? null : <Icon name={failed ? 'warn' : call.cancelled ? 'stop' : 'check'} size={13} />}
        <span className="v3-step-verb">{call.name}</span>
        <ShimmerText className="v3-step-target" active={running} lead={detailKind(call.name) === 'command' ? <span className="v3-dollar">$ </span> : null}>{target}</ShimmerText>
        {secs !== null && !running ? <span className="v3-step-time">{secs}s</span> : null}
        {failed ? <span className="v3-badge err">{t('tool.failed')}</span> : call.cancelled ? <span className="v3-badge warn">{t('tool.cancelled')}</span> : call.incomplete ? <span className="v3-badge warn">{t('tool2.incomplete')}</span> : null}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} className="v3-chev" />
      </button>
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
          {call.images.map((im, i) => im.data ? <img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt="" className="v3-md-image" /> : im.url ? <img key={i} src={im.url} alt="" className="v3-md-image" /> : null)}
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
