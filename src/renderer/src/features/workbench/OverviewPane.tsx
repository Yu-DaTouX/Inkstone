import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ArrowUpRight, ChevronDown, ChevronRight, Folder, GitBranch, ShieldCheck, Square } from 'lucide-react'
import { Button, IconButton, Meter } from '../../ui'
import { useI18n, useT, type MessageKey, type TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { useStreamingThrottledStore, useThrottledValue } from '../../state/streaming-throttle'
import type { ContextCategory } from '../../state/context-breakdown'
import {
  compactionGrowthText,
  compactionReclaimText,
  compactionSummary,
  compactionTokensText
} from '../../state/compaction-view'
import { LIVE_QUOTA_MIN_GAP_MS, LIVE_QUOTA_POLL_MS, liveQuotaSupported, refreshLiveQuota, useLiveQuota } from '../../state/live-quota'
import { visibleSubagentRuns } from '../../state/subagent-view'
import { sessionViewIdentity } from '../session/view-state'
import { useSubagentPanel } from '../session/subagent-panel-state'
import { compactTaskPaths, subagentTitle } from '../session/SubagentLine'
import { buildTodoTileModel, hasTodoTileContent } from '../todos/todo-tile-model'
import { TodoTileRows, todoTileText } from '../todos/TodoTileView'
import { QuotaWindowRow, quotaReadAgo, quotaShortLabel, quotaWindowTone } from '../../patterns/QuotaWindowRow'
import { formatDuration } from '../../../../shared/duration'
import { normalizePermissionMode, type PermissionMode } from '../../../../shared/approval'
import type { AccountQuotaCard } from '../../../../shared/account-quota'
import { money } from '../../../../shared/quota-mini'
import { bindingQuotaWindow, quotaReadingStale, windowAwaitingReset, windowUsedPct } from '../../../../shared/quota-forecast'
import type { GitRepoState } from '../../../../shared/git'
import type { CapabilityMcpServerSettingView, CompactionRun, ProviderQuota, QuotaWindow, SubagentRun } from '../../../../shared/ipc'
import { contextPaneData, contextUsageSummary, shortTokens, type ContextPaneData } from './context-pane-view'
import { workbenchText, type OverviewText } from './workbench-text'
import type { WorkbenchTabId, WorkspaceOwner } from './types'
import './workbench.css'

export interface OverviewPaneProps {
  owner: WorkspaceOwner | null
  onOpenView: (tab: WorkbenchTabId) => void
  onPreview?: (path: string) => void
}

type TileId = 'env' | 'context' | 'todos' | 'tasks' | 'ext' | 'mcp' | 'changes' | 'quota'

const FOLD_KEY = 'inkstone.v3.overview.folds'
const QUOTA_TICK_MS = 30_000
const GIT_REFRESH_WHILE_RUNNING_MS = 4_000

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

function pathRoot(path: string): string {
  const drive = /^[A-Za-z]:/.exec(path)
  if (drive) return drive[0]
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : ''
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

interface QuotaTileModel {
  windows: QuotaWindow[]
  balance?: { label: string; amount: number; currency: string }
  checkedAt: number
  staleError?: string
  problem?: { tone: 'warn' | 'err'; text: string }
}

interface AccountCardSnapshot {
  provider: string
  state: 'ready' | 'error'
  card: AccountQuotaCard | null
}

function refreshLive(provider: string, force = false): Promise<unknown> {
  return refreshLiveQuota(provider, { force, budget: useStore.getState().settings?.providerBudgets?.[provider] })
}

function useRunEnded(running: boolean): number {
  const [ended, setEnded] = useState(0)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setEnded((n) => n + 1)
    wasRunning.current = running
  }, [running])
  return ended
}

function useAccountQuotaCard(provider: string, enabled: boolean, runEnded: number): AccountCardSnapshot | null {
  const [snap, setSnap] = useState<AccountCardSnapshot | null>(null)
  const [poll, setPoll] = useState(0)
  const last = useRef({ provider: '', at: 0 })
  const seq = useRef(0)

  useEffect(() => {
    if (!enabled) return undefined
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setPoll((n) => n + 1)
    }, LIVE_QUOTA_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    if (last.current.provider === provider && Date.now() - last.current.at < LIVE_QUOTA_MIN_GAP_MS) return
    last.current = { provider, at: Date.now() }
    const id = ++seq.current
    const want = provider.trim().toLowerCase()
    window.yan
      .accountQuota()
      .then((report) => {
        if (id !== seq.current) return
        const matches = (report.cards ?? []).filter((card) => card.provider.trim().toLowerCase() === want)
        setSnap({ provider, state: 'ready', card: matches.find((card) => card.active) ?? matches[0] ?? null })
      })
      .catch(() => {
        if (id !== seq.current) return
        setSnap((prev) => (prev?.provider === provider && prev.card ? prev : { provider, state: 'error', card: null }))
      })
  }, [provider, enabled, runEnded, poll])

  return snap?.provider === provider ? snap : null
}

function liveQuotaModel(snapshot: ProviderQuota | null | undefined, t: TFunc, text: OverviewText): QuotaTileModel | null {
  if (!snapshot?.supported) return null
  const windows = snapshot.windows ?? []
  const balance =
    !windows.length && typeof snapshot.remaining === 'number' && snapshot.currency && snapshot.currency !== 'PERCENT'
      ? { label: snapshot.label || text.balance, amount: snapshot.remaining, currency: snapshot.currency }
      : undefined
  const problem = snapshot.error && !windows.length && !balance ? { tone: 'err' as const, text: t('acct.failed', { msg: snapshot.error }) } : undefined
  if (!windows.length && !balance && !problem) return null
  return { windows, balance, checkedAt: snapshot.checkedAt, staleError: snapshot.staleError, problem }
}

function cardQuotaModel(card: AccountQuotaCard, t: TFunc, text: OverviewText): QuotaTileModel | null {
  const problem =
    card.status === 'error'
      ? { tone: 'err' as const, text: t('acct.failed', { msg: card.error ?? '' }) }
      : card.status === 'expired'
        ? { tone: 'warn' as const, text: card.hint || text.quotaExpired }
        : undefined
  if (!card.windows.length && !card.balance && !problem) return null
  return { windows: card.windows, balance: card.balance, checkedAt: card.checkedAt, staleError: card.staleError, problem }
}

function useQuotaTile(provider: string, running: boolean, t: TFunc, text: OverviewText): { model: QuotaTileModel | null; now: number } {
  const live = liveQuotaSupported(provider)
  const entry = useLiveQuota((s) => (live ? s.entries[provider] : undefined))
  const runEnded = useRunEnded(running)
  const account = useAccountQuotaCard(provider, !!provider && !live, runEnded)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!live) return undefined
    let alive = true
    void refreshLive(provider).then(() => {
      if (alive) setNow(Date.now())
    })
    return () => {
      alive = false
    }
  }, [provider, live, runEnded])

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      if (!live || document.visibilityState !== 'visible') return
      const fetchedAt = useLiveQuota.getState().entries[provider]?.fetchedAt ?? 0
      if (Date.now() - fetchedAt >= LIVE_QUOTA_POLL_MS) void refreshLive(provider)
    }, QUOTA_TICK_MS)
    return () => clearInterval(timer)
  }, [provider, live])

  const model = live
    ? liveQuotaModel(entry?.snapshot, t, text)
    : account?.card
      ? cardQuotaModel(account.card, t, text)
      : account?.state === 'error'
        ? { windows: [], checkedAt: 0, problem: { tone: 'err' as const, text: text.quotaFailed } }
        : null
  return { model, now }
}

interface McpSnapshot {
  state: 'loading' | 'ready' | 'error'
  servers: CapabilityMcpServerSettingView[]
}

function useMcpServers(refreshKey: string): McpSnapshot {
  const [snap, setSnap] = useState<McpSnapshot>({ state: 'loading', servers: [] })
  useEffect(() => {
    const capabilities = window.yan?.capabilities
    if (!capabilities) {
      setSnap({ state: 'error', servers: [] })
      return undefined
    }
    let alive = true
    capabilities
      .snapshot()
      .then((next) => {
        if (alive) setSnap({ state: 'ready', servers: next.servers.filter((server) => server.enabled) })
      })
      .catch(() => {
        if (alive) setSnap((prev) => ({ state: prev.servers.length ? 'ready' : 'error', servers: prev.servers }))
      })
    return () => {
      alive = false
    }
  }, [refreshKey])
  return snap
}

const MCP_DOT: Record<CapabilityMcpServerSettingView['status'], string> = {
  ready: 'is-ok',
  connecting: 'is-run',
  disconnected: '',
  'needs-auth': 'is-warn',
  error: 'is-err'
}

const RUN_DOT: Record<SubagentRun['status'], string> = {
  starting: 'is-run',
  running: 'is-run',
  done: 'is-ok',
  error: 'is-err',
  cancelled: 'is-warn'
}

const CATEGORY_LABEL: Record<ContextCategory | 'free', MessageKey> = {
  system: 'ctx.cat.system',
  user: 'ctx.cat.user',
  assistant: 'ctx.cat.assistant',
  thinking: 'ctx.cat.thinking',
  tools: 'ctx.cat.tools',
  free: 'ctx.cat.free'
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
          <span className="wb-tile-title">{title}</span>
          {folded ? <ChevronRight size={12} className="wb-tile-chevron" aria-hidden /> : <ChevronDown size={12} className="wb-tile-chevron" aria-hidden />}
          {summary != null ? <span className="wb-tile-summary">{summary}</span> : null}
        </Button>
        {onOpen ? (
          <IconButton variant="ghost" size="sm" aria-label={openLabel ?? title} className="wb-tile-open" onPress={onOpen}>
            <ArrowUpRight size={13} aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {folded ? null : <div className="wb-tile-body">{children}</div>}
    </section>
  )
}

function ContextDetail({ data, last, text }: { data: ContextPaneData; last: CompactionRun | undefined; text: OverviewText }): ReactElement {
  const t = useT()
  const { usage, slices, compacted } = data
  const share = (n: number): number => (usage.windowSize > 0 ? (n / usage.windowSize) * 100 : 0)
  const rows = [...slices.filter((s) => s.tokens > 0), { id: 'free' as const, tokens: Math.max(0, usage.windowSize - usage.tokens) }]
  const record = last
    ? [compactionSummary(t, last), compactionTokensText(last), compactionReclaimText(t, last), compactionGrowthText(t, last, usage.tokens)]
        .filter(Boolean)
        .join(' · ')
    : ''
  return (
    <div className="wb-ov-ctx" data-testid="wb-ov-ctx">
      <div
        className="wb-ctx-bar"
        role="img"
        aria-label={t('ctx.tip', { used: shortTokens(usage.tokens), win: shortTokens(usage.windowSize), pct: Math.round(usage.percent ?? 0) })}
      >
        {slices.map((s) => (s.tokens > 0 ? <i key={s.id} className={`wb-ctx-seg c-${s.id}`} style={{ width: `${share(s.tokens)}%` }} /> : null))}
      </div>
      <p className="wb-ov-note">{`${text.contextUsed} ${shortTokens(usage.tokens)} / ${usage.windowAssumed ? '~' : ''}${shortTokens(usage.windowSize)}`}</p>
      <ul className="wb-ctx-legend" data-testid="wb-ov-ctx-breakdown">
        {rows.map((row) => {
          const name = t(row.id === 'system' && compacted ? 'ctx.cat.systemSummary' : CATEGORY_LABEL[row.id])
          return (
            <li key={row.id} className={row.id === 'free' ? 'free' : undefined} title={name}>
              <i className={`wb-ctx-swatch c-${row.id}`} aria-hidden />
              <span className="wb-ctx-legend-name">{name}</span>
              <span className="wb-ctx-legend-num">{shortTokens(row.tokens)}</span>
              <span className="wb-ctx-legend-num">{`${share(row.tokens).toFixed(1)}%`}</span>
            </li>
          )
        })}
      </ul>
      {record ? (
        <p className="wb-ov-note wb-ov-line" title={record} data-testid="wb-ov-ctx-compaction">
          {`${text.lastCompaction} · ${record}`}
        </p>
      ) : null}
    </div>
  )
}

function TaskRows({ runs, owner, text }: { runs: SubagentRun[]; owner: string; text: OverviewText }): ReactElement {
  const selectedId = useSubagentPanel((s) => (s.owner === owner ? s.runId : null))
  const anyLive = runs.some(isLiveRun)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!anyLive) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [anyLive])

  return (
    <ul className="wb-ov-items" data-testid="wb-ov-tasks">
      {runs.map((run) => {
        const live = isLiveRun(run)
        const selected = selectedId === run.id
        const label = compactTaskPaths(subagentTitle(run.task))
        const elapsed = formatDuration((run.endedAt ?? now) - run.startedAt, { minSeconds: 1 })
        return (
          <li key={run.id} className="wb-ov-task" data-status={run.status} data-selected={selected ? '1' : undefined}>
            <Button
              variant="ghost"
              size="sm"
              className="wb-ov-task-main"
              title={run.task}
              aria-label={`${text.taskDetail}: ${label}`}
              aria-haspopup="dialog"
              aria-expanded={selected}
              onPress={(event) => useSubagentPanel.getState().toggle(run.id, owner, event.target as HTMLElement)}
            >
              <span className="wb-ov-item-icon">
                <span className={`wb-ov-dot ${RUN_DOT[run.status]}`} aria-hidden />
              </span>
              <span className="wb-ov-task-name">{label}</span>
              <span className="wb-ov-task-time">{elapsed}</span>
            </Button>
            {live ? (
              <IconButton
                variant="ghost"
                size="sm"
                className="wb-ov-task-stop"
                aria-label={text.stopTask}
                onPress={() => void window.yan.subagents.stop(run.id)}
              >
                <Square size={12} aria-hidden />
              </IconButton>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function QuotaDetail({ model, now }: { model: QuotaTileModel; now: number }): ReactElement {
  const t = useT()
  const stale = quotaReadingStale(model.checkedAt, now, !!model.staleError)
  const hasData = model.windows.length > 0 || !!model.balance
  return (
    <div className="wb-ov-quota" data-testid="wb-ov-quota">
      {stale && hasData ? (
        <p className="wb-quota-stale" title={t('quota.staleTip')} data-testid="wb-ov-quota-stale">
          {[quotaReadAgo(t, model.checkedAt, now), model.staleError ? t('quota.readFailed', { msg: model.staleError }) : ''].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {model.windows.map((window) => (
        <QuotaWindowRow key={window.id} window={window} stale={stale} now={now} testId={`wb-ov-quota-win-${window.id}`} compact />
      ))}
      {model.balance ? (
        <div className="quota-win" data-tone={stale ? 'stale' : 'ok'} data-testid="wb-ov-quota-balance">
          <div className="quota-win-top">
            <span className="quota-win-label">{model.balance.label}</span>
            <span className="quota-win-value ui-meta-num">{money(model.balance.amount, model.balance.currency)}</span>
          </div>
        </div>
      ) : null}
      {model.problem ? <p className="wb-quota-msg">{model.problem.text}</p> : null}
    </div>
  )
}

export function OverviewPane({ owner, onOpenView }: OverviewPaneProps): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = useMemo(() => workbenchText(lang).overview, [lang])
  const todoText = useMemo(() => todoTileText(lang), [lang])

  const cwd = owner?.cwd || ''
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const settings = useStore((s) => s.settings)
  const messages = useStreamingThrottledStore((s) => s.messages)
  const todos = useStore((s) => s.todos)
  const subagents = useStore((s) => s.subagents)
  const widgets = useStore((s) => s.widgets)
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

  const gitMessageCount = useThrottledValue(messages.length, agentRunning, GIT_REFRESH_WHILE_RUNNING_MS)
  const gitRefresh = `${gitMessageCount}:${agentRunning ? 1 : 0}`
  const repo = useGitRepo(cwd || null, gitRefresh)
  const branch = repo ? (repo.detached ? text.detached : repo.branch || text.noBranch) : null
  const changesSummary = !repo ? undefined : repo.changedCount > 0 ? text.changesFiles(repo.changedCount) : text.changesNone

  const contextFolded = isFolded('context')
  const contextData = useMemo(
    () => (contextFolded ? null : contextPaneData({ session, stats, messages })),
    [contextFolded, session, stats, messages]
  )
  const usage = contextData?.usage ?? contextUsageSummary(session, stats)
  const contextSummary = usage.known && usage.percent !== null ? `${Math.round(usage.percent)}%` : undefined
  const contextTone = usage.tone !== 'ok' && usage.known ? usage.tone : undefined

  const hasTodos = hasTodoTileContent(todos)
  const todoModel = useMemo(() => buildTodoTileModel(todos, agentRunning), [todos, agentRunning])

  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const sessionIds = view.sessionId ? [view.sessionId] : []
  const runs: SubagentRun[] = visibleSubagentRuns(subagents, { sessionIds }).sort(compareRuns)
  const runningCount = runs.filter(isLiveRun).length
  const taskSummary = runningCount > 0 ? text.runningCount(runningCount) : text.doneCount(runs.length)

  const extWidgets = Object.entries(widgets).filter(([, lines]) => lines.length > 0)

  const mcp = useMcpServers(agentRunning ? 'running' : 'idle')
  const mcpReady = mcp.servers.filter((server) => server.status === 'ready').length
  const mcpSummary = mcp.state === 'ready' && mcp.servers.length > 0 ? text.mcpConnected(mcpReady, mcp.servers.length) : undefined
  const mcpTone = mcp.servers.some((server) => server.status === 'error') ? 'err' : mcp.servers.some((server) => server.status === 'needs-auth') ? 'warn' : undefined

  const quota = useQuotaTile(provider, agentRunning, t, text)
  const quotaModel = quota.model
  const quotaStale = quotaModel ? quotaReadingStale(quotaModel.checkedAt, quota.now, !!quotaModel.staleError) : false
  const quotaWindows = quotaModel?.windows ?? []
  const binding = bindingQuotaWindow(quotaWindows.filter((w) => !windowAwaitingReset(w, quota.now))) ?? bindingQuotaWindow(quotaWindows)
  const bindingAwaiting = binding ? windowAwaitingReset(binding, quota.now) : false
  const bindingTone = binding ? quotaWindowTone(binding, quotaStale, quota.now) : null
  const quotaSummary = binding
    ? `${quotaShortLabel(t, binding)} ${bindingAwaiting ? '—' : `${Math.round(windowUsedPct(binding) ?? 0)}%`}`
    : quotaModel?.balance
      ? money(quotaModel.balance.amount, quotaModel.balance.currency)
      : quotaModel?.problem
        ? quotaModel.problem.tone === 'warn'
          ? text.quotaExpired
          : text.quotaFailed
        : undefined
  const quotaTone = bindingTone === 'warn' || bindingTone === 'err' ? bindingTone : !binding && !quotaModel?.balance ? quotaModel?.problem?.tone : undefined

  return (
    <div className="wb-overview" data-testid="wb-overview">
      <Tile id="env" title={text.tiles.env} folded={isFolded('env')} onToggle={toggle}>
        <ul className="wb-ov-items">
          {cwd ? (
            <li className="wb-ov-item" title={cwd} data-testid="wb-ov-path">
              <Folder size={14} className="wb-ov-item-icon" aria-hidden />
              <span className="wb-ov-item-label">{projectName}</span>
              {pathRoot(cwd) ? <span className="wb-ov-item-value">{pathRoot(cwd)}</span> : null}
            </li>
          ) : null}
          {branch ? (
            <li className="wb-ov-item" title={`${text.branchLabel} ${branch}`}>
              <GitBranch size={14} className="wb-ov-item-icon" aria-hidden />
              <span className="wb-ov-item-label">{branch}</span>
            </li>
          ) : null}
          <li className="wb-ov-item" title={`${text.permissionLabel} ${modeLabel}`}>
            <ShieldCheck size={14} className="wb-ov-item-icon" aria-hidden />
            <span className="wb-ov-item-label">{modeLabel}</span>
          </li>
        </ul>
      </Tile>

      <Tile
        id="context"
        title={text.tiles.context}
        summary={contextSummary}
        folded={contextFolded}
        onToggle={toggle}
        onOpen={() => onOpenView('context')}
        openLabel={`${text.openFull} ${text.tiles.context}`}
        tone={contextTone}
      >
        {contextData && usage.known ? (
          <ContextDetail data={contextData} last={session?.lastCompaction} text={text} />
        ) : (
          <Meter aria-label={text.tiles.context} className="wb-ov-meter" value={0} minValue={0} maxValue={100} />
        )}
      </Tile>

      {hasTodos ? (
        <Tile id="todos" title={text.tiles.todos} summary={`${todoModel.done}/${todoModel.total}`} folded={isFolded('todos')} onToggle={toggle}>
          <TodoTileRows model={todoModel} text={todoText} />
        </Tile>
      ) : null}

      {runs.length > 0 ? (
        <Tile id="tasks" title={text.tiles.tasks} summary={taskSummary} folded={isFolded('tasks')} onToggle={toggle}>
          <TaskRows runs={runs} owner={view.key} text={text} />
        </Tile>
      ) : null}

      {extWidgets.length > 0 ? (
        <Tile id="ext" title={text.tiles.ext} folded={isFolded('ext')} onToggle={toggle}>
          <div className="wb-ov-ext" data-testid="wb-ov-ext">
            {extWidgets.map(([key, lines]) => (
              <pre key={key} className="wb-ov-ext-block" title={key}>{lines.join('\n')}</pre>
            ))}
          </div>
        </Tile>
      ) : null}

      {mcp.state === 'error' || mcp.servers.length > 0 ? (
        <Tile id="mcp" title={text.tiles.mcp} summary={mcpSummary} folded={isFolded('mcp')} onToggle={toggle} tone={mcpTone}>
          {mcp.state === 'error' ? <p className="wb-ov-note">{text.mcpFailed}</p> : null}
          {mcp.servers.length > 0 ? (
            <ul className="wb-ov-items">
              {mcp.servers.map((server) => (
                <li key={server.id} className="wb-ov-item" title={text.mcpStatus[server.status]}>
                  <span className="wb-ov-item-icon">
                    <span className={`wb-ov-dot ${MCP_DOT[server.status]}`} aria-hidden />
                  </span>
                  <span className="wb-ov-item-label">{server.title || server.id}</span>
                  <span className="wb-ov-item-value">
                    {server.status === 'ready' && server.toolCount !== null ? text.mcpTools(server.toolCount) : text.mcpStatus[server.status]}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Tile>
      ) : null}

      {repo ? (
        <Tile
          id="changes"
          title={text.tiles.changes}
          summary={changesSummary}
          folded={isFolded('changes')}
          onToggle={toggle}
          onOpen={() => onOpenView('changes')}
          openLabel={`${text.openFull} ${text.tiles.changes}`}
        >
          <ul className="wb-ov-items">
            {([
              [text.changesStaged, repo.stagedCount],
              [text.changesUnstaged, repo.unstagedCount],
              [text.changesUntracked, repo.untrackedCount]
            ] as const).map(([label, count]) => (
              <li key={label} className="wb-ov-item">
                <span className="wb-ov-item-label">{label}</span>
                <span className="wb-ov-item-value">{count}</span>
              </li>
            ))}
          </ul>
        </Tile>
      ) : null}

      {quotaModel ? (
        <Tile
          id="quota"
          title={text.tiles.quota}
          summary={quotaSummary}
          folded={isFolded('quota')}
          onToggle={toggle}
          onOpen={() => onOpenView('quota')}
          openLabel={`${text.openFull} ${text.tiles.quota}`}
          tone={quotaTone}
        >
          <QuotaDetail model={quotaModel} now={quota.now} />
        </Tile>
      ) : null}
    </div>
  )
}
