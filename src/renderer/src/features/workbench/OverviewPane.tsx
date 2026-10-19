import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  Brain,
  Copy,
  Cpu,
  FileText,
  Files,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Monitor,
  ShieldCheck,
  Square
} from 'lucide-react'
import { Button, IconButton, Menu, MenuItem, Meter, Notice, Popover } from '../../ui'
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
import { phaseWord, runTone, useRunsV3, type RunTone } from '../../state/runs-v3'
import { sessionViewIdentity } from '../session/view-state'
import { useSubagentPanel } from '../session/subagent-panel-state'
import { compactTaskPaths, firstLine } from '../session/SubagentLine'
import { buildTodoTileModel, hasTodoTileContent } from '../todos/todo-tile-model'
import { TodoTileRows, todoTileText } from '../todos/TodoTileView'
import { QuotaWindowRow, quotaReadAgo, quotaShortLabel, quotaWindowTone } from '../../patterns/QuotaWindowRow'
import { formatDuration } from '../../../../shared/duration'
import { normalizePermissionMode, type PermissionMode } from '../../../../shared/approval'
import type { AccountQuotaCard } from '../../../../shared/account-quota'
import type { RunSnapshot } from '../../../../shared/runs'
import { money } from '../../../../shared/quota-mini'
import { bindingQuotaWindow, quotaReadingStale, windowAwaitingReset, windowUsedPct } from '../../../../shared/quota-forecast'
import type { GitRepoState } from '../../../../shared/git'
import type { CapabilityMcpServerSettingView, CompactionRun, ProviderQuota, QuotaWindow, SubagentRun } from '../../../../shared/ipc'
import { autoCompactLimitOf, contextPaneData, contextUsageSummary, shortTokens, type ContextPaneData } from './context-pane-view'
import { workbenchText, type OverviewText } from './workbench-text'
import type { WorkbenchTabId, WorkspaceOwner } from './types'
import { RailCard } from './RailCard'
import { RailSectionsMenu } from './RailSectionsMenu'
import {
  isRailSectionHidden,
  isRailSectionOpen,
  resolveRailOrder,
  useRailSections,
  type RailSectionId
} from './rail-sections'
import { outputFolder, outputName, sessionOutputs, useGitLineTotals } from './rail-data'
import { railText, type RailText } from './rail-text'
import { useRailReorder } from './use-rail-reorder'
import { showPreview } from './tool-tiles'
import './workbench.css'

export interface OverviewPaneProps {
  owner: WorkspaceOwner | null
  onOpenView: (tab: WorkbenchTabId) => void
  onPreview?: (path: string) => void
}

const QUOTA_TICK_MS = 30_000
const GIT_REFRESH_WHILE_RUNNING_MS = 4_000

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function parentFolder(path: string): string {
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
  problem?: { tone: 'ask' | 'fail'; text: string }
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
  const problem = snapshot.error && !windows.length && !balance ? { tone: 'fail' as const, text: t('acct.failed', { msg: snapshot.error }) } : undefined
  if (!windows.length && !balance && !problem) return null
  return { windows, balance, checkedAt: snapshot.checkedAt, staleError: snapshot.staleError, problem }
}

function cardQuotaModel(card: AccountQuotaCard, t: TFunc, text: OverviewText): QuotaTileModel | null {
  const problem =
    card.status === 'error'
      ? { tone: 'fail' as const, text: t('acct.failed', { msg: card.error ?? '' }) }
      : card.status === 'expired'
        ? { tone: 'ask' as const, text: card.hint || text.quotaExpired }
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
        ? { windows: [], checkedAt: 0, problem: { tone: 'fail' as const, text: text.quotaFailed } }
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

const BACKGROUND_RUN_KINDS: ReadonlySet<RunSnapshot['kind']> = new Set(['scheduled', 'review'])
const MAX_FINISHED_BACKGROUND = 5

const BACKGROUND_DOT: Record<RunTone, string> = {
  run: 'is-run',
  ask: 'is-warn',
  stall: 'is-warn',
  fail: 'is-err',
  done: 'is-ok',
  idle: ''
}

function isSettledRun(run: SubagentRun): boolean {
  if (run.status === 'cancelled' || run.launchFailed) return true
  return run.status === 'done' && run.review !== 'pending' && run.review !== 'conflict'
}

function isSettledBackground(run: RunSnapshot): boolean {
  const phase = run.phase
  return phase.kind === 'done' || phase.kind === 'stopped' || (phase.kind === 'failed' && phase.seen)
}

function modelShortName(model: string | undefined): string {
  if (!model) return ''
  const parts = model.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? model
}

function subagentLabels(runs: SubagentRun[]): Map<string, string> {
  const base = new Map<string, string>()
  const seen = new Map<string, number>()
  for (const run of runs) {
    const label = run.brief?.title || compactTaskPaths(firstLine(run.task || run.brief?.goal || ''))
    base.set(run.id, label)
    seen.set(label, (seen.get(label) ?? 0) + 1)
  }
  const counter = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    const label = base.get(run.id) ?? ''
    if ((seen.get(label) ?? 0) < 2) {
      labels.set(run.id, label)
      continue
    }
    const n = (counter.get(label) ?? 0) + 1
    counter.set(label, n)
    const model = modelShortName(run.model)
    labels.set(run.id, model ? `${label} · ${model} #${n}` : `${label} #${n}`)
  }
  return labels
}

function compareRuns(a: SubagentRun, b: SubagentRun): number {
  const live = Number(isLiveRun(b)) - Number(isLiveRun(a))
  return live !== 0 ? live : b.startedAt - a.startedAt
}

type RowMenuKey = 'reveal' | 'copyPath' | 'openFiles' | 'copyBranch' | 'switchBranch'

interface RowMenuItem {
  key: RowMenuKey
  label: string
  icon: ReactNode
}

function RailRowMenu({
  label,
  icon,
  value,
  title,
  menuLabel,
  items,
  onAction,
  testId
}: {
  label: string
  icon: ReactNode
  value?: string
  title: string
  menuLabel: string
  items: RowMenuItem[]
  onAction: (key: RowMenuKey) => void
  testId: string
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <li className="wb-ov-item wb-rail-row" title={title}>
      <Button ref={anchor} variant="ghost" size="sm" className="wb-rail-row-btn" aria-haspopup="menu" aria-expanded={open} onPress={() => setOpen(true)} data-testid={testId}>
        <span className="wb-ov-item-icon">{icon}</span>
        <span className="wb-ov-item-label">{label}</span>
        {value ? <span className="wb-ov-item-value">{value}</span> : null}
      </Button>
      <Popover triggerRef={anchor} isOpen={open} onOpenChange={setOpen} placement="bottom start" offset={4}>
        <Menu aria-label={menuLabel} autoFocus="first" onAction={(key) => onAction(key as RowMenuKey)} onClose={() => setOpen(false)}>
          {items.map((item) => (
            <MenuItem key={item.key} id={item.key} textValue={item.label}>
              {item.icon}
              {item.label}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </li>
  )
}

function ContextDetail({ data, last, text }: { data: ContextPaneData; last: CompactionRun | undefined; text: OverviewText }): ReactElement {
  const t = useT()
  const { usage, slices, compacted } = data
  const share = (n: number): number => (usage.windowSize > 0 ? (n / usage.windowSize) * 100 : 0)
  const rows = [...slices.filter((s) => s.tokens > 0), { id: 'free' as const, tokens: Math.max(0, usage.windowSize - usage.tokens) }]
  const limitNote = usage.cappedByLimit
    ? t('ctx.limitNote', { model: shortTokens(usage.modelWindow), limit: shortTokens(usage.windowSize) })
    : ''
  const record = last
    ? [compactionSummary(t, last), compactionTokensText(last), compactionReclaimText(t, last), compactionGrowthText(t, last, usage.tokens)]
        .filter(Boolean)
        .join(' · ')
    : ''
  return (
    <div className="wb-ov-ctx" data-testid="wb-ov-ctx">
      <div className="wb-ov-ctx-head" title={limitNote || undefined}>
        <span className="wb-ov-ctx-used">{`${text.contextUsed} ${Math.round(usage.percent ?? share(usage.tokens))}%`}</span>
        <span className="wb-ov-ctx-total">{`${shortTokens(usage.tokens)} / ${usage.windowAssumed ? '~' : ''}${shortTokens(usage.windowSize)}`}</span>
      </div>
      <div
        className="wb-ctx-bar"
        role="img"
        aria-label={t('ctx.tip', { used: shortTokens(usage.tokens), win: shortTokens(usage.windowSize), pct: Math.round(usage.percent ?? 0) })}
      >
        {slices.map((s) => (s.tokens > 0 ? <i key={s.id} className={`wb-ctx-seg c-${s.id}`} style={{ width: `${share(s.tokens)}%` }} /> : null))}
      </div>
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

function SubagentTaskRows({ runs, owner, text }: { runs: SubagentRun[]; owner: string; text: OverviewText }): ReactElement {
  const selectedId = useSubagentPanel((s) => (s.owner === owner ? s.runId : null))
  const anyLive = runs.some(isLiveRun)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!anyLive) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [anyLive])
  const labels = subagentLabels(runs)

  return (
    <ul className="wb-ov-items" data-testid="wb-ov-tasks">
      {runs.map((run) => {
        const live = isLiveRun(run)
        const selected = selectedId === run.id
        const label = labels.get(run.id) ?? ''
        const model = modelShortName(run.model)
        const elapsed = formatDuration((run.endedAt ?? now) - run.startedAt, { minSeconds: 1 })
        return (
          <li key={run.id} className="wb-ov-task" data-status={run.status} data-selected={selected ? '1' : undefined}>
            <Button
              variant="ghost"
              size="sm"
              className="wb-ov-task-main"
              title={model ? `${run.task}\n${model}` : run.task}
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

function BackgroundTaskRows({ runs, lang }: { runs: RunSnapshot[]; lang: 'zh-CN' | 'en-US' }): ReactElement {
  return (
    <ul className="wb-ov-items" data-testid="wb-ov-background">
      {runs.map((run) => {
        const label = run.title || run.code
        const status = phaseWord(lang, run.phase)
        return (
          <li key={run.runId} className="wb-ov-item wb-ov-bg" data-kind={run.kind} title={`${run.code} ${label}`}>
            <span className="wb-ov-item-icon">
              <span className={`wb-ov-dot ${BACKGROUND_DOT[runTone(run.phase)]}`} aria-hidden />
            </span>
            <span className="wb-ov-task-name">{label}</span>
            <span className="wb-ov-task-time">{status}</span>
          </li>
        )
      })}
    </ul>
  )
}

function TaskGroups({
  subagents,
  background,
  owner,
  lang,
  text
}: {
  subagents: SubagentRun[]
  background: RunSnapshot[]
  owner: string
  lang: 'zh-CN' | 'en-US'
  text: OverviewText
}): ReactElement {
  const [showFinished, setShowFinished] = useState(false)
  const finishedBackground = background.filter(isSettledBackground).slice(0, MAX_FINISHED_BACKGROUND)
  const finishedCount = subagents.filter(isSettledRun).length + finishedBackground.length
  const shownSubagents = showFinished ? subagents : subagents.filter((run) => !isSettledRun(run))
  const shownBackground = background.filter((run) => !isSettledBackground(run) || (showFinished && finishedBackground.includes(run)))
  const grouped = shownBackground.length > 0 && shownSubagents.length > 0

  return (
    <div className="wb-ov-tasks" data-testid="wb-ov-task-groups">
      {shownSubagents.length > 0 ? (
        <div className="wb-ov-group">
          {grouped ? <p className="wb-ov-group-title">{text.subagentGroup}</p> : null}
          <SubagentTaskRows runs={shownSubagents} owner={owner} text={text} />
        </div>
      ) : null}
      {shownBackground.length > 0 ? (
        <div className="wb-ov-group">
          <p className="wb-ov-group-title">{text.backgroundGroup}</p>
          <BackgroundTaskRows runs={shownBackground} lang={lang} />
        </div>
      ) : null}
      {finishedCount > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="wb-ov-finished-toggle"
          aria-pressed={showFinished}
          data-testid="wb-ov-finished-toggle"
          onPress={() => setShowFinished((prev) => !prev)}
        >
          {showFinished ? text.hideFinished : text.showFinished(finishedCount)}
        </Button>
      ) : null}
    </div>
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
      {model.problem ? <Notice tone={model.problem.tone} compact>{model.problem.text}</Notice> : null}
    </div>
  )
}

function OutputRows({ files, text, onOpen }: { files: ReturnType<typeof sessionOutputs>; text: RailText; onOpen: (path: string) => void }): ReactElement {
  const statusLabel = { created: text.outputCreated, modified: text.outputModified, deleted: text.outputDeleted }
  return (
    <ul className="wb-ov-items" data-testid="wb-rail-outputs">
      {files.map((file) => (
        <li key={file.path} className="wb-ov-item wb-rail-row" title={`${statusLabel[file.status]} ${file.path}`}>
          <Button
            variant="ghost"
            size="sm"
            className="wb-rail-row-btn"
            isDisabled={file.status === 'deleted'}
            onPress={() => onOpen(file.path)}
          >
            <span className="wb-ov-item-icon">
              <FileText size={14} aria-hidden />
            </span>
            <span className="wb-ov-item-label">{outputName(file.path)}</span>
            {outputFolder(file.path) ? <span className="wb-ov-item-value">{outputFolder(file.path)}</span> : null}
          </Button>
        </li>
      ))}
    </ul>
  )
}

function LineDelta({ added, removed, text }: { added: number; removed: number; text: RailText }): ReactElement {
  return (
    <span className="wb-rail-delta" aria-label={text.linesChanged(added, removed)}>
      <span className="wb-rail-added">+{added}</span>
      <span className="wb-rail-removed">−{removed}</span>
    </span>
  )
}

export function OverviewPane({ owner, onOpenView }: OverviewPaneProps): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = useMemo(() => workbenchText(lang).overview, [lang])
  const rail = useMemo(() => railText(lang), [lang])
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

  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const foldKey = view.key || 'none'
  const savedOrder = useRailSections((s) => s.order)
  const hidden = useRailSections((s) => s.hidden)
  const foldsBySession = useRailSections((s) => s.foldsBySession)
  const setSectionOpen = useRailSections((s) => s.setOpen)
  const setOrder = useRailSections((s) => s.setOrder)
  const order = useMemo(() => resolveRailOrder(savedOrder), [savedOrder])
  const isOpen = (id: RailSectionId): boolean => isRailSectionOpen({ order: savedOrder, hidden, foldsBySession }, foldKey, id)

  const projectName = cwd ? settings?.projectNames?.[cwd] || lastSegment(cwd) : ''
  const mode: PermissionMode = normalizePermissionMode(settings?.permissionMode)
  const modeLabel = t(`permission.label.${mode}` as 'permission.label.danger')
  const modelLabel = session?.model ? session.model.name || session.model.id : ''
  const thinkingLevel = session?.thinkingLevel || 'off'
  const thinkingLabel = t(`think.${thinkingLevel}` as MessageKey)

  const gitMessageCount = useThrottledValue(messages.length, agentRunning, GIT_REFRESH_WHILE_RUNNING_MS)
  const gitRefresh = `${gitMessageCount}:${agentRunning ? 1 : 0}`
  const repo = useGitRepo(cwd || null, gitRefresh)
  const branch = repo ? (repo.detached ? text.detached : repo.branch || text.noBranch) : null
  const lineTotals = useGitLineTotals(cwd || null, !!repo && repo.changedCount > 0 && !isRailSectionHidden({ hidden }, 'changes'), gitRefresh)
  const changesSummary = !repo
    ? undefined
    : repo.changedCount === 0
      ? text.changesNone
      : lineTotals
        ? <LineDelta added={lineTotals.added} removed={lineTotals.removed} text={rail} />
        : text.changesFiles(repo.changedCount)

  const contextOpen = isOpen('context')
  const autoCompactLimit = autoCompactLimitOf(session, settings)
  const contextData = useMemo(
    () => (!contextOpen ? null : contextPaneData({ session, stats, messages, autoCompactLimit })),
    [contextOpen, session, stats, messages, autoCompactLimit]
  )
  const usage = contextData?.usage ?? contextUsageSummary(session, stats, autoCompactLimit)
  const contextSummary = usage.known && usage.percent !== null ? `${Math.round(usage.percent)}%` : undefined
  const contextTone = usage.tone !== 'ok' && usage.known ? usage.tone : undefined

  const hasTodos = hasTodoTileContent(todos)
  const todoModel = useMemo(() => buildTodoTileModel(todos, agentRunning), [todos, agentRunning])

  const outputs = useMemo(() => sessionOutputs(messages), [messages])

  const sessionIds = view.sessionId ? [view.sessionId] : []
  const runs: SubagentRun[] = visibleSubagentRuns(subagents, { sessionIds }).sort(compareRuns)
  const allRuns = useRunsV3((s) => s.runs)
  const backgroundRuns = useMemo(() => allRuns.filter((run) => BACKGROUND_RUN_KINDS.has(run.kind)), [allRuns])
  const runningCount = runs.filter(isLiveRun).length + backgroundRuns.filter((run) => !isSettledBackground(run)).length
  const taskTotal = runs.length + backgroundRuns.length
  const taskSummary = runningCount > 0 ? text.runningCount(runningCount) : text.doneCount(taskTotal)

  const extWidgets = Object.entries(widgets).filter(([, lines]) => lines.length > 0)

  const mcp = useMcpServers(agentRunning ? 'running' : 'idle')
  const mcpReady = mcp.servers.filter((server) => server.status === 'ready').length
  const mcpSummary = mcp.state === 'ready' && mcp.servers.length > 0 ? text.mcpConnected(mcpReady, mcp.servers.length) : undefined
  const mcpTone = mcp.servers.some((server) => server.status === 'error') ? 'fail' : mcp.servers.some((server) => server.status === 'needs-auth') ? 'ask' : undefined

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
        ? quotaModel.problem.tone === 'ask'
          ? text.quotaExpired
          : text.quotaFailed
        : undefined
  const quotaTone = bindingTone === 'ask' || bindingTone === 'fail' ? bindingTone : !binding && !quotaModel?.balance ? quotaModel?.problem?.tone : undefined

  const openOutput = (path: string): void => {
    if (!owner) return
    showPreview(owner.key, path)
    onOpenView('files')
  }

  const runRowAction = (key: RowMenuKey): void => {
    switch (key) {
      case 'reveal':
        if (cwd) void window.yan.revealPath(cwd)
        return
      case 'copyPath':
        if (cwd) void navigator.clipboard.writeText(cwd)
        return
      case 'openFiles':
        onOpenView('files')
        return
      case 'copyBranch':
        if (repo?.branch) void navigator.clipboard.writeText(repo.branch)
        return
      case 'switchBranch':
        onOpenView('branch')
    }
  }

  const sections: Partial<Record<RailSectionId, { summary?: ReactNode; tone?: 'ok' | 'ask' | 'fail'; onOpenView?: () => void; body: ReactNode }>> = {
    environment: {
      body: (
        <ul className="wb-ov-items">
          <li className="wb-ov-item" data-testid="wb-rail-local">
            <Monitor size={14} className="wb-ov-item-icon" aria-hidden />
            <span className="wb-ov-item-label">{rail.local}</span>
          </li>
          {cwd ? (
            <RailRowMenu
              label={projectName}
              icon={<Folder size={14} aria-hidden />}
              value={parentFolder(cwd)}
              title={cwd}
              menuLabel={rail.folderMenu}
              testId="wb-ov-path"
              onAction={runRowAction}
              items={[
                { key: 'reveal', label: rail.reveal, icon: <FolderOpen size={14} aria-hidden /> },
                { key: 'copyPath', label: rail.copyPath, icon: <Copy size={14} aria-hidden /> },
                { key: 'openFiles', label: rail.openFiles, icon: <Files size={14} aria-hidden /> }
              ]}
            />
          ) : null}
          {branch ? (
            <RailRowMenu
              label={branch}
              icon={<GitBranch size={14} aria-hidden />}
              title={`${text.branchLabel} ${branch}`}
              menuLabel={rail.branchMenu}
              testId="wb-rail-branch"
              onAction={runRowAction}
              items={[
                ...(repo?.branch ? [{ key: 'copyBranch' as const, label: rail.copyBranch, icon: <Copy size={14} aria-hidden /> }] : []),
                { key: 'switchBranch', label: rail.switchBranch, icon: <GitBranch size={14} aria-hidden /> }
              ]}
            />
          ) : null}
        </ul>
      )
    },
    settings: {
      body: (
        <ul className="wb-ov-items" data-testid="wb-rail-settings">
          {modelLabel ? (
            <li className="wb-ov-item" title={`${rail.model} ${modelLabel}`}>
              <Cpu size={14} className="wb-ov-item-icon" aria-hidden />
              <span className="wb-ov-item-label">{modelLabel}</span>
              <span className="wb-ov-item-value">{rail.model}</span>
            </li>
          ) : null}
          {session?.model?.reasoning ? (
            <li className="wb-ov-item" title={`${rail.thinking} ${thinkingLabel}`}>
              <Brain size={14} className="wb-ov-item-icon" aria-hidden />
              <span className="wb-ov-item-label">{thinkingLabel}</span>
              <span className="wb-ov-item-value">{rail.thinking}</span>
            </li>
          ) : null}
          <li className="wb-ov-item" title={`${rail.permission} ${modeLabel}`}>
            <ShieldCheck size={14} className="wb-ov-item-icon" aria-hidden />
            <span className="wb-ov-item-label">{modeLabel}</span>
            <span className="wb-ov-item-value">{rail.permission}</span>
          </li>
        </ul>
      )
    },
    context: {
      summary: !contextOpen || !contextData || !usage.known ? contextSummary : undefined,
      tone: contextTone,
      onOpenView: () => onOpenView('context'),
      body: contextData && usage.known ? (
        <ContextDetail data={contextData} last={session?.lastCompaction} text={text} />
      ) : (
        <Meter aria-label={rail.sections.context} className="wb-ov-meter" value={0} minValue={0} maxValue={100} />
      )
    },
    ...(quotaModel
      ? {
          usage: {
            summary: quotaSummary,
            tone: quotaTone,
            onOpenView: () => onOpenView('quota'),
            body: <QuotaDetail model={quotaModel} now={quota.now} />
          }
        }
      : {}),
    ...(mcp.state === 'error' || mcp.servers.length > 0
      ? {
          connectors: {
            summary: mcpSummary,
            tone: mcpTone,
            body: (
              <>
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
              </>
            )
          }
        }
      : {}),
    ...(hasTodos
      ? {
          progress: {
            summary: rail.progress(todoModel.done, todoModel.total),
            body: <TodoTileRows model={todoModel} text={todoText} />
          }
        }
      : {}),
    ...(outputs.length > 0
      ? {
          outputs: {
            summary: String(outputs.length),
            body: <OutputRows files={outputs} text={rail} onOpen={openOutput} />
          }
        }
      : {}),
    ...(repo
      ? {
          changes: {
            summary: changesSummary,
            onOpenView: () => onOpenView('changes'),
            body: repo.changedCount > 0 ? (
              <>
                <ul className="wb-ov-items">
                  {([
                    [text.changesStaged, repo.stagedCount],
                    [text.changesUnstaged, repo.unstagedCount],
                    [text.changesUntracked, repo.untrackedCount]
                  ] as const).filter(([, count]) => count > 0).map(([label, count]) => (
                    <li key={label} className="wb-ov-item">
                      <span className="wb-ov-item-label">{label}</span>
                      <span className="wb-ov-item-value">{count}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  variant="secondary"
                  size="sm"
                  className="wb-rail-commit"
                  icon={<GitCommitHorizontal size={14} aria-hidden />}
                  onPress={() => onOpenView('changes')}
                  data-testid="wb-rail-commit"
                >
                  {rail.commitChanges}
                </Button>
              </>
            ) : null
          }
        }
      : {}),
    ...(taskTotal > 0
      ? {
          backgroundTasks: {
            summary: taskSummary,
            body: <TaskGroups subagents={runs} background={backgroundRuns} owner={view.key} lang={lang} text={text} />
          }
        }
      : {}),
    ...(extWidgets.length > 0
      ? {
          extensions: {
            body: (
              <div className="wb-ov-ext" data-testid="wb-ov-ext">
                {extWidgets.map(([key, lines]) => (
                  <pre key={key} className="wb-ov-ext-block" title={key}>{lines.join('\n')}</pre>
                ))}
              </div>
            )
          }
        }
      : {})
  }

  const visible = order.filter((id) => sections[id] && !isRailSectionHidden({ hidden }, id))
  const railRef = useRef<HTMLDivElement>(null)
  const reorder = useRailReorder(railRef, visible, order, setOrder, rail)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="wb-overview" ref={railRef} role="region" aria-label={rail.railLabel} aria-describedby="wb-rail-hint" data-testid="wb-overview">
      <span id="wb-rail-hint" className="wb-rail-sr" hidden>{rail.reorderHint}</span>
      <span className="wb-rail-sr" aria-live="polite">{reorder.announcement}</span>
      {visible.map((id) => {
        const section = sections[id]
        if (!section) return null
        return (
          <RailCard
            key={id}
            id={id}
            title={rail.sections[id]}
            summary={section.summary}
            tone={section.tone}
            open={isOpen(id)}
            onOpenChange={(open) => setSectionOpen(foldKey, id, open)}
            onOpenView={section.onOpenView}
            openLabel={`${text.openFull} ${rail.sections[id]}`}
            grip={reorder.gripFor(id)}
            dragging={reorder.dragging === id}
            onHeaderMenu={(anchor) => {
              menuAnchor.current = anchor
              setMenuOpen(true)
            }}
          >
            {section.body}
          </RailCard>
        )
      })}
      <RailSectionsMenu anchor={menuAnchor} open={menuOpen} onOpenChange={setMenuOpen} text={rail} />
    </div>
  )
}
