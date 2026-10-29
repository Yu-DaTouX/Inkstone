import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Copy, FileDiff, Files, Folder, FolderOpen, GitBranch, Monitor, X } from 'lucide-react'
import { Button, IconButton, Menu, MenuItem, Meter, Notice, Popover, RailRow, RailValue, type RailTone } from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
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
import { LIVE_QUOTA_MIN_GAP_MS, LIVE_QUOTA_POLL_MS, liveQuotaSupported, publishAccountQuotaReport, refreshLiveQuota, useLiveQuota } from '../../state/live-quota'
import { selectSubagentRuns, subagentScopeForView } from '../../state/subagent-view'
import { useRunsV3 } from '../../state/runs-v3'
import { sessionViewIdentity } from '../session/view-state'
import { useSubagentStopping } from '../../state/subagent-stopping'
import { QuotaWindowRow, quotaReadAgo, quotaShortLabel, quotaWindowTone } from '../../patterns/QuotaWindowRow'
import type { AccountQuotaCard } from '../../../../shared/account-quota'
import type { RunSnapshot } from '../../../../shared/runs'
import { money } from '../../../../shared/quota-mini'
import { bindingQuotaWindow, quotaReadingStale, windowAwaitingReset, windowUsedPct } from '../../../../shared/quota-forecast'
import type { GitRepoState } from '../../../../shared/git'
import type { CompactionRun, ProviderQuota, QuotaWindow, SubagentRun } from '../../../../shared/ipc'
import { autoCompactLimitOf, contextPaneData, contextUsageSummary, shortTokens, type ContextPaneData } from './context-pane-view'
import { workbenchText, type OverviewText } from './workbench-text'
import type { WorkbenchTabId, WorkspaceOwner } from './types'
import { RailCard } from './RailCard'
import { RailStatsBody, useRailStats } from './RailStats'
import { GLANCE_BARS, type RailStatsModel } from './rail-stats'
import { RailSectionsMenu } from './RailSectionsMenu'
import {
  isRailSectionHidden,
  isRailSectionOpen,
  resolveRailOrder,
  useRailSections,
  type RailSectionId
} from './rail-sections'
import {
  outputCandidates,
  outputFolder,
  outputName,
  useDismissedOutputs,
  useGitLineTotals,
  useOutputScreen,
  visibleOutputs,
  type RailChangedFile,
  type RailOutput
} from './rail-data'
import { railText, type RailText } from './rail-text'
import { useRailReorder } from './use-rail-reorder'
import { showPreview } from './preview-bindings'
import { BackgroundTasks, backgroundTaskCount } from './BackgroundTasks'
import { useMcpConnections } from './McpConnections'
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
        publishAccountQuotaReport(report)
        const matches = (report.cards ?? []).filter((card) => card.provider.trim().toLowerCase() === want)
        setSnap({ provider, state: 'ready', card: matches.find((card) => card.active) ?? matches.find((card) => card.active === undefined) ?? null })
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
  const authProviders = useStore((s) => s.authProviders)
  const account = useAccountQuotaCard(provider, !!provider && !live, runEnded)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!live) return undefined
    let alive = true
    void refreshLive(provider, runEnded > 0 || authProviders.length > 0).then(() => {
      if (alive) setNow(Date.now())
    })
    return () => {
      alive = false
    }
  }, [provider, live, runEnded, authProviders])

  useEffect(() => {
    const refreshIfDue = (gap: number): void => {
      if (!live || document.visibilityState !== 'visible') return
      const fetchedAt = useLiveQuota.getState().entries[provider]?.fetchedAt ?? 0
      if (Date.now() - fetchedAt >= gap) void refreshLive(provider)
    }
    const timer = setInterval(() => {
      setNow(Date.now())
      refreshIfDue(LIVE_QUOTA_MIN_GAP_MS)
    }, QUOTA_TICK_MS)
    const onFocus = (): void => refreshIfDue(LIVE_QUOTA_MIN_GAP_MS)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
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

const RAIL_LIST_LIMIT = 5

function glyphTone(tone: string | null | undefined): RailTone | undefined {
  return tone === 'ask' || tone === 'fail' ? tone : undefined
}

const CATEGORY_LABEL: Record<ContextCategory | 'free', MessageKey> = {
  system: 'ctx.cat.system',
  user: 'ctx.cat.user',
  assistant: 'ctx.cat.assistant',
  thinking: 'ctx.cat.thinking',
  tools: 'ctx.cat.tools',
  free: 'ctx.cat.free'
}

function scheduledRuns(runs: readonly RunSnapshot[]): RunSnapshot[] {
  return runs.filter((run) => run.kind === 'scheduled')
}

type RowMenuKey = 'reveal' | 'copyPath' | 'openFiles' | 'copyBranch' | 'openChanges'

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
  value?: ReactNode
  title: string
  menuLabel: string
  items: RowMenuItem[]
  onAction: (key: RowMenuKey) => void
  testId: string
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <RailRow
      label={label}
      title={title}
      icon={icon}
      value={value || undefined}
      onPress={() => setOpen(true)}
      buttonProps={{ ref: anchor, 'aria-haspopup': 'menu', 'aria-expanded': open, 'data-testid': testId }}
    >
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
    </RailRow>
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

function RailList<T>({
  items,
  text,
  testId,
  render
}: {
  items: readonly T[]
  text: RailText
  testId?: string
  render: (item: T) => ReactElement
}): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? items : items.slice(0, RAIL_LIST_LIMIT)
  const hiddenCount = items.length - RAIL_LIST_LIMIT
  return (
    <>
      <ul className="wb-ov-items" data-testid={testId}>
        {shown.map(render)}
      </ul>
      {hiddenCount > 0 ? (
        <Button variant="ghost" size="sm" className="wb-rail-more" aria-expanded={expanded} onPress={() => setExpanded((v) => !v)}>
          {expanded ? text.showLess : text.more(hiddenCount)}
        </Button>
      ) : null}
    </>
  )
}

function OutputRows({
  files,
  text,
  onOpen,
  onDismiss
}: {
  files: readonly RailOutput[]
  text: RailText
  onOpen: (path: string) => void
  onDismiss: (path: string) => void
}): ReactElement {
  return (
    <RailList
      items={files}
      text={text}
      testId="wb-rail-outputs"
      render={(file) => {
        const name = outputName(file.path)
        return (
          <RailRow
            key={file.path}
            label={name}
            title={file.path}
            icon={<FileTypeIcon name={name} size={16} />}
            value={outputFolder(file.path) || undefined}
            onPress={() => onOpen(file.path)}
            actionReveal="hover"
            action={
              <IconButton variant="plain" size="sm" aria-label={text.removeOutput(name)} tooltip={text.removeOutput(name)} className="wb-rail-dismiss" onPress={() => onDismiss(file.path)}>
                <X size={12} aria-hidden />
              </IconButton>
            }
          />
        )
      }}
    />
  )
}

function ChangedRows({ files, text, onOpen }: { files: readonly RailChangedFile[]; text: RailText; onOpen: () => void }): ReactElement {
  return (
    <RailList
      items={files}
      text={text}
      testId="wb-rail-changed-files"
      render={(file) => {
        const name = outputName(file.path)
        const counted = file.added !== null && file.removed !== null
        const unchangedLines = counted && file.added === 0 && file.removed === 0
        return (
          <RailRow
            key={file.path}
            label={name}
            title={counted ? `${file.path}\n${text.linesChanged(file.added ?? 0, file.removed ?? 0)}` : file.path}
            icon={<FileTypeIcon name={name} size={16} />}
            value={unchangedLines ? undefined : counted ? <RailValue glyph={{ kind: 'delta', added: file.added ?? 0, removed: file.removed ?? 0 }} /> : outputFolder(file.path) || undefined}
            onPress={onOpen}
          />
        )
      }}
    />
  )
}

function StatsGlance({ model, text }: { model: RailStatsModel; text: RailText }): ReactElement {
  const { glance } = model
  const metric = glance.metric
  return (
    <span className="wb-rail-glance" title={glance.title} data-testid="wb-rail-stats-glance">
      {glance.hit !== null ? (
        <RailValue className="wb-rail-hit" aria-label={text.cacheHit} value={<><span className="wb-rail-hit-label">{text.hitShort} </span>{glance.hitText}</>} />
      ) : null}
      {metric.kind === 'speed' ? (
        <RailValue
          joined={glance.hit !== null}
          value={metric.value}
          unit={metric.unit}
          digits={4}
          glyph={metric.bars ? { kind: 'bars', values: metric.bars, pending: metric.pending, slots: GLANCE_BARS + 1 } : undefined}
          glyphEnd
        />
      ) : metric.kind === 'tokens' ? (
        <RailValue joined={glance.hit !== null} value={metric.value} unit={metric.unit} digits={5} />
      ) : (
        <RailValue joined={glance.hit !== null} value={metric.text} />
      )}
    </span>
  )
}

export function OverviewPane({ owner, onOpenView }: OverviewPaneProps): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = useMemo(() => workbenchText(lang).overview, [lang])
  const rail = useMemo(() => railText(lang), [lang])

  const cwd = owner?.cwd || ''
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const settings = useStore((s) => s.settings)
  const messages = useStreamingThrottledStore((s) => s.messages)
  const subagents = useStore((s) => s.subagents)
  const runners = useStore((s) => s.runners)
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

  const gitMessageCount = useThrottledValue(messages.length, agentRunning, GIT_REFRESH_WHILE_RUNNING_MS)
  const gitRefresh = `${gitMessageCount}:${agentRunning ? 1 : 0}`
  const repo = useGitRepo(cwd || null, gitRefresh)
  const branch = repo ? (repo.detached ? text.detached : repo.branch || text.noBranch) : null
  const lineTotals = useGitLineTotals(cwd || null, !!repo && repo.changedCount > 0 && !isRailSectionHidden({ hidden }, 'changes'), gitRefresh)
  const changesSummary = !repo ? undefined : repo.changedCount === 0 ? (
    <RailValue value={rail.changesNone} />
  ) : lineTotals ? (
    <RailValue
      glyph={{ kind: 'delta', added: lineTotals.added, removed: lineTotals.removed }}
      title={rail.linesChanged(lineTotals.added, lineTotals.removed)}
      aria-label={rail.linesChanged(lineTotals.added, lineTotals.removed)}
    />
  ) : (
    <RailValue value={text.changesFiles(repo.changedCount)} />
  )
  const environmentSummary = cwd ? (
    <RailValue
      glyph={repo && repo.changedCount > 0 ? { kind: 'dot', status: 'awaiting' } : undefined}
      value={branch ? `${projectName} · ${branch}` : projectName}
      title={[cwd, branch ? `${text.branchLabel} ${branch}` : '', repo && repo.changedCount > 0 ? rail.dirty : ''].filter(Boolean).join('\n')}
    />
  ) : (
    <RailValue value={rail.local} />
  )

  const statsModel = useRailStats(!isRailSectionHidden({ hidden }, 'stats'))
  const contextOpen = isOpen('context')
  const autoCompactLimit = autoCompactLimitOf(session, settings)
  const contextData = useMemo(
    () => (!contextOpen ? null : contextPaneData({ session, stats, messages, autoCompactLimit })),
    [contextOpen, session, stats, messages, autoCompactLimit]
  )
  const usage = contextData?.usage ?? contextUsageSummary(session, stats, autoCompactLimit)
  const contextKnown = usage.known && usage.percent !== null
  const contextSummary = (
    <RailValue
      glyph={{ kind: 'ring', percent: contextKnown ? usage.percent : null, label: rail.sections.context }}
      tone={contextKnown ? glyphTone(usage.tone) : undefined}
      value={contextKnown ? `${Math.round(usage.percent ?? 0)}%` : '—'}
      digits={4}
    />
  )

  const outputPool = useMemo(() => outputCandidates(messages, cwd || undefined), [messages, cwd])
  const outputPaths = useMemo(() => outputPool.map((output) => output.path), [outputPool])
  const outputScreen = useOutputScreen(cwd || null, outputPaths, gitRefresh)
  const [dismissedOutputs, dismissOutput] = useDismissedOutputs(view.sessionId || view.key || '')
  const outputs = useMemo(() => visibleOutputs(outputPool, outputScreen, dismissedOutputs), [outputPool, outputScreen, dismissedOutputs])

  const scope = subagentScopeForView({ peekedSessionId, peekedPath, session, runners })
  const runs: SubagentRun[] = selectSubagentRuns(subagents, scope).all
  const allRuns = useRunsV3((s) => s.runs)
  const backgroundRuns = useMemo(() => scheduledRuns(allRuns), [allRuns])
  const stoppingIds = useSubagentStopping((s) => s.ids)
  const taskCount = backgroundTaskCount(runs, backgroundRuns, stoppingIds, Date.now())
  const taskTotal = taskCount.total
  const taskSummary =
    taskCount.running > 0 ? (
      <RailValue glyph={{ kind: 'dot', status: 'running' }} value={rail.tasksRunning(taskCount.running)} />
    ) : (
      <RailValue glyph={{ kind: 'dot', status: 'idle' }} value={rail.tasksEnded(taskTotal)} />
    )

  const extWidgets = Object.entries(widgets).filter(([, lines]) => lines.length > 0)

  const mcp = useMcpConnections(owner, agentRunning)

  const quota = useQuotaTile(provider, agentRunning, t, text)
  const quotaModel = quota.model
  const quotaStale = quotaModel ? quotaReadingStale(quotaModel.checkedAt, quota.now, !!quotaModel.staleError) : false
  const quotaWindows = quotaModel?.windows ?? []
  const binding = bindingQuotaWindow(quotaWindows.filter((w) => !windowAwaitingReset(w, quota.now))) ?? bindingQuotaWindow(quotaWindows)
  const bindingAwaiting = binding ? windowAwaitingReset(binding, quota.now) : false
  const bindingTone = binding ? quotaWindowTone(binding, quotaStale, quota.now) : null
  const bindingPct = binding && !bindingAwaiting ? windowUsedPct(binding) : null
  const quotaSummary = binding ? (
    <RailValue
      glyph={bindingTone === 'fail' ? { kind: 'dot', status: 'fail' } : bindingTone === 'ask' ? { kind: 'dot', status: 'awaiting' } : undefined}
      value={`${quotaShortLabel(t, binding)} ${bindingPct === null ? '—' : `${Math.round(bindingPct)}%`}`}
    />
  ) : quotaModel?.balance ? (
    <RailValue value={money(quotaModel.balance.amount, quotaModel.balance.currency)} />
  ) : quotaModel?.problem ? (
    quotaModel.problem.tone === 'ask' ? (
      <RailValue glyph={{ kind: 'dot', status: 'awaiting' }} value={text.quotaExpired} />
    ) : (
      <RailValue glyph={{ kind: 'dot', status: 'fail' }} value={text.quotaFailed} error />
    )
  ) : undefined

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
      case 'openChanges':
        onOpenView('changes')
    }
  }

  const sections: Partial<Record<RailSectionId, { summary?: ReactNode; onOpenView?: () => void; tone?: RailTone; body: ReactNode }>> = {
    environment: {
      summary: environmentSummary,
      body: (
        <ul className="wb-ov-items">
          <RailRow label={rail.local} icon={<Monitor size={14} aria-hidden />} data-testid="wb-rail-local" />
          {cwd ? (
            <RailRowMenu
              label={projectName}
              icon={<Folder size={14} aria-hidden />}
              value={cwd}
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
              value={repo && repo.changedCount > 0 ? <RailValue glyph={{ kind: 'dot', status: 'awaiting' }} value={rail.dirty} /> : undefined}
              title={[`${text.branchLabel} ${branch}`, repo && repo.changedCount > 0 ? rail.dirty : ''].filter(Boolean).join('\n')}
              menuLabel={rail.branchMenu}
              testId="wb-rail-branch"
              onAction={runRowAction}
              items={[
                ...(repo?.branch ? [{ key: 'copyBranch' as const, label: rail.copyBranch, icon: <Copy size={14} aria-hidden /> }] : []),
                { key: 'openChanges', label: rail.openChanges, icon: <FileDiff size={14} aria-hidden /> }
              ]}
            />
          ) : null}
        </ul>
      )
    },
    ...(statsModel
      ? {
          stats: {
            summary: isOpen('stats') ? (
              <RailValue value={statsModel.headline} title={statsModel.headlineTitle ?? undefined} />
            ) : (
              <StatsGlance model={statsModel} text={rail} />
            ),
            body: <RailStatsBody model={statsModel} breakdownLabel={rail.statsBreakdown} />
          }
        }
      : {}),
    context: {
      summary: !contextOpen || !contextData || !usage.known ? contextSummary : undefined,
      tone: contextKnown ? glyphTone(usage.tone) : undefined,
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
            tone: quotaModel.problem?.tone ?? glyphTone(bindingTone),
            onOpenView: () => onOpenView('quota'),
            body: <QuotaDetail model={quotaModel} now={quota.now} />
          }
        }
      : {}),
    ...(mcp.visible
      ? {
          connectors: {
            summary: mcp.summary,
            body: mcp.body
          }
        }
      : {}),
    ...(outputs.length > 0
      ? {
          outputs: {
            summary: <RailValue value={rail.outputFiles(outputs.length)} />,
            body: <OutputRows files={outputs} text={rail} onOpen={openOutput} onDismiss={dismissOutput} />
          }
        }
      : {}),
    ...(repo
      ? {
          changes: {
            summary: changesSummary,
            onOpenView: () => onOpenView('changes'),
            body:
              repo.changedCount === 0 ? (
                <p className="wb-ov-note">{rail.changesNone}</p>
              ) : lineTotals && lineTotals.entries.length > 0 ? (
                <ChangedRows files={lineTotals.entries} text={rail} onOpen={() => onOpenView('changes')} />
              ) : (
                <ul className="wb-ov-items">
                  {([
                    [text.changesStaged, repo.stagedCount],
                    [text.changesUnstaged, repo.unstagedCount],
                    [text.changesUntracked, repo.untrackedCount]
                  ] as const)
                    .filter(([, count]) => count > 0)
                    .map(([label, count]) => (
                      <RailRow key={label} label={label} icon={<FileDiff size={14} aria-hidden />} value={String(count)} />
                    ))}
                </ul>
              )
          }
        }
      : {}),
    ...(taskTotal > 0
      ? {
          backgroundTasks: {
            summary: taskSummary,
            body: <BackgroundTasks key={view.key} subagents={runs} scheduled={backgroundRuns} lang={lang} text={text} />
          }
        }
      : {}),
    ...(extWidgets.length > 0
      ? {
          extensions: {
            summary: <RailValue value={rail.extensionsCount(extWidgets.length)} />,
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
      <div className="wb-rail-list">
        {visible.map((id) => {
          const section = sections[id]
          if (!section) return null
          return (
            <RailCard
              key={id}
              id={id}
              title={rail.sections[id]}
              summary={section.summary}
              open={isOpen(id)}
              onOpenChange={(open) => setSectionOpen(foldKey, id, open)}
              onOpenView={section.onOpenView}
              openLabel={`${text.openFull} ${rail.sections[id]}`}
              tone={section.tone}
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
      </div>
      <RailSectionsMenu anchor={menuAnchor} open={menuOpen} onOpenChange={setMenuOpen} text={rail} />
    </div>
  )
}
