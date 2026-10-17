import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder, GitBranch, ShieldCheck } from 'lucide-react'
import { Button, IconButton, Meter } from '../../ui'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useContextUsage } from '../../patterns/ContextRing'
import { normalizePermissionMode, type PermissionMode } from '../../../../shared/approval'
import { accountCardTitle, orderAccountCardsForProvider, type AccountQuotaCard } from '../../../../shared/account-quota'
import { windowPct } from '../../../../shared/quota-mini'
import type { GitRepoState } from '../../../../shared/git'
import type { CapabilityMcpServerSettingView } from '../../../../shared/ipc'
import { shortTokens } from './context-pane-view'
import { workbenchText } from './workbench-text'
import type { WorkbenchTabId, WorkspaceOwner } from './types'
import './workbench.css'

export interface OverviewPaneProps {
  owner: WorkspaceOwner | null
  onOpenView: (tab: WorkbenchTabId) => void
  onPreview?: (path: string) => void
}

type TileId = 'env' | 'context' | 'mcp' | 'changes' | 'quota'

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

  const cwd = owner?.cwd || ''
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const messages = useStore((s) => s.messages)
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
  const changesSummary = !repo ? undefined : repo.changedCount > 0 ? text.changesFiles(repo.changedCount) : text.changesNone

  const usage = useContextUsage()
  const contextSummary = usage.known && usage.percent !== null ? `${Math.round(usage.percent)}%` : undefined
  const contextTone = usage.tone !== 'ok' && usage.known ? usage.tone : undefined

  const mcp = useMcpServers(agentRunning ? 'running' : 'idle')
  const mcpReady = mcp.servers.filter((server) => server.status === 'ready').length
  const mcpSummary = mcp.state === 'ready' && mcp.servers.length > 0 ? text.mcpConnected(mcpReady, mcp.servers.length) : undefined
  const mcpTone = mcp.servers.some((server) => server.status === 'error') ? 'err' : mcp.servers.some((server) => server.status === 'needs-auth') ? 'warn' : undefined

  const quota = useQuotaSnapshot(provider)
  const primaryWindow = quota.card?.windows.find((w) => w.id === 'fiveHour' || w.id === 'primary') ?? quota.card?.windows[0]
  const primaryPct = primaryWindow ? windowPct(primaryWindow) : null
  const balance = quota.card?.balance
  const quotaSummary = primaryPct !== null ? `${primaryPct}%` : balance ? `${balance.amount.toFixed(2)} ${balance.currency}` : undefined

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

      {quota.card || quota.state === 'error' ? (
        <Tile
          id="quota"
          title={text.tiles.quota}
          summary={quotaSummary}
          folded={isFolded('quota')}
          onToggle={toggle}
          onOpen={() => onOpenView('quota')}
          openLabel={`${text.openFull} ${text.tiles.quota}`}
        >
          {quota.card && primaryWindow ? (
            <Meter
              aria-label={`${accountCardTitle(quota.card)} ${primaryWindow.label}`}
              className="wb-ov-meter"
              value={primaryPct ?? 0}
              minValue={0}
              maxValue={100}
              label={primaryWindow.label}
            />
          ) : quota.card && balance ? (
            <ul className="wb-ov-items">
              <li className="wb-ov-item">
                <span className="wb-ov-item-label">{balance.label}</span>
                <span className="wb-ov-item-value">{`${balance.amount.toFixed(2)} ${balance.currency}`}</span>
              </li>
            </ul>
          ) : (
            <p className="wb-ov-note">{text.quotaFailed}</p>
          )}
        </Tile>
      ) : null}
    </div>
  )
}
