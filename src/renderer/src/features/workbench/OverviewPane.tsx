import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { PressEvent } from 'react-aria-components'
import { Check, ChevronDown, ChevronRight, Square } from 'lucide-react'
import { Button, IconButton, Meter } from '../../ui'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useContextUsage } from '../../patterns/ContextRing'
import { visibleSubagentRuns } from '../../state/subagent-view'
import { sessionViewIdentity } from '../session/view-state'
import { useSubagentPanel } from '../session/subagent-panel-state'
import { buildTodoTileModel, hasTodoTileContent } from '../todos/todo-tile-model'
import { TodoTileRows, todoTileText } from '../todos/TodoTileView'
import { formatDuration } from '../../../../shared/duration'
import { normalizePermissionMode, type PermissionMode } from '../../../../shared/approval'
import { accountCardTitle, orderAccountCardsForProvider, type AccountQuotaCard } from '../../../../shared/account-quota'
import { windowPct } from '../../../../shared/quota-mini'
import type { GitRepoState } from '../../../../shared/git'
import type { SubagentRun } from '../../../../shared/ipc'
import { shortTokens } from './context-pane-view'
import { workbenchText } from './workbench-text'
import type { WorkbenchTabId, WorkspaceOwner } from './types'
import './workbench.css'

export interface OverviewPaneProps {
  owner: WorkspaceOwner | null
  onOpenView: (tab: WorkbenchTabId) => void
  onPreview?: (path: string) => void
}

type TileId = 'env' | 'context' | 'quota' | 'tasks' | 'todos'

const FOLD_KEY = 'inkstone.v3.overview.folds'

type FoldMap = Partial<Record<TileId, boolean>>

function readFolds(): FoldMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = JSON.parse(localStorage.getItem(FOLD_KEY) ?? 'null') as unknown
    return raw && typeof raw === 'object' ? (raw as FoldMap) : {}
  } catch {
    return {}
  }
}

function writeFolds(folds: FoldMap): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(folds))
  } catch {
  }
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function useGitRepo(cwd: string | null, refreshKey: string): GitRepoState | null {
  const [repo, setRepo] = useState<GitRepoState | null>(null)
  useEffect(() => {
    if (!cwd) {
      setRepo(null)
      return undefined
    }
    const git = window.yan?.git
    if (!git) {
      setRepo(null)
      return undefined
    }
    let alive = true
    git
      .state(cwd)
      .then((st) => {
        if (alive) setRepo(st.repo ?? null)
      })
      .catch(() => {
        if (alive) setRepo(null)
      })
    return () => {
      alive = false
    }
  }, [cwd, refreshKey])
  return repo
}

interface QuotaSnapshot {
  state: 'loading' | 'ready' | 'error'
  card: AccountQuotaCard | null
}

function useQuotaSnapshot(provider: string): QuotaSnapshot {
  const [snap, setSnap] = useState<QuotaSnapshot>({ state: 'loading', card: null })
  useEffect(() => {
    let alive = true
    setSnap({ state: 'loading', card: null })
    window.yan
      .accountQuota()
      .then((report) => {
        if (!alive) return
        const card = orderAccountCardsForProvider(report.cards ?? [], provider)[0] ?? null
        setSnap({ state: 'ready', card })
      })
      .catch(() => {
        if (alive) setSnap({ state: 'error', card: null })
      })
    return () => {
      alive = false
    }
  }, [provider])
  return snap
}

function isLiveRun(run: SubagentRun): boolean {
  return run.status === 'running' || run.status === 'starting'
}

function compareRuns(a: SubagentRun, b: SubagentRun): number {
  const live = Number(isLiveRun(b)) - Number(isLiveRun(a))
  return live !== 0 ? live : b.startedAt - a.startedAt
}

interface TileProps {
  id: TileId
  title: string
  summary?: ReactNode
  folded: boolean
  onToggle: (id: TileId) => void
  onOpen?: () => void
  openLabel?: string
  tone?: 'ok' | 'warn' | 'err'
  children: ReactNode
}

function Tile({ id, title, summary, folded, onToggle, onOpen, openLabel, tone, children }: TileProps): ReactElement {
  return (
    <section className="wb-tile" data-tile={id} data-folded={folded ? '1' : '0'} data-tone={tone} data-testid={`wb-tile-${id}`}>
      <div className="wb-tile-head">
        <Button variant="ghost" size="sm" className="wb-tile-toggle" aria-expanded={!folded} onPress={() => onToggle(id)}>
          {folded ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          <span className="wb-tile-title">{title}</span>
          {summary != null ? <span className="wb-tile-summary">{summary}</span> : null}
        </Button>
        {onOpen ? (
          <IconButton variant="ghost" size="sm" aria-label={openLabel ?? title} className="wb-tile-open" onPress={onOpen}>
            <span aria-hidden>›</span>
          </IconButton>
        ) : null}
      </div>
      {folded ? null : <div className="wb-tile-body">{children}</div>}
    </section>
  )
}

export function OverviewPane({ owner, onOpenView }: OverviewPaneProps): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = useMemo(() => workbenchText(lang).overview, [lang])
  const todoText = useMemo(() => todoTileText(lang), [lang])

  const cwd = owner?.cwd || ''
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const messages = useStore((s) => s.messages)
  const todos = useStore((s) => s.todos)
  const subagents = useStore((s) => s.subagents)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const agentRunning = session?.isAgentRunning === true || session?.isStreaming === true
  const provider = session?.model?.provider ?? ''

  const [folds, setFolds] = useState<FoldMap>(readFolds)
  const toggle = (id: TileId): void => {
    setFolds((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      writeFolds(next)
      return next
    })
  }
  const isFolded = (id: TileId): boolean => folds[id] === true

  const projectName = cwd ? settings?.projectNames?.[cwd] || lastSegment(cwd) : ''
  const mode: PermissionMode = normalizePermissionMode(settings?.permissionMode)
  const modeLabel = t(`permission.label.${mode}` as 'permission.label.danger')

  const gitRefresh = `${messages.length}:${agentRunning ? 1 : 0}`
  const repo = useGitRepo(cwd || null, gitRefresh)
  const branch = repo ? (repo.detached ? text.detached : repo.branch || text.noBranch) : null

  const todoModel = useMemo(() => buildTodoTileModel(todos, agentRunning), [todos, agentRunning])
  const hasTodos = hasTodoTileContent(todos)

  const usage = useContextUsage()
  const contextSummary = usage.known && usage.percent !== null ? `${Math.round(usage.percent)}%` : '—'
  const contextTone = usage.tone !== 'ok' && usage.known ? usage.tone : undefined

  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const sessionIds = view.sessionId ? [view.sessionId] : []
  const runs: SubagentRun[] = visibleSubagentRuns(subagents, { sessionIds }).sort(compareRuns)
  const runningCount = runs.filter(isLiveRun).length
  const taskSummary = runningCount > 0 ? text.runningCount(runningCount) : runs.length > 0 ? text.doneCount(runs.length) : undefined
  const liveRuns = runningCount > 0
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!liveRuns) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [liveRuns])

  const quota = useQuotaSnapshot(provider)
  const primaryWindow = quota.card?.windows.find((w) => w.id === 'fiveHour' || w.id === 'primary') ?? quota.card?.windows[0]
  const primaryPct = primaryWindow ? windowPct(primaryWindow) : null

  const toggleRun = (run: SubagentRun, event: PressEvent): void => {
    useSubagentPanel.getState().toggle(run.id, view.key, event.target as HTMLElement)
  }

  return (
    <div className="wb-overview" data-testid="wb-overview">
      <Tile id="env" title={text.tiles.env} summary={branch ?? undefined} folded={isFolded('env')} onToggle={toggle}>
        <dl className="wb-ov-rows">
          {projectName ? (
            <div className="wb-ov-row">
              <dt>{text.projectLabel}</dt>
              <dd>{projectName}</dd>
            </div>
          ) : null}
          {cwd ? (
            <div className="wb-ov-row">
              <dt>{text.pathLabel}</dt>
              <dd className="wb-ov-path" title={cwd} data-testid="wb-ov-path">
                {cwd}
              </dd>
            </div>
          ) : null}
          {branch ? (
            <div className="wb-ov-row">
              <dt>{text.branchLabel}</dt>
              <dd>{branch}</dd>
            </div>
          ) : null}
          <div className="wb-ov-row">
            <dt>{text.permissionLabel}</dt>
            <dd>{modeLabel}</dd>
          </div>
        </dl>
      </Tile>

      <Tile
        id="context"
        title={text.tiles.context}
        summary={contextSummary}
        folded={isFolded('context')}
        onToggle={toggle}
        onOpen={() => onOpenView('context')}
        openLabel={`${text.openFull} ${text.tiles.context}`}
        tone={contextTone}
      >
        <Meter
          aria-label={text.tiles.context}
          className="wb-ov-meter"
          value={usage.known && usage.percent !== null ? Math.min(100, Math.max(0, usage.percent)) : 0}
          minValue={0}
          maxValue={100}
        />
        {usage.known ? (
          <p className="wb-ov-note">{`${text.contextUsed} ${shortTokens(usage.tokens)} / ${shortTokens(usage.windowSize)}`}</p>
        ) : null}
      </Tile>

      {quota.card && primaryWindow ? (
        <Tile
          id="quota"
          title={text.tiles.quota}
          summary={primaryPct !== null ? `${primaryPct}%` : '—'}
          folded={isFolded('quota')}
          onToggle={toggle}
          onOpen={() => onOpenView('quota')}
          openLabel={`${text.openFull} ${text.tiles.quota}`}
        >
          <Meter
            aria-label={`${accountCardTitle(quota.card)} ${primaryWindow.label}`}
            className="wb-ov-meter"
            value={primaryPct ?? 0}
            minValue={0}
            maxValue={100}
            label={primaryWindow.label}
          />
        </Tile>
      ) : quota.state === 'loading' || quota.state === 'error' ? (
        <Tile id="quota" title={text.tiles.quota} folded={isFolded('quota')} onToggle={toggle}>
          <p className="wb-ov-note">{quota.state === 'loading' ? text.quotaChecking : text.quotaFailed}</p>
        </Tile>
      ) : null}

      <Tile id="tasks" title={text.tiles.tasks} summary={taskSummary} folded={isFolded('tasks')} onToggle={toggle}>
        {runs.length === 0 ? <p className="wb-ov-note">{text.noTasks}</p> : null}
        {runs.length > 0 ? (
          <ul className="wb-ov-list">
            {runs.map((run) => {
              const live = isLiveRun(run)
              const elapsed = formatDuration((run.endedAt ?? now) - run.startedAt, { minSeconds: 1 })
              return (
                <li key={run.id} className="wb-ov-task" data-status={run.status}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="wb-ov-task-main"
                    title={run.task}
                    aria-label={`${text.taskDetail}: ${run.task}`}
                    onPress={(event) => toggleRun(run, event)}
                  >
                    <TaskStatus status={run.status} />
                    <span className="wb-ov-task-name">{run.task}</span>
                    <span className="wb-ov-task-time">{elapsed}</span>
                  </Button>
                  {live ? (
                    <IconButton variant="ghost" size="sm" aria-label={text.stopTask} onPress={() => void window.yan.subagents.stop(run.id)}>
                      <Square size={12} aria-hidden />
                    </IconButton>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </Tile>

      <Tile
        id="todos"
        title={text.tiles.todos}
        summary={hasTodos ? `${todoModel.done}/${todoModel.total}` : undefined}
        folded={isFolded('todos')}
        onToggle={toggle}
      >
        {hasTodos ? <TodoTileRows model={todoModel} text={todoText} /> : <p className="wb-ov-note">{text.noTodos}</p>}
      </Tile>
    </div>
  )
}

function TaskStatus({ status }: { status: SubagentRun['status'] }): ReactElement {
  if (status === 'running' || status === 'starting') {
    return (
      <span className="wb-ov-status" aria-hidden>
        <span className="wb-ov-dot is-run" />
      </span>
    )
  }
  if (status === 'done') {
    return (
      <span className="wb-ov-status" aria-hidden>
        <Check size={12} className="wb-ov-check" />
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="wb-ov-status" aria-hidden>
        <span className="wb-ov-dot is-err" />
      </span>
    )
  }
  return (
    <span className="wb-ov-status" aria-hidden>
      <span className="wb-ov-dot is-warn" />
    </span>
  )
}
