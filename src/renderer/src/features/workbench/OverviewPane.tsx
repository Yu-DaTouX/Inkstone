/**
 * 工作区「概览」：纵向堆叠的磁贴列（参照 Claude Code 桌面版右栏）。
 *
 * 默认五张，顺序固定：环境、上下文、额度、后台任务、待办。每张磁贴一行标题：左侧标签 + 折叠箭头，
 * 右侧摘要值；有完整视图的磁贴（上下文、额度）末尾有「›」，切到对应视图。
 * 磁贴的数据全部来自现有投影，本文件不新增 IPC、不持有任何资源：
 *   · 环境：`owner.cwd`、store 的项目名 / 权限档，分支来自 `window.yan.git.state`；
 *   · 上下文：`useContextUsage`（输入框进度环同一来源）；
 *   · 额度：`window.yan.accountQuota()`，取当前 provider 的第一张账号卡的主窗口；
 *   · 后台任务：`store.subagents` 经 `visibleSubagentRuns`，与对话里子 Agent 行同一口径；
 *   · 待办：`store.todos`，行渲染复用 `TodoTileRows`。
 * 改动与输出内容不进默认概览；改动从头部「⋯」进入「改动」视图。
 * 拿不到的字段不显示，不造数据。磁贴折叠状态按磁贴 id 记在 localStorage（读写都 try/catch）。
 */
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
  /** 当前工作区归属；null = 尚无可归属会话，只剩与会话无关的磁贴 */
  owner: WorkspaceOwner | null
  /** 「›」切到完整视图 */
  onOpenView: (tab: WorkbenchTabId) => void
  /**
   * 已不再被概览使用（输出内容磁贴已退出默认概览）；保留是为了不在本次改动里动调用方。
   * 调用方下次整理时可与本字段一起删除。
   */
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
    /* 折叠记忆写失败不影响本次使用 */
  }
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/* ── 数据 hook ─────────────────────────────────────────────── */

/** 分支所需的仓库状态：只读，与分支页签同一 `window.yan.git.state` 通道。 */
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

/** 额度只取当前 provider 的第一张账号卡；挂载时查一次，之后随面板重挂重查。 */
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

/** 运行中（含启动中）的后台任务。 */
function isLiveRun(run: SubagentRun): boolean {
  return run.status === 'running' || run.status === 'starting'
}

/** 运行中在前，同组内按开始时间倒序（最近的在前）。 */
function compareRuns(a: SubagentRun, b: SubagentRun): number {
  const live = Number(isLiveRun(b)) - Number(isLiveRun(a))
  return live !== 0 ? live : b.startedAt - a.startedAt
}

/* ── 磁贴外壳 ──────────────────────────────────────────────── */

interface TileProps {
  id: TileId
  title: string
  summary?: ReactNode
  folded: boolean
  onToggle: (id: TileId) => void
  /** 有完整视图时给出：标题行末的「›」 */
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

/* ── 面板主体 ──────────────────────────────────────────────── */

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

  /* 环境 */
  const projectName = cwd ? settings?.projectNames?.[cwd] || lastSegment(cwd) : ''
  const mode: PermissionMode = normalizePermissionMode(settings?.permissionMode)
  const modeLabel = t(`permission.label.${mode}` as 'permission.label.danger')

  /* 分支（随回合结束刷新） */
  const gitRefresh = `${messages.length}:${agentRunning ? 1 : 0}`
  const repo = useGitRepo(cwd || null, gitRefresh)
  const branch = repo ? (repo.detached ? text.detached : repo.branch || text.noBranch) : null

  /* 待办 */
  const todoModel = useMemo(() => buildTodoTileModel(todos, agentRunning), [todos, agentRunning])
  const hasTodos = hasTodoTileContent(todos)

  /* 上下文 */
  const usage = useContextUsage()
  const contextSummary = usage.known && usage.percent !== null ? `${Math.round(usage.percent)}%` : '—'
  const contextTone = usage.tone !== 'ok' && usage.known ? usage.tone : undefined

  /* 后台任务：与对话里的子 Agent 行同一口径（当前视图的会话 id） */
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

  /* 额度 */
  const quota = useQuotaSnapshot(provider)
  const primaryWindow = quota.card?.windows.find((w) => w.id === 'fiveHour' || w.id === 'primary') ?? quota.card?.windows[0]
  const primaryPct = primaryWindow ? windowPct(primaryWindow) : null

  const toggleRun = (run: SubagentRun, event: PressEvent): void => {
    useSubagentPanel.getState().toggle(run.id, view.key, event.target as HTMLElement)
  }

  return (
    <div className="wb-overview" data-testid="wb-overview">
      {/* 环境：常驻，缺哪个字段就不显示哪一行 */}
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
        /* 取数中 / 失败也占同一张磁贴，列不跳 */
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

/** 任务行的状态标记：运行中蓝点、完成对勾、失败红点。 */
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
