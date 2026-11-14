import { Fragment, memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { ChevronRight, Copy, FileDiff, Files, Folder, FolderGit2, FolderOpen, GitBranch, Monitor, MoreHorizontal, X } from '../../ui/icons'
import { Badge, Button, IconButton, Menu, MenuItem, MenuTrigger, Notice, Popover, RailRow, RailValue, Separator, TooltipText, type RailTone } from '../../ui'
import { BranchPicker } from '../changes/BranchPicker'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { useI18n, useT, type MessageKey, type TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { useStreamingThrottledStore, useThrottledValue } from '../../state/streaming-throttle'
import { CONTEXT_USAGE_STATUS_KEY, parseContextSources, scaledSourceItems, sourceItemLabel, type ContextSourceItem } from '../../state/context-sources'
import { contextPartHint, contextPartLabel, type ContextRowId } from './context-parts'
import { LIVE_QUOTA_MIN_GAP_MS, LIVE_QUOTA_POLL_MS, liveQuotaSupported, publishAccountQuotaReport, refreshLiveQuota, useLiveQuota } from '../../state/live-quota'
import { viewSubagentRuns } from '../../state/subagent-view'
import { isLiveSubagentRun } from '../../../../shared/subagent-task-rows'
import { sessionViewIdentity } from '../session/view-state'
import { quotaForecastLine, quotaPace, quotaReadAgo, quotaResetLine, quotaShortLabel, quotaWindowName, quotaWindowTone } from '../../patterns/QuotaWindowRow'
import type { AccountQuotaCard } from '../../../../shared/account-quota'
import { money } from '../../../../shared/quota-mini'
import { modelBrand } from '../../../../shared/model-brand'
import { deepseekPricePeriod } from '../../../../shared/deepseek-pricing'
import { bindingQuotaWindow, quotaReadingStale, windowAwaitingReset, windowUsedPct } from '../../../../shared/quota-forecast'
import type { GitRepoState } from '../../../../shared/git'
import { knownRepo, rememberRepo } from './repo-memory'
import { PROBE_TTL_MS } from '../../t3/adapters/availability'
import type { ProviderQuota, QuotaWindow } from '../../../../shared/ipc'
import { autoCompactLimitOf, contextPaneData, contextReserve, contextUsageSummary, shortTokens, type ContextPaneData } from './context-pane-view'
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
  sameNameHints,
  useDismissedOutputs,
  sessionLineTotals,
  useOutputScreen,
  useToolStructureMessages,
  visibleOutputs,
  type RailChangedFile,
  type RailOutput,
  outputName as lastSegment
} from './rail-data'
import { railText, type RailText } from './rail-text'
import { useRailReorder } from './use-rail-reorder'
import { showPreview } from './preview-bindings'
import { BackgroundTasks, useViewTerminalJobs } from './BackgroundTasks'
import { isLiveTerminalJob } from '../../../../shared/terminal-jobs'
import { useMcpConnections } from './McpConnections'
import './workbench.css'

export interface OverviewPaneProps {
  owner: WorkspaceOwner | null
  onOpenView: (tab: WorkbenchTabId) => void
  onPreview?: (path: string) => void
}

const QUOTA_TICK_MS = 30_000
const GIT_REFRESH_WHILE_RUNNING_MS = 4_000

type GitReadStatus = 'pending' | 'repo' | 'none' | 'error'

interface GitRead {
  repo: GitRepoState | null
  status: GitReadStatus
}

function initialGitRead(cwd: string | null): GitRead {
  if (!cwd) return { repo: null, status: 'none' }
  const known = knownRepo(cwd)
  return known === undefined ? { repo: null, status: 'pending' } : { repo: known, status: known ? 'repo' : 'none' }
}

function useGitRepo(cwd: string | null, refreshKey: string): GitRead {
  const [held, setHeld] = useState<{ cwd: string | null; read: GitRead }>(() => ({ cwd, read: initialGitRead(cwd) }))
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const git = window.yan?.git
    if (!cwd || !git) {
      setHeld({ cwd, read: { repo: null, status: 'none' } })
      return undefined
    }
    let alive = true
    const failed = (): void => {
      if (!alive) return
      setHeld((prev) => {
        const last = prev.cwd === cwd ? prev.read.repo : knownRepo(cwd) ?? null
        return { cwd, read: { repo: last, status: 'error' } }
      })
    }
    git
      .state(cwd)
      .then((st) => {
        if (st.error && !st.repo) return failed()
        rememberRepo(cwd, st.repo ?? null)
        if (alive) setHeld({ cwd, read: { repo: st.repo ?? null, status: st.repo ? 'repo' : 'none' } })
      })
      .catch(failed)
    return () => {
      alive = false
    }
  }, [cwd, refreshKey, retry])
  const read = held.cwd === cwd ? held.read : initialGitRead(cwd)
  const failing = read.status === 'error'
  useEffect(() => {
    if (!failing) return undefined
    const timer = window.setInterval(() => setRetry((n) => n + 1), PROBE_TTL_MS)
    return () => window.clearInterval(timer)
  }, [failing, cwd])
  return read
}

interface QuotaTileModel {
  windows: QuotaWindow[]
  balance?: { label: string; amount: number; currency: string }
  plan?: string
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

const accountSnapMemory = new Map<string, AccountCardSnapshot>()

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
        const next: AccountCardSnapshot = { provider, state: 'ready', card: matches.find((card) => card.active) ?? matches.find((card) => card.active === undefined) ?? null }
        accountSnapMemory.set(provider, next)
        setSnap(next)
      })
      .catch(() => {
        if (id !== seq.current) return
        setSnap((prev) => (prev?.provider === provider && prev.card ? prev : { provider, state: 'error', card: null }))
      })
  }, [provider, enabled, runEnded, poll])

  return snap?.provider === provider ? snap : accountSnapMemory.get(provider) ?? null
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
  return { windows: card.windows, balance: card.balance, plan: card.plan, checkedAt: card.checkedAt, staleError: card.staleError, problem }
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
    const onFocus = (): void => {
      setNow(Date.now())
      refreshIfDue(LIVE_QUOTA_MIN_GAP_MS)
    }
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

type RowMenuKey = 'reveal' | 'copyPath' | 'openFiles' | 'copyBranch' | 'openChanges'

interface RowMenuItem {
  key: RowMenuKey
  label: string
  icon: ReactNode
}

function RailRowMenu({
  label,
  truncate,
  icon,
  title,
  menuLabel,
  items,
  onAction,
  testId
}: {
  label: string
  truncate?: 'start'
  icon: ReactNode
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
      truncate={truncate}
      title={title}
      icon={icon}
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

function syncText(repo: GitRepoState | null, rail: RailText, t: TFunc): { text: string; title: string } | null {
  if (!repo || repo.detached || !repo.hasCommit) return null
  if (!repo.upstream) return { text: rail.localOnly, title: rail.localOnly }
  const title = [rail.upstream(repo.upstream), repo.ahead || repo.behind ? t('gitflow.aheadBehind', { ahead: repo.ahead, behind: repo.behind }) : rail.synced].join('\n')
  if (!repo.ahead && !repo.behind) return { text: rail.synced, title }
  return { text: [repo.ahead ? `↑${repo.ahead}` : '', repo.behind ? `↓${repo.behind}` : ''].filter(Boolean).join(' '), title }
}

function BranchRow({
  cwd,
  branch,
  repo,
  title,
  rail,
  onAction,
  onChanged
}: {
  cwd: string
  branch: string
  repo: GitRepoState | null
  title: string
  rail: RailText
  onAction: (key: RowMenuKey) => void
  onChanged: () => void
}): ReactElement {
  const t = useT()
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const sync = syncText(repo, rail, t)
  return (
    <RailRow
      label={branch}
      title={[title, sync?.title].filter(Boolean).join('\n')}
      icon={<GitBranch size={14} aria-hidden />}
      value={sync ? <RailValue value={sync.text} /> : undefined}
      onPress={() => setOpen(true)}
      buttonProps={{
        ref: anchor,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': t('gitflow.branch.trigger', { branch }),
        'data-testid': 'wb-rail-branch'
      }}
      actionReveal="hover"
      action={
        <MenuTrigger>
          <IconButton variant="plain" size="sm" aria-label={rail.branchMenu} tooltip={rail.branchMenu} data-testid="wb-rail-branch-menu">
            <MoreHorizontal size={14} aria-hidden />
          </IconButton>
          <Popover placement="bottom end" offset={4}>
            <Menu aria-label={rail.branchMenu} onAction={(key) => onAction(key as RowMenuKey)}>
              {repo?.branch ? (
                <MenuItem id="copyBranch" textValue={rail.copyBranch}>
                  <Copy size={14} aria-hidden />
                  {rail.copyBranch}
                </MenuItem>
              ) : null}
              <MenuItem id="openChanges" textValue={rail.openChanges}>
                <FileDiff size={14} aria-hidden />
                {rail.openChanges}
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
      }
    >
      <BranchPicker cwd={cwd} triggerRef={anchor} isOpen={open} onOpenChange={setOpen} onChanged={onChanged} />
    </RailRow>
  )
}

function ContextName({ label, hint }: { label: string; hint?: string }): ReactElement {
  return hint ? (
    <TooltipText className="wb-ctx-legend-name" tooltip={hint} tooltipPlacement="left" underline>
      {label}
    </TooltipText>
  ) : (
    <span className="wb-ctx-legend-name">{label}</span>
  )
}

const ITEMS_PREVIEW = 8

function ContextItems({ id, items, rail }: { id: string; items: ContextSourceItem[]; rail: RailText }): ReactElement {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, ITEMS_PREVIEW)
  return (
    <li className="wb-ov-ctx-items" data-testid={`wb-ov-ctx-items-${id}`}>
      <ul>
        {shown.map((item) => (
          <li key={item.name} title={item.name}>
            <span className="wb-ctx-legend-name">{sourceItemLabel(item.name, id)}</span>
            <span className="wb-ctx-legend-num">{shortTokens(item.tokens)}</span>
          </li>
        ))}
      </ul>
      {items.length > ITEMS_PREVIEW ? (
        <Button variant="plain" size="sm" className="wb-ov-ctx-more" aria-expanded={all} onPress={() => setAll((value) => !value)}>
          {all ? rail.showLess : rail.more(items.length - ITEMS_PREVIEW)}
        </Button>
      ) : null}
    </li>
  )
}

function ContextDetail({ data, rail }: { data: ContextPaneData; rail: RailText }): ReactElement {
  const t = useT()
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string): void => setOpenIds((current) => {
    const next = new Set(current)
    if (!next.delete(id)) next.add(id)
    return next
  })
  const expandable = (id: string, items: ContextSourceItem[]) => (items.length ? {
    role: 'button',
    tabIndex: 0,
    'aria-expanded': openIds.has(id),
    'data-open': openIds.has(id) ? '1' : undefined,
    onClick: () => toggle(id),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle(id)
    }
  } : {})
  const chevron = (items: ContextSourceItem[]) => (items.length ? <ChevronRight size={12} className="wb-ov-ctx-chevron" aria-hidden /> : null)
  const { usage, parts, compacted, sources } = data
  const share = (n: number): number => (usage.windowSize > 0 ? (n / usage.windowSize) * 100 : 0)
  const used = parts.filter((s) => s.tokens > 0)
  const reserve = contextReserve(usage)
  const rows: Array<{ id: ContextRowId; tokens: number; approx?: boolean }> = [
    ...used,
    ...(reserve.buffer ? [{ id: 'buffer' as const, tokens: reserve.buffer }] : []),
    { id: 'free' as const, tokens: reserve.free }
  ]
  const line = usage.compactAt !== null ? Math.min(usage.compactAt, usage.windowSize) : null
  const linePct = line !== null && usage.windowSize > 0 ? (line / usage.windowSize) * 100 : null
  const left = Math.max(0, (line ?? usage.windowSize) - usage.tokens)
  const room = line !== null && left === 0 ? rail.compactReached : `${line !== null ? rail.compactLeft : rail.windowLeft} ${shortTokens(left)}`
  const hintOf = (id: ContextRowId, approx?: boolean): string | undefined => {
    const key = id === 'free' ? (usage.compactAt !== null ? 'ctx.hint.free' : undefined) : contextPartHint(id)
    return [key ? t(key) : '', approx ? t('ctx.hint.approx') : ''].filter(Boolean).join(' · ') || undefined
  }
  const deferred = sources
    ? ([
        { id: 'deferredMcp', label: t('ctx.cat.deferredMcp'), tokens: sources.deferred.mcp },
        { id: 'deferredBuiltin', label: t('ctx.cat.deferredBuiltin'), tokens: sources.deferred.builtin }
      ] as const).filter((row) => row.tokens > 0)
    : []
  const limitNote = usage.cappedByLimit
    ? t('ctx.limitNote', { model: shortTokens(usage.modelWindow), limit: shortTokens(usage.windowSize) })
    : ''
  return (
    <div className="wb-ov-ctx" data-testid="wb-ov-ctx">
      <div className="wb-ov-ctx-meter">
        <div
          className="wb-ctx-bar"
          role="img"
          aria-label={[t('ctx.tip', { used: `${usage.estimated ? '≈' : ''}${shortTokens(usage.tokens)}`, win: shortTokens(usage.windowSize), pct: Math.round(usage.percent ?? 0) }), linePct !== null ? rail.compactAt(Math.round(linePct)) : ''].filter(Boolean).join('，')}
        >
          {used.map((s) => <i key={s.id} className={`wb-ctx-seg c-${s.id}`} style={{ width: `${share(s.tokens)}%` }} />)}
        </div>
        {linePct !== null && linePct < 100 ? (
          <span className="wb-ov-ctx-mark" style={{ left: `${linePct}%` }} title={rail.compactAt(Math.round(linePct))} aria-hidden="true" data-testid="wb-ov-ctx-mark" />
        ) : null}
      </div>
      <div className="wb-ov-ctx-head" title={limitNote || undefined}>
        <span className="wb-ov-ctx-total">{`${usage.estimated ? '≈' : ''}${shortTokens(usage.tokens)} / ${usage.windowAssumed ? '~' : ''}${shortTokens(usage.windowSize)}`}</span>
        <span className="wb-ov-ctx-room" data-tone={glyphTone(usage.tone)} data-testid="wb-ov-ctx-room">{room}</span>
      </div>
      <ul className="wb-ctx-legend" data-testid="wb-ov-ctx-breakdown">
        {rows.map((row) => {
          const items = scaledSourceItems(sources, row.id, row.tokens)
          return (
            <Fragment key={row.id}>
              <li className={row.id === 'free' || row.id === 'buffer' ? 'free' : undefined} data-part={row.id} {...expandable(row.id, items)}>
                <i className={`wb-ctx-swatch c-${row.id}`} aria-hidden />
                <span className="wb-ov-ctx-label">
                  <ContextName label={t(contextPartLabel(row.id, compacted))} hint={hintOf(row.id, row.approx)} />
                  {chevron(items)}
                </span>
                <span className="wb-ctx-legend-num">{`${row.approx ? '≈' : ''}${shortTokens(row.tokens)}`}</span>
                <span className="wb-ctx-legend-pct">{`${share(row.tokens).toFixed(1)}%`}</span>
              </li>
              {openIds.has(row.id) && items.length ? <ContextItems id={row.id} items={items} rail={rail} /> : null}
            </Fragment>
          )
        })}
        {deferred.length ? <li className="wb-ov-ctx-sep" role="presentation"><Separator /></li> : null}
        {deferred.map((row) => {
          const items = scaledSourceItems(sources, row.id, row.tokens)
          return (
            <Fragment key={row.id}>
              <li className="free" data-wide="1" data-part={row.id} {...expandable(row.id, items)}>
                <i className="wb-ctx-swatch c-deferred" aria-hidden />
                <span className="wb-ov-ctx-label">
                  <ContextName label={row.label} hint={t('ctx.hint.deferred')} />
                  {chevron(items)}
                </span>
                <span className="wb-ctx-legend-num">{shortTokens(row.tokens)}</span>
              </li>
              {openIds.has(row.id) && items.length ? <ContextItems id={row.id} items={items} rail={rail} /> : null}
            </Fragment>
          )
        })}
      </ul>
    </div>
  )
}

function RailBar({ label, used, tick, tickTitle }: { label: string; used: number; tick?: number | null; tickTitle?: string }): ReactElement {
  return (
    <div className="wb-ov-ctx-meter">
      <div className="wb-ctx-bar" role="img" aria-label={`${label} ${used}%`}>
        {used > 0 ? <i className="wb-ov-qfill" style={{ width: `${used}%` }} /> : null}
      </div>
      {tick != null ? <span className="wb-ov-ctx-mark" style={{ left: `${tick}%` }} title={tickTitle} aria-hidden="true" /> : null}
    </div>
  )
}

function QuotaMain({ window, stale, now, plan, rail }: { window: QuotaWindow; stale: boolean; now: number; plan?: string; rail: RailText }): ReactElement {
  const t = useT()
  const awaiting = windowAwaitingReset(window, now)
  const tone = quotaWindowTone(window, stale, now)
  const used = Math.round(Math.min(100, Math.max(0, windowUsedPct(window) ?? 0)))
  const pace = stale || awaiting ? null : quotaPace(window, now)
  const reset = quotaResetLine(t, window, now)
  const forecast = stale || awaiting ? null : quotaForecastLine(t, window, now)
  const exhaust = forecast?.kind === 'exhaust' ? forecast : null
  const steady = forecast?.kind === 'steady' ? forecast : null
  const elapsedPct = pace ? Math.min(99, Math.max(1, 100 - pace.timeLeftPct)) : null
  const paceTitle = pace ? [rail.quotaTimeLeft(pace.timeLeftPct), steady?.text ?? '', t('quota.paceTip')].filter(Boolean).join('\n') : undefined
  return (
    <div className="wb-ov-qmain" data-tone={tone} data-testid={`wb-ov-quota-win-${window.id}`}>
      <div className="wb-ov-ctx-head">
        <span className="wb-ov-qmain-name">
          <span className="wb-ov-qmain-label">{quotaWindowName(t, window)}</span>
          {plan ? <Badge className="wb-ov-qmain-plan">{plan.charAt(0).toUpperCase() + plan.slice(1)}</Badge> : null}
        </span>
        {!awaiting && reset.text ? (
          <span className="wb-ov-qmain-side" title={reset.tip || undefined}>
            {reset.text}
          </span>
        ) : null}
      </div>
      <RailBar label={window.label} used={awaiting ? 0 : used} tick={elapsedPct} tickTitle={paceTitle} />
      <div className="wb-ov-ctx-head">
        <span className="wb-ov-qmain-used">{awaiting ? t('quota.resetDue') : `${used}% ${rail.quotaUsed}`}</span>
        {exhaust ? (
          <span className="wb-ov-qmain-side" data-kind="exhaust" title={exhaust.tip || undefined} data-testid={`wb-ov-quota-win-${window.id}-forecast`}>
            {exhaust.text}
          </span>
        ) : pace ? (
          <span className="wb-ov-qmain-side" data-pace={pace.pace} title={paceTitle}>
            {t(`quota.pace.${pace.pace}` as MessageKey)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function QuotaMini({ window, stale, now }: { window: QuotaWindow; stale: boolean; now: number }): ReactElement {
  const t = useT()
  const awaiting = windowAwaitingReset(window, now)
  const tone = quotaWindowTone(window, stale, now)
  const used = Math.round(Math.min(100, Math.max(0, windowUsedPct(window) ?? 0)))
  const reset = quotaResetLine(t, window, now)
  return (
    <li className="wb-ov-qmini" data-tone={tone} title={[window.label, reset.text, reset.tip].filter(Boolean).join('\n')} data-testid={`wb-ov-quota-win-${window.id}`}>
      <span className="wb-ov-qmini-name">{quotaWindowName(t, window)}</span>
      <RailBar label={window.label} used={awaiting ? 0 : used} />
      <span className="wb-ov-qmini-num">{awaiting ? t('quota.resetDue') : `${used}%`}</span>
    </li>
  )
}

function QuotaDetail({ model, now, mainId, rail }: { model: QuotaTileModel; now: number; mainId: string | null; rail: RailText }): ReactElement {
  const t = useT()
  const stale = quotaReadingStale(model.checkedAt, now, !!model.staleError)
  const hasData = model.windows.length > 0 || !!model.balance
  const main = model.windows.find((window) => window.id === mainId) ?? model.windows[0] ?? null
  const others = model.windows.filter((window) => window !== main)
  return (
    <div className="wb-ov-quota" data-testid="wb-ov-quota">
      {main ? <QuotaMain window={main} stale={stale} now={now} plan={model.plan} rail={rail} /> : null}
      {others.length ? <ul className="wb-ov-qminis">{others.map((window) => <QuotaMini key={window.id} window={window} stale={stale} now={now} />)}</ul> : null}
      {model.balance ? (
        <div className="wb-ov-qbalance" data-tone={stale ? 'stale' : 'ok'} data-testid="wb-ov-quota-balance">
          <span className="wb-ov-qmini-name">{model.balance.label}</span>
          <span className="wb-ov-qmini-num">{money(model.balance.amount, model.balance.currency)}</span>
        </div>
      ) : null}
      {stale && hasData ? (
        <p className="wb-quota-stale" title={t('quota.staleTip')} data-testid="wb-ov-quota-stale">
          {[quotaReadAgo(t, model.checkedAt, now), model.staleError ? t('quota.readFailed', { msg: model.staleError }) : ''].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {model.problem ? <Notice tone={model.problem.tone} compact>{model.problem.text}</Notice> : null}
    </div>
  )
}

function RailList<T>({
  items,
  text,
  testId,
  bare,
  render
}: {
  items: readonly T[]
  text: RailText
  testId?: string
  bare?: boolean
  render: (item: T) => ReactElement
}): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? items : items.slice(0, RAIL_LIST_LIMIT)
  const hiddenCount = items.length - RAIL_LIST_LIMIT
  return (
    <>
      <ul className="wb-ov-items" data-testid={testId} data-bare={bare ? '1' : undefined}>
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

function ChangedRows({ files, text, onOpen }: { files: readonly RailChangedFile[]; text: RailText; onOpen: (path: string) => void }): ReactElement {
  const hints = useMemo(() => sameNameHints(files.map((file) => file.path)), [files])
  return (
    <RailList
      items={files}
      text={text}
      testId="wb-rail-changed-files"
      bare
      render={(file) => {
        const name = outputName(file.path)
        const counted = file.added !== null && file.removed !== null
        const unchangedLines = counted && file.added === 0 && file.removed === 0
        return (
          <RailRow
            key={file.path}
            label={name}
            hint={hints.get(file.path)}
            title={counted ? `${file.path}\n${text.linesChanged(file.added ?? 0, file.removed ?? 0)}` : file.path}
            value={unchangedLines ? undefined : counted ? <RailValue glyph={{ kind: 'delta', added: file.added ?? 0, removed: file.removed ?? 0, quiet: true }} /> : outputFolder(file.path) || undefined}
            onPress={() => onOpen(file.path)}
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

function sameOwner(left: WorkspaceOwner | null, right: WorkspaceOwner | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.key === right.key && left.sessionId === right.sessionId && left.sessionFile === right.sessionFile && left.cwd === right.cwd && left.runId === right.runId && left.generation === right.generation && left.active === right.active
}

export const OverviewPane = memo(function OverviewPane({ owner, onOpenView }: OverviewPaneProps): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = useMemo(() => workbenchText(lang).overview, [lang])
  const rail = useMemo(() => railText(lang), [lang])

  const cwd = owner?.cwd || ''
  const session = useStore((s) => s.session)
  const stats = useStore((s) => s.stats)
  const settings = useStore((s) => s.settings)
  const messages = useStreamingThrottledStore((s) => s.messages)
  const childTasks = useStore((s) => viewSubagentRuns(s).length)
  const childTasksLive = useStore((s) => viewSubagentRuns(s).filter(isLiveSubagentRun).length)
  const terminalJobs = useViewTerminalJobs()
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
  const [gitTick, setGitTick] = useState(0)
  const gitRefresh = `${gitMessageCount}:${agentRunning ? 1 : 0}:${gitTick}:${owner?.runId ?? ''}:${owner?.active ? 1 : 0}`
  const gitRead = useGitRepo(cwd || null, gitRefresh)
  const repo = gitRead.repo
  const toolMessages = useToolStructureMessages(messages)
  const sessionChanges = useMemo(() => sessionLineTotals(toolMessages, cwd || undefined), [toolMessages, cwd])
  const changesCount = sessionChanges.files
  const lineTotals = sessionChanges
  const branch = repo ? (repo.detached ? text.detached : repo.branch || text.noBranch) : null
  const changesSummary = !repo ? undefined : changesCount === 0 ? (
    <RailValue value={rail.changesNone} />
  ) : lineTotals.added >= 0 && lineTotals.removed >= 0 ? (
    <span className="wb-rail-headline" data-testid="wb-rail-changes-total" title={`${text.changesFiles(changesCount)}\n${rail.linesChanged(lineTotals.added, lineTotals.removed)}`}>
      <RailValue
        glyph={{ kind: 'delta', added: lineTotals.added, removed: lineTotals.removed }}
        aria-label={rail.linesChanged(lineTotals.added, lineTotals.removed)}
      />
    </span>
  ) : (
    <RailValue value={text.changesFiles(changesCount)} />
  )
  const dirtyCount = repo?.changedCount ?? 0
  const worktree = !!repo && repo.repoId !== repo.worktreeId
  const environmentSummary = cwd ? (
    <span
      className="wb-env-sum"
      data-testid="wb-rail-env-summary"
      title={[`${rail.local} · ${cwd}`, branch ? `${text.branchLabel} ${branch}` : '', dirtyCount > 0 ? rail.uncommittedFiles(dirtyCount) : '', gitRead.status === 'error' ? rail.gitReadFailed : ''].filter(Boolean).join('\n')}
    >
      {branch ? <GitBranch size={12} aria-hidden className="wb-env-sum-icon" /> : null}
      <span className="wb-env-sum-name">{branch ?? projectName}</span>
      {dirtyCount > 0 ? (
        <Badge tone="ask" className="wb-env-dirty">
          {rail.uncommitted(dirtyCount)}
        </Badge>
      ) : null}
    </span>
  ) : (
    <RailValue value={rail.local} />
  )

  const statsModel = useRailStats(!isRailSectionHidden({ hidden }, 'stats'))
  const contextOpen = isOpen('context')
  const autoCompactLimit = autoCompactLimitOf(session, settings)
  const sourcesText = useStore((s) => (contextOpen ? s.statuses[CONTEXT_USAGE_STATUS_KEY] : undefined))
  const contextData = useMemo(
    () => (!contextOpen ? null : contextPaneData({ session, stats, messages, autoCompactLimit, sources: parseContextSources(sourcesText) })),
    [contextOpen, session, stats, messages, autoCompactLimit, sourcesText]
  )
  const usage = contextData?.usage ?? contextUsageSummary(session, stats, autoCompactLimit)
  const contextKnown = usage.known && usage.percent !== null
  const contextSummary = (
    <RailValue
      glyph={{ kind: 'ring', percent: contextKnown ? usage.percent : null, label: rail.sections.context }}
      tone={contextKnown ? glyphTone(usage.tone) : undefined}
      value={contextKnown ? `${usage.estimated ? '≈' : ''}${Math.round(usage.percent ?? 0)}%` : '—'}
      digits={usage.estimated ? 5 : 4}
    />
  )

  const outputPool = useMemo(() => outputCandidates(toolMessages, cwd || undefined), [toolMessages, cwd])
  const outputPaths = useMemo(() => outputPool.map((output) => output.path), [outputPool])
  const outputScreen = useOutputScreen(cwd || null, outputPaths, gitRefresh)
  const [dismissedOutputs, dismissOutput] = useDismissedOutputs(view.sessionId || view.key || '')
  const outputs = useMemo(() => visibleOutputs(outputPool, outputScreen, dismissedOutputs), [outputPool, outputScreen, dismissedOutputs])

  const taskCount = { running: childTasksLive + terminalJobs.filter(isLiveTerminalJob).length, total: childTasks + terminalJobs.length }
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
  const deepseek = modelBrand({ id: session?.model?.id }) === 'deepseek' || modelBrand(session?.model) === 'deepseek'
  const peakPrice = deepseek && deepseekPricePeriod(quota.now) === 'peak'
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
      value={`${quotaShortLabel(t, binding)} ${bindingPct === null ? '—' : t('quota.usedInline', { pct: Math.round(Math.min(100, Math.max(0, bindingPct))) })}`}
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

  const sections: Partial<Record<RailSectionId, { summary?: ReactNode; summaryWhenOpen?: boolean; onOpenView?: () => void; tone?: RailTone; body: ReactNode }>> = {
    environment: {
      summary: environmentSummary,
      body: cwd ? (
        <ul className="wb-ov-items">
          <RailRowMenu
            label={cwd}
            truncate="start"
            icon={<Folder size={14} aria-hidden />}
            title={`${rail.local} · ${cwd}`}
            menuLabel={rail.folderMenu}
            testId="wb-ov-path"
            onAction={runRowAction}
            items={[
              { key: 'reveal', label: rail.reveal, icon: <FolderOpen size={14} aria-hidden /> },
              { key: 'copyPath', label: rail.copyPath, icon: <Copy size={14} aria-hidden /> },
              { key: 'openFiles', label: rail.openFiles, icon: <Files size={14} aria-hidden /> }
            ]}
          />
          {branch ? (
            <BranchRow
              cwd={cwd}
              branch={branch}
              repo={repo}
              title={`${text.branchLabel} ${branch}`}
              rail={rail}
              onAction={runRowAction}
              onChanged={() => setGitTick((n) => n + 1)}
            />
          ) : null}
          {repo && dirtyCount > 0 ? (
            <RailRow
              label={rail.uncommittedFiles(dirtyCount)}
              title={[
                rail.uncommittedFiles(dirtyCount),
                repo.stagedCount ? `${text.changesStaged} ${repo.stagedCount}` : '',
                repo.unstagedCount ? `${text.changesUnstaged} ${repo.unstagedCount}` : '',
                repo.untrackedCount ? `${text.changesUntracked} ${repo.untrackedCount}` : ''
              ].filter(Boolean).join('\n')}
              icon={<FileDiff size={14} aria-hidden />}
              value={repo.stagedCount > 0 ? rail.staged(repo.stagedCount) : undefined}
              onPress={() => onOpenView('changes')}
              data-testid="wb-rail-uncommitted"
            />
          ) : null}
          {repo && worktree ? (
            <RailRow label={rail.worktree} title={`${rail.worktreeTip}\n${repo.root}`} icon={<FolderGit2 size={14} aria-hidden />} data-testid="wb-rail-worktree" />
          ) : null}
          {!branch && (gitRead.status === 'pending' || gitRead.status === 'error') ? (
            <RailRow
              label={gitRead.status === 'error' ? rail.branchUnknown : '—'}
              title={gitRead.status === 'error' ? rail.gitReadFailed : undefined}
              icon={<GitBranch size={14} aria-hidden />}
              className="wb-ov-branch-pending"
              data-testid="wb-rail-branch-pending"
            />
          ) : null}
        </ul>
      ) : (
        <ul className="wb-ov-items">
          <RailRow label={rail.local} icon={<Monitor size={14} aria-hidden />} data-testid="wb-rail-local" />
        </ul>
      )
    },
    stats: statsModel || agentRunning
      ? {
          summary: !statsModel ? (
            <RailValue value="—" />
          ) : isOpen('stats') ? (
            <span className="wb-rail-headline" data-testid="wb-rail-stats-headline" title={[statsModel.headline, statsModel.headlineTitle].filter(Boolean).join('\n')}>
              <RailValue value={statsModel.headline} />
            </span>
          ) : (
            <StatsGlance model={statsModel} text={rail} />
          ),
          summaryWhenOpen: true,
          body: <RailStatsBody model={statsModel} running={agentRunning} />
        }
      : undefined,
    context: {
      summary: contextOpen && contextData && usage.known ? (
        <RailValue tone={contextKnown ? glyphTone(usage.tone) : undefined} value={contextKnown ? `${usage.estimated ? '≈' : ''}${Math.round(usage.percent ?? 0)}%` : '—'} />
      ) : contextSummary,
      summaryWhenOpen: true,
      tone: contextKnown ? glyphTone(usage.tone) : undefined,
      onOpenView: () => onOpenView('context'),
      body: contextData && usage.known ? (
        <ContextDetail data={contextData} rail={rail} />
      ) : (
        <div className="wb-ov-ctx"><RailBar label={rail.sections.context} used={0} /></div>
      )
    },
    ...(quotaModel || peakPrice
      ? {
          usage: {
            summary: quotaSummary,
            tone: quotaModel?.problem?.tone ?? glyphTone(bindingTone),
            onOpenView: () => onOpenView('quota'),
            body: quotaModel ? <QuotaDetail model={quotaModel} now={quota.now} mainId={binding?.id ?? null} rail={rail} /> : null
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
            summaryWhenOpen: true,
            body:
              changesCount === 0 ? null : lineTotals && lineTotals.entries.length > 0 ? (
                <ChangedRows files={lineTotals.entries} text={rail} onOpen={(path) => openOutput(/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path) || !cwd ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`)} />
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
            body: <BackgroundTasks key={view.key} lang={lang} text={text} />
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
  const emptySections = new Set(order.filter((id) => !sections[id]))
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
              badge={id === 'usage' && peakPrice ? (
                <Badge tone="ask" className="wb-tile-badge" title={rail.peakTip} data-testid="wb-rail-usage-peak">
                  {t('quota.price.peak')}
                </Badge>
              ) : undefined}
              summary={section.summary}
              summaryWhenOpen={section.summaryWhenOpen}
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
      <RailSectionsMenu anchor={menuAnchor} open={menuOpen} onOpenChange={setMenuOpen} text={rail} empty={emptySections} />
    </div>
  )
}, (left, right) => sameOwner(left.owner, right.owner) && left.onOpenView === right.onOpenView && left.onPreview === right.onPreview)
