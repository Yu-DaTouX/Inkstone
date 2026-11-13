import { memo, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Copy, FileDiff, Files, Folder, FolderOpen, GitBranch, Monitor, MoreHorizontal, X } from '../../ui/icons'
import { Badge, Button, Collapsible, CollapsibleHeader, CollapsiblePanel, IconButton, ListRow, ListRowStatic, Menu, MenuItem, MenuTrigger, Meter, Notice, Popover, RailRow, RailValue, Separator, TooltipText, type RailTone } from '../../ui'
import { BranchPicker } from '../changes/BranchPicker'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { useI18n, useT, type TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { useStreamingThrottledStore, useThrottledValue } from '../../state/streaming-throttle'
import { CONTEXT_USAGE_STATUS_KEY, parseContextSources, type ContextSourceItem } from '../../state/context-sources'
import { contextPartHint, contextPartLabel, type ContextRowId } from './context-parts'
import { LIVE_QUOTA_MIN_GAP_MS, LIVE_QUOTA_POLL_MS, liveQuotaSupported, publishAccountQuotaReport, refreshLiveQuota, useLiveQuota } from '../../state/live-quota'
import { viewSubagentRuns } from '../../state/subagent-view'
import { isLiveSubagentRun } from '../../../../shared/subagent-task-rows'
import { sessionViewIdentity } from '../session/view-state'
import { QuotaWindowRow, quotaReadAgo, quotaShortLabel, quotaWindowTone } from '../../patterns/QuotaWindowRow'
import type { AccountQuotaCard } from '../../../../shared/account-quota'
import { money } from '../../../../shared/quota-mini'
import { modelBrand } from '../../../../shared/model-brand'
import { deepseekPricePeriod } from '../../../../shared/deepseek-pricing'
import { bindingQuotaWindow, quotaReadingStale, windowAwaitingReset, windowUsedPct } from '../../../../shared/quota-forecast'
import type { GitRepoState } from '../../../../shared/git'
import { knownRepo, rememberRepo } from './repo-memory'
import { PROBE_TTL_MS } from '../../t3/adapters/availability'
import type { CompactionRun, ProviderQuota, QuotaWindow } from '../../../../shared/ipc'
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
  return (
    <RailRow
      label={branch}
      title={title}
      icon={<GitBranch size={14} aria-hidden />}
      value={
        repo && repo.changedCount > 0 ? (
          <RailValue glyph={{ kind: 'dirty' }} value={repo.changedCount} aria-label={rail.dirtyCount(repo.changedCount)} />
        ) : undefined
      }
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

function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || path
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

function ContextList({ id, label, items, onOpen, t }: { id: string; label: string; items: ContextSourceItem[]; onOpen?: (path: string) => void; t: TFunc }): ReactElement {
  return (
    <Collapsible className="wb-ov-ctx-list" data-testid={`wb-ov-ctx-list-${id}`}>
      <CollapsibleHeader size="compact" accessory={<span className="ui-num">{items.length}</span>}>{label}</CollapsibleHeader>
      <CollapsiblePanel>
        <ul className="wb-ov-ctx-items">
          {items.map((item) => {
            const trailing = `${item.deferred ? `${t('ctx.list.deferred')} ` : ''}${shortTokens(item.tokens)}`
            return (
              <li key={item.name}>
                {onOpen ? (
                  <ListRow title={item.name} aria-label={t('ctx.list.open', { path: item.name })} trailing={trailing} onClick={() => onOpen(item.name)}>
                    {shortPath(item.name)}
                  </ListRow>
                ) : (
                  <ListRowStatic title={item.name} trailing={trailing} muted={item.deferred}>
                    {item.name}
                  </ListRowStatic>
                )}
              </li>
            )
          })}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  )
}

function ContextDetail({ data, text, onOpenFile }: { data: ContextPaneData; last: CompactionRun | undefined; text: OverviewText; onOpenFile?: (path: string) => void }): ReactElement {
  const t = useT()
  const { usage, parts, compacted, sources } = data
  const share = (n: number): number => (usage.windowSize > 0 ? (n / usage.windowSize) * 100 : 0)
  const reserve = contextReserve(usage)
  const used = parts.filter((s) => s.tokens > 0)
  const rows: Array<{ id: ContextRowId; tokens: number; approx?: boolean }> = [
    ...used,
    ...(reserve.buffer ? [{ id: 'buffer' as const, tokens: reserve.buffer }] : []),
    { id: 'free' as const, tokens: reserve.free }
  ]
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
  const lists = sources
    ? [
        { id: 'mcp', label: t('ctx.cat.mcp'), items: sources.mcpTools },
        { id: 'memory', label: t('ctx.cat.memory'), items: sources.memoryFiles, onOpen: onOpenFile },
        { id: 'skills', label: t('ctx.cat.skills'), items: sources.skills }
      ].filter((list) => list.items.length > 0)
    : []
  const limitNote = usage.cappedByLimit
    ? t('ctx.limitNote', { model: shortTokens(usage.modelWindow), limit: shortTokens(usage.windowSize) })
    : ''
  return (
    <div className="wb-ov-ctx" data-testid="wb-ov-ctx">
      <div className="wb-ov-ctx-head" title={limitNote || undefined}>
        <span className="wb-ov-ctx-used">{`${text.contextUsed} ${usage.estimated ? '≈' : ''}${Math.round(usage.percent ?? share(usage.tokens))}%`}</span>
        <span className="wb-ov-ctx-total">{`${usage.estimated ? '≈' : ''}${shortTokens(usage.tokens)} / ${usage.windowAssumed ? '~' : ''}${shortTokens(usage.windowSize)}`}</span>
      </div>
      <div
        className="wb-ctx-bar"
        role="img"
        aria-label={t('ctx.tip', { used: `${usage.estimated ? '≈' : ''}${shortTokens(usage.tokens)}`, win: shortTokens(usage.windowSize), pct: Math.round(usage.percent ?? 0) })}
      >
        {used.map((s) => <i key={s.id} className={`wb-ctx-seg c-${s.id}`} style={{ width: `${share(s.tokens)}%` }} />)}
        {reserve.free > 0 ? <i className="wb-ctx-seg c-free" style={{ width: `${share(reserve.free)}%` }} /> : null}
        {reserve.buffer ? <i className="wb-ctx-seg c-buffer" style={{ width: `${share(reserve.buffer)}%` }} /> : null}
      </div>
      <ul className="wb-ctx-legend" data-testid="wb-ov-ctx-breakdown">
        {rows.map((row) => {
          const name = t(contextPartLabel(row.id, compacted))
          return (
            <li key={row.id} className={row.id === 'free' || row.id === 'buffer' ? 'free' : undefined} data-part={row.id}>
              <i className={`wb-ctx-swatch c-${row.id}`} aria-hidden />
              <ContextName label={name} hint={hintOf(row.id, row.approx)} />
              <span className="wb-ctx-legend-num">{`${row.approx ? '≈' : ''}${shortTokens(row.tokens)}`}</span>
              <span className="wb-ctx-legend-num">{`${share(row.tokens).toFixed(1)}%`}</span>
            </li>
          )
        })}
        {deferred.length ? <li className="wb-ov-ctx-sep" role="presentation"><Separator /></li> : null}
        {deferred.map((row) => (
          <li key={row.id} className="free" data-part={row.id}>
            <i className="wb-ctx-swatch c-deferred" aria-hidden />
            <ContextName label={row.label} hint={t('ctx.hint.deferred')} />
            <span className="wb-ctx-legend-num">{shortTokens(row.tokens)}</span>
            <span className="wb-ctx-legend-num">—</span>
          </li>
        ))}
      </ul>
      {lists.length ? (
        <div className="wb-ov-ctx-lists">
          {lists.map((list) => <ContextList key={list.id} id={list.id} label={list.label} items={list.items} onOpen={list.onOpen} t={t} />)}
        </div>
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

function ChangedRows({ files, text, onOpen }: { files: readonly RailChangedFile[]; text: RailText; onOpen: (path: string) => void }): ReactElement {
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
            icon={<FileTypeIcon name={name} size={16} mono />}
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
    <RailValue
      glyph={{ kind: 'delta', added: lineTotals.added, removed: lineTotals.removed }}
      title={rail.linesChanged(lineTotals.added, lineTotals.removed)}
      aria-label={rail.linesChanged(lineTotals.added, lineTotals.removed)}
    />
  ) : (
    <RailValue value={text.changesFiles(changesCount)} />
  )
  const environmentSummary = cwd ? (
    <RailValue
      glyph={repo && repo.changedCount > 0 ? { kind: 'dirty' } : undefined}
      value={branch ? `${projectName} · ${branch}` : projectName}
      title={[`${rail.local} · ${cwd}`, branch ? `${text.branchLabel} ${branch}` : '', repo && repo.changedCount > 0 ? rail.dirtyCount(repo.changedCount) : '', gitRead.status === 'error' ? rail.gitReadFailed : ''].filter(Boolean).join('\n')}
    />
  ) : (
    <RailValue value={rail.local} />
  )

  const statsModel = useRailStats(!isRailSectionHidden({ hidden }, 'stats'))
  const statsCostFact = statsModel?.facts.find((fact) => fact.key === 'cost')
  const statsCost = statsCostFact?.value ?? null
  const statsCostTitle = statsCostFact ? [`${statsCostFact.label} ${statsCostFact.value}`, statsCostFact.title].filter(Boolean).join('\n') : null
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
              title={[`${text.branchLabel} ${branch}`, repo && repo.changedCount > 0 ? `${rail.dirty} · ${rail.dirtyCount(repo.changedCount)}` : ''].filter(Boolean).join('\n')}
              rail={rail}
              onAction={runRowAction}
              onChanged={() => setGitTick((n) => n + 1)}
            />
          ) : gitRead.status === 'pending' || gitRead.status === 'error' ? (
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
            <span className="wb-rail-headline" data-testid="wb-rail-stats-headline" title={[statsModel.headline, statsModel.headlineTitle, statsCostTitle].filter(Boolean).join('\n')}>
              <RailValue value={statsModel.headline} />
              {statsCost ? <RailValue className="wb-rail-headline-cost" value={statsCost} joined /> : null}
            </span>
          ) : (
            <StatsGlance model={statsModel} text={rail} />
          ),
          summaryWhenOpen: true,
          body: <RailStatsBody model={statsModel} breakdownLabel={rail.statsBreakdown} running={agentRunning} />
        }
      : undefined,
    context: {
      summary: !contextOpen || !contextData || !usage.known ? contextSummary : undefined,
      tone: contextKnown ? glyphTone(usage.tone) : undefined,
      onOpenView: () => onOpenView('context'),
      body: contextData && usage.known ? (
        <ContextDetail data={contextData} last={session?.lastCompaction} text={text} onOpenFile={owner ? openOutput : undefined} />
      ) : (
        <Meter aria-label={rail.sections.context} className="wb-ov-meter" value={0} minValue={0} maxValue={100} />
      )
    },
    ...(quotaModel || peakPrice
      ? {
          usage: {
            summary: quotaSummary,
            tone: quotaModel?.problem?.tone ?? glyphTone(bindingTone),
            onOpenView: () => onOpenView('quota'),
            body: quotaModel ? <QuotaDetail model={quotaModel} now={quota.now} /> : null
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
