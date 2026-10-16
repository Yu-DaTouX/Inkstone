import { memo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { withScrollAnchor } from '../../lib/scrollAnchor'
import { ToolCallDetail } from './ToolCallDetail'
import { FileChangeStats, detailKind } from './ToolDetails'
import { RunDot } from '../ui'
import { goalCommand, summarizeTaskPlanCommand, summarizeYanCommand, taskPlanCommand } from '../../../../shared/tool-origin'
import type { UIToolCall } from '../../../../shared/ipc'
import { flattenToolNodes, isSettledToolNode, summarizeNestedCalls, toolCallForest, type ToolCallNode } from '../../../../shared/tool-call-tree'

const MAX_NEST_DEPTH = 4
const NEST_FOLD_OVER = 6
const NEST_KEEP = 4

function ToolRowImpl({ call, nested = [], activeId = null, depth = 0 }: { call: UIToolCall; nested?: ToolCallNode[]; activeId?: string | null; depth?: number }) {
  const t = useT()
  const [manual, setManual] = useState<boolean | null>(null)
  const [nestOpen, setNestOpen] = useState(false)
  const autoOpen = call.id === activeId
  const autoDetail = useStore((s) => s.settings?.toolDetail === true)

  const running = call.status === 'running' || call.status === 'pending'
  const failed = call.status === 'error'
  const cancelled = call.cancelled === true
  const open = manual ?? (running && autoDetail && autoOpen)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const kind = detailKind(call.name)
  const taskPlan = taskPlanCommand(call.name, call.args)
  const goalCmd = taskPlan ? null : goalCommand(call.name, call.args)
  const target = taskPlan
    ? summarizeTaskPlanCommand(taskPlan)
    : goalCmd
      ? summarizeYanCommand(goalCmd)
      : nested.length
        ? summarizeNestedCalls(nested)
        : summarize(call)
  const secs = durationSecs(call)
  const flat = depth + 1 >= MAX_NEST_DEPTH
  const children = flat ? flattenToolNodes(nested) : nested
  const settledKids = children.filter((node) => isSettledToolNode(node))
  const foldKids =
    !nestOpen && children.length > NEST_FOLD_OVER ? new Set(settledKids.slice(0, Math.max(0, settledKids.length - NEST_KEEP))) : new Set<ToolCallNode>()
  const shownKids = children.filter((node) => !foldKids.has(node))

  const verb = running
    ? t('tool2.running', { what: verbOf(call.name, t) })
    : secs !== null
      ? t('tool2.doneIn', { n: secs, what: verbOf(call.name, t) })
      : t('tool2.done', { what: verbOf(call.name, t) })

  return (
    <div
      className={`trow ${open ? 'open' : ''}`}
      data-state={call.status}
      data-tool={call.name}
      {...(taskPlan ? { 'data-origin': 'yan-task-plan' } : goalCmd ? { 'data-origin': 'yan-goal' } : {})}
      ref={rowRef}
    >
      <button
        className="trow-head"
        onClick={() => {
          withScrollAnchor(rowRef.current, () => setManual(!open))
        }}
        aria-expanded={open}
        title={target}
        aria-label={`${verb} ${target}`}
        data-tool-depth={depth}
        data-parent-tool-call={call.parentToolCallId}
        data-testid="tool-row"
      >
        <span className="trow-ico" aria-hidden>
          {running ? <RunDot /> : <span className={`trow-dot ${failed ? 'err' : cancelled || call.incomplete ? 'warn' : 'ok'}`} />}
        </span>
        {taskPlan || goalCmd ? (
          <span
            className="trow-src"
            data-testid="tool-src"
            data-origin={taskPlan ? 'yan-task-plan' : 'yan-goal'}
          >
            {taskPlan ? t('tool2.yanTaskPlan') : t('tool2.yanGoal')}
          </span>
        ) : null}
        <span className="trow-verb">{call.name}</span>
        <span className="trow-target" data-testid="tool-target">
          {kind === 'command' ? <span className="trow-dollar">$ </span> : null}
          {target || t('tool2.noTarget')}
        </span>
        {kind === 'change' ? <FileChangeStats call={call} /> : null}
        {!running && secs !== null ? <span className="trow-time">{secs}s</span> : null}
        {failed ? (
          <span className="trow-badge err">{t('tool.failed')}</span>
        ) : cancelled ? (
          <span className="trow-badge warn">{t('tool.cancelled')}</span>
        ) : call.incomplete ? (
          <span className="trow-badge warn">{t('tool2.incomplete')}</span>
        ) : null}
        {running ? null : (
          <Icon name="chevron-right" size={12} className={`chev ${open ? 'on' : ''}`} />
        )}
      </button>

      <div className={`trow-expand ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}>
        <div className="trow-expand-inner">
          {open ? <div className="trow-body" data-kind={kind}>
          <ToolCallDetail call={call} target={target} secs={secs} />
          </div> : null}
        </div>
      </div>

      {children.length ? (
        <div className="trow-nest" role="group" aria-label={t('tool2.nestLabel', { n: children.length })} data-testid="tool-nest">
          {foldKids.size > 0 ? (
            <button className="tgroup-fold trow-nest-fold" onClick={() => setNestOpen(true)} aria-expanded={false} data-testid="tool-nest-toggle">
              <Icon name="chevron-right" size={12} className="chev" />
              <span>{t('tool2.nestEarlier', { n: foldKids.size })}</span>
            </button>
          ) : nestOpen && children.length > NEST_FOLD_OVER ? (
            <button className="tgroup-fold up trow-nest-fold" onClick={() => setNestOpen(false)} aria-expanded data-testid="tool-nest-collapse">
              <Icon name="chevron-right" size={12} className="chev" />
              <span>{t('tool2.foldEarlier')}</span>
            </button>
          ) : null}
          {shownKids.map((node) => (
            <ToolRow key={node.call.id} call={node.call} nested={flat ? [] : node.children} activeId={activeId} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function imageKey(c: UIToolCall): string {
  return c.images?.map((i) => i.url || String(i.data?.length ?? 0)).join('|') ?? ''
}

function sameCall(a: UIToolCall, b: UIToolCall): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.name === b.name &&
      a.parentToolCallId === b.parentToolCallId &&
      a.historySummary === b.historySummary &&
      a.incomplete === b.incomplete &&
      a.nestedCallsIncomplete === b.nestedCallsIncomplete &&
      a.status === b.status &&
      a.cancelled === b.cancelled &&
      a.output === b.output &&
      a.argsRaw === b.argsRaw &&
      a.args === b.args &&
      a.details === b.details &&
      a.startedAt === b.startedAt &&
      a.endedAt === b.endedAt &&
      imageKey(a) === imageKey(b))
  )
}

function sameNodes(a: ToolCallNode[] = [], b: ToolCallNode[] = []): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!sameCall(a[i].call, b[i].call) || !sameNodes(a[i].children, b[i].children)) return false
  }
  return true
}

export const ToolRow = memo(ToolRowImpl, (a, b) => a.activeId === b.activeId && a.depth === b.depth && sameCall(a.call, b.call) && sameNodes(a.nested, b.nested))

const REVEAL_FIRST = 8
const REVEAL_MORE = 20
const FOLD_FROM = 7

function ToolGroupImpl({ tools, activeId = null }: { tools: UIToolCall[]; activeId?: string | null }) {
  const t = useT()
  const groupKey = tools[0]?.id ?? ''
  const [reveal, setReveal] = useState({ key: groupKey, n: 0 })
  if (tools.length === 0) return null
  const setRevealed = (next: (n: number) => number) => setReveal((r) => ({ key: groupKey, n: next(r.key === groupKey ? r.n : 0) }))

  const steps = toolCallForest(tools)
  const history = steps.filter((node) => isSettledToolNode(node))
  const revealed = steps.length < FOLD_FROM ? history.length : reveal.key === groupKey ? Math.min(reveal.n, history.length) : 0
  const shownHistory = new Set(history.slice(history.length - revealed))
  const visible = steps.filter((node) => !history.includes(node) || shownHistory.has(node))
  const foldable = steps.length >= FOLD_FROM && history.length > 0
  const hidden = steps.length - visible.length
  const expanded = revealed > 0

  return (
    <div className={`tgroup ${expanded && foldable ? 'is-expanded' : ''}`} data-testid="tool-group" data-count={tools.length}>
      {hidden > 0 ? (
        <button
          className="tgroup-fold"
          onClick={() => setRevealed((n) => n + (n === 0 ? REVEAL_FIRST : REVEAL_MORE))}
          aria-expanded={expanded}
          data-testid="tool-group-toggle"
        >
          <Icon name="chevron-right" size={12} className="chev" />
          <span>{expanded ? t('tool2.moreEarlier', { n: hidden, k: Math.min(hidden, REVEAL_MORE) }) : t('tool2.earlier', { n: hidden })}</span>
        </button>
      ) : null}
      {foldable && expanded ? (
        <button className="tgroup-fold up" onClick={() => setRevealed(() => 0)} aria-expanded data-testid="tool-group-collapse">
          <Icon name="chevron-right" size={12} className="chev" />
          <span>{t('tool2.foldEarlier')}</span>
        </button>
      ) : null}
      {visible.map(({ call, children }) => (
        <ToolRow key={call.id} call={call} nested={children} activeId={activeId} />
      ))}
    </div>
  )
}

export const ToolGroup = memo(ToolGroupImpl, (a, b) => {
  if (a.activeId !== b.activeId) return false
  if (a.tools === b.tools) return true
  if (a.tools.length !== b.tools.length) return false
  for (let i = 0; i < a.tools.length; i++) {
    if (!sameCall(a.tools[i], b.tools[i])) return false
  }
  return true
})

function verbOf(name: string, t: (k: 'tool2.vRun' | 'tool2.vRead' | 'tool2.vEdit' | 'tool2.vWrite' | 'tool2.vSearch' | 'tool2.vCall') => string): string {
  if (name === 'bash' || name === 'powershell') return t('tool2.vRun')
  if (name === 'read' || name === 'list') return t('tool2.vRead')
  if (name === 'edit') return t('tool2.vEdit')
  if (name === 'write') return t('tool2.vWrite')
  if (name === 'grep' || name === 'glob' || name === 'web_search' || name === 'fetch') return t('tool2.vSearch')
  return t('tool2.vCall')
}


function durationSecs(call: UIToolCall): number | null {
  const { startedAt, endedAt } = call
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number') return null
  if (endedAt <= startedAt) return null
  return Math.max(1, Math.round((endedAt - startedAt) / 1000))
}

function summarize(call: UIToolCall): string {
  const a = call.args as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') return ''
  if (typeof a.command === 'string') return a.command
  if (typeof a.code === 'string') return a.code.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (typeof a.file_path === 'string') return a.file_path.split(/[\\/]/).pop() || shortPath(a.file_path)
  if (typeof a.path === 'string') return a.path.split(/[\\/]/).pop() || shortPath(a.path)
  if (typeof a.pattern === 'string') return a.pattern
  if (typeof a.query === 'string') return a.query
  if (typeof a.url === 'string') return a.url
  const keys = Object.keys(a)
  return keys.length ? keys.slice(0, 3).join(', ') : ''
}

function shortPath(p: string): string {
  return p
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^\/Users\/[^/]+/, '~')
}
