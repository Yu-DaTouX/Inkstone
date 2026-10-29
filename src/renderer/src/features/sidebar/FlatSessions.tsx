import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { Archive, Check, FolderOpen, FolderPlus, Link, ListFilter, MoreHorizontal, Plus, Replace, Search } from 'lucide-react'
import { useSessionDrag } from './session-drag'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { AsciiRule, Collapsible, CollapsibleHeader, Dialog, IconButton, ListRow, Menu, MenuItem, Modal, ModalOverlay, Popover, SearchField, TermSpinner } from '../../ui'
import { v3Text } from '../../app/v3-text'
import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import { FLAT_PAGE_SIZE, bucketByRecency, compactAgo, recencyBucket, sessionProjectLabel, isGlobalGroup, sessionActivityAt, sessionRowMeta, type FlatEntry, type RecencyBucket, type SidebarGroup } from './sidebar-model'
import type { ArchiveShelfRow } from './ArchiveShelf'
import { ProjectBadge } from './ProjectBadge'
import { ArchiveConfirm, ProjectDirectoryDialog, ProjectHeader, ensureProjectForCwd, setProjectArchived } from './ProjectHeader'
import { SidebarRow } from './SidebarRow'
import { sidebarText, type SidebarText } from './sidebar-text'

const SCOPE_KEY = 'inkstone.v3.sidebar.flatScope'

function readScope(): string | null {
  try {
    return localStorage.getItem(SCOPE_KEY) || null
  } catch {
    return null
  }
}

function writeScope(scope: string | null): void {
  try {
    if (scope) localStorage.setItem(SCOPE_KEY, scope)
    else localStorage.removeItem(SCOPE_KEY)
  } catch {
  }
}

export function useFlatScope(): [string | null, (scope: string | null) => void] {
  const [scope, setScope] = useState(readScope)
  return [
    scope,
    (next) => {
      writeScope(next)
      setScope(next)
    }
  ]
}

const branchCache = new Map<string, { at: number; branch: string | null }>()
const BRANCH_TTL_MS = 60_000

function useCwdBranches(cwds: readonly string[], now: number): ReadonlyMap<string, string | null> {
  const key = [...new Set(cwds.filter(Boolean))].sort().join('\n')
  const [branches, setBranches] = useState<ReadonlyMap<string, string | null>>(() => new Map())
  useEffect(() => {
    const git = window.yan?.git
    if (!git || !key) return undefined
    let alive = true
    const list = key.split('\n')
    void Promise.all(
      list.map(async (cwd) => {
        const hit = branchCache.get(cwd)
        if (hit && now - hit.at < BRANCH_TTL_MS) return [cwd, hit.branch] as const
        const branch = await git
          .state(cwd)
          .then((result) => result.repo?.branch ?? null)
          .catch(() => null)
        branchCache.set(cwd, { at: Date.now(), branch })
        return [cwd, branch] as const
      })
    ).then((pairs) => {
      if (alive) setBranches(new Map(pairs))
    })
    return () => {
      alive = false
    }
  }, [key, now])
  return branches
}

export function FlatToolbar({
  query,
  onQuery,
  filtering,
  onFiltering,
  tools
}: {
  query: string
  onQuery: (value: string) => void
  filtering: boolean
  onFiltering: (value: boolean) => void
  tools: ReactNode
}): JSX.Element {
  const { lang } = useI18n()
  const own = sidebarText(lang)
  const [hovering, setHovering] = useState(false)
  const hoverTimer = useRef(0)
  const expanded = filtering || !!query || hovering

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const collapse = (): void => {
    window.clearTimeout(hoverTimer.current)
    setHovering(false)
  }

  return (
    <div
      className="v3-side-tools"
      data-expanded={expanded ? '1' : undefined}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return
        collapse()
      }}
    >
      {expanded ? (
        <SearchField
          aria-label={own.filterSessions}
          placeholder={own.filterSessions}
          value={query}
          onChange={onQuery}
          autoFocus={filtering}
          onFocus={() => onFiltering(true)}
          onBlur={() => {
            if (!query) onFiltering(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !query) {
              onFiltering(false)
              collapse()
              ;(event.target as HTMLElement).blur()
            }
          }}
          data-testid="v3-search"
        />
      ) : (
        <>
          <span
            className="v3-side-search-hover"
            onPointerEnter={(event) => {
              if (event.pointerType !== 'mouse') return
              window.clearTimeout(hoverTimer.current)
              hoverTimer.current = window.setTimeout(() => setHovering(true), 180)
            }}
            onPointerLeave={() => window.clearTimeout(hoverTimer.current)}
          >
            <IconButton aria-label={own.filterSessions} onPress={() => onFiltering(true)} className="v3-side-search-btn" data-testid="v3-search-open">
              <Search size={18} />
            </IconButton>
          </span>
          <span className="v3-side-tools-gap" aria-hidden />
          {tools}
        </>
      )}
    </div>
  )
}

export function recencyLabel(own: SidebarText, bucket: RecencyBucket): string {
  return bucket === 'today' ? own.recencyToday : bucket === 'yesterday' ? own.recencyYesterday : bucket === 'week' ? own.recencyWeek : own.recencyOlder
}

export function RecencyRule({ label, count, bucket }: { label: string; count: number; bucket?: RecencyBucket }): JSX.Element {
  return (
    <AsciiRule
      className="v3-recency"
      tone={bucket === 'today' ? 'ink' : 'dim'}
      data-bucket={bucket}
      data-testid="v3-recency-rule"
      label={
        <>
          {label}
          <span className="v3-recency-count ui-num">{count}</span>
        </>
      }
    />
  )
}

export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

type ScopeAction = 'new' | 'reveal' | 'copy' | 'directory' | 'archive'

function ScopeRow({
  group,
  active,
  onSelect,
  onAction
}: {
  group: SidebarGroup
  active: boolean
  onSelect: () => void
  onAction: (action: ScopeAction) => void
}): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const own = sidebarText(lang)
  const text = v3Text(lang)
  const rowRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const name = group.label || text.projectFallback
  const manageable = !!group.cwd && !isGlobalGroup(group)
  return (
    <div ref={rowRef} className="v3-scope-row" data-menu={menuOpen ? '1' : undefined}>
      <ListRow
        className="v3-scope-pick"
        aria-pressed={active}
        icon={<ProjectBadge label={name} global={isGlobalGroup(group)} />}
        trailing={active ? <Check size={14} aria-hidden /> : null}
        onClick={onSelect}
        data-testid="v3-project-scope-item"
      >
        {name}
      </ListRow>
      {manageable ? (
        <>
          <IconButton size="xs" variant="ghost" className="v3-scope-more" aria-label={`${own.projectMenu} · ${name}`} onPress={() => setMenuOpen(true)} data-testid="v3-project-scope-more">
            <MoreHorizontal size={14} />
          </IconButton>
          <Popover triggerRef={rowRef} isOpen={menuOpen} onOpenChange={setMenuOpen} placement="end top" offset={4}>
            <Menu aria-label={own.projectMenu} autoFocus="first" onAction={(key) => onAction(key as ScopeAction)} onClose={() => setMenuOpen(false)} data-testid="v3-project-scope-actions">
              <MenuItem id="new" textValue={text.newInProject} icon={<Plus size={14} />}>
                {text.newInProject}
              </MenuItem>
              <MenuItem id="reveal" textValue={t('rail.reveal')} icon={<FolderOpen size={14} />}>
                {t('rail.reveal')}
              </MenuItem>
              <MenuItem id="copy" textValue={t('rail.copyPath')} icon={<Link size={14} />}>
                {t('rail.copyPath')}
              </MenuItem>
              <MenuItem id="directory" textValue={t('rail.changeDirectory')} icon={<Replace size={14} />}>
                {t('rail.changeDirectory')}
              </MenuItem>
              <MenuItem id="archive" textValue={t('rail.removeProject')} tone="danger" icon={<Archive size={14} />}>
                {t('rail.removeProject')}
              </MenuItem>
            </Menu>
          </Popover>
        </>
      ) : null}
    </div>
  )
}

export function ProjectScopeButton({
  groups,
  scope,
  onScope,
  onNew,
  onAddProject
}: {
  groups: readonly SidebarGroup[]
  scope: string | null
  onScope: (scope: string | null) => void
  onNew: (group: SidebarGroup, projectId: string) => void
  onAddProject: () => void
}): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const own = sidebarText(lang)
  const text = v3Text(lang)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<{ kind: 'directory' | 'archive'; group: SidebarGroup; record: ProjectRecord } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const current = groups.find((group) => group.key === scope)
  const label = current ? `${own.projectScope} · ${current.label || text.projectFallback}` : own.projectScope

  const pick = (next: string | null): void => {
    onScope(next)
    setOpen(false)
  }

  const run = async (group: SidebarGroup, action: ScopeAction): Promise<void> => {
    const notifyError = (message: string): void => useStore.getState().notify('error', message)
    if (action === 'reveal') {
      void window.yan.revealPath(group.cwd).catch((cause) => notifyError(cause instanceof Error ? cause.message : t('rail.projectError')))
      return
    }
    if (action === 'copy') {
      void navigator.clipboard.writeText(group.cwd).catch((cause) => notifyError(cause instanceof Error ? cause.message : t('rail.projectError')))
      return
    }
    const record = (group.projectId ? useStore.getState().settings?.projects.find((item) => item.id === group.projectId) : undefined) ?? (await ensureProjectForCwd(group.cwd))
    if (!record) {
      notifyError(own.registerFailed)
      return
    }
    setOpen(false)
    if (action === 'new') onNew(group, record.id)
    else setPending({ kind: action, group, record })
  }

  return (
    <>
      <IconButton
        ref={triggerRef}
        aria-label={label}
        tooltip={label}
        className="v3-scope-btn"
        data-active={current ? '1' : undefined}
        onPress={() => setOpen(true)}
        data-testid="v3-project-scope"
      >
        {current ? <ProjectBadge label={current.label || text.projectFallback} global={isGlobalGroup(current)} /> : <ListFilter size={18} />}
      </IconButton>
      <Popover triggerRef={triggerRef} isOpen={open} onOpenChange={setOpen} placement="bottom end" offset={4}>
        <div className="v3-scope-pop" role="group" aria-label={own.projectScope} data-testid="v3-project-scope-menu">
          <ListRow
            className="v3-scope-pick"
            aria-pressed={!current}
            icon={<ListFilter size={14} />}
            trailing={current ? null : <Check size={14} aria-hidden />}
            onClick={() => pick(null)}
            data-testid="v3-project-scope-all"
          >
            {own.allProjects}
          </ListRow>
          {groups.map((group) => (
            <ScopeRow key={group.key} group={group} active={group.key === scope} onSelect={() => pick(group.key)} onAction={(action) => void run(group, action)} />
          ))}
          <ListRow
            className="v3-scope-pick v3-scope-add"
            icon={<FolderPlus size={14} />}
            onClick={() => {
              setOpen(false)
              onAddProject()
            }}
            data-testid="v3-project-scope-add"
          >
            {own.newChatInFolder}
          </ListRow>
        </div>
      </Popover>
      {pending?.kind === 'directory' ? <ProjectDirectoryDialog project={pending.record} onClose={() => setPending(null)} /> : null}
      <ModalOverlay isDismissable isOpen={pending?.kind === 'archive'} onOpenChange={(isOpen) => { if (!isOpen) setPending(null) }}>
        <Modal>
          <Dialog title={t('rail.removeProjectTitle')} closeLabel={text.cancel} data-testid="v3-project-archive">
            {({ close }) => (
              <ArchiveConfirm
                name={pending?.group.label || text.projectFallback}
                onCancel={close}
                onConfirm={async () => {
                  const target = pending?.record
                  if (!target) return false
                  const ok = await setProjectArchived(target.id, true)
                  if (ok) {
                    if (pending?.group.key === scope) onScope(null)
                    close()
                  }
                  return ok
                }}
              />
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  )
}


const WORKING_EXIT_GRACE_MS = 8000
const WORKING_OPEN_KEY = 'inkstone.v3.sidebar.workingShelfOpen'

export function useWorkingSet(runningPaths: readonly string[]): ReadonlySet<string> {
  const key = [...runningPaths].sort().join('\n')
  const lastSeen = useRef(new Map<string, number>())
  const [, setTick] = useState(0)
  const now = Date.now()
  for (const path of runningPaths) lastSeen.current.set(path, now)
  const working = new Set<string>()
  let nextExpiry = Infinity
  for (const [path, at] of lastSeen.current) {
    const left = at + WORKING_EXIT_GRACE_MS - now
    if (runningPaths.includes(path) || left > 0) {
      working.add(path)
      if (!runningPaths.includes(path)) nextExpiry = Math.min(nextExpiry, left)
    } else lastSeen.current.delete(path)
  }
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return undefined
    const id = window.setTimeout(() => setTick((value) => value + 1), nextExpiry + 20)
    return () => window.clearTimeout(id)
  }, [key, nextExpiry])
  return working
}

function readShelfOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeShelfOpen(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? '1' : '0')
  } catch {
  }
}

export interface FlatCues {
  hints: ReadonlyMap<string, string>
  twins: ReadonlySet<string>
}

interface FlatRowProps {
  entry: FlatEntry
  row: ArchiveShelfRow
  now: number
  branch?: string | null
  cues: FlatCues
  scoped?: boolean
  onOpen: (item: SessionSummary) => void
}

function FlatRow({ entry, row, now, branch, cues, scoped, onOpen }: FlatRowProps): JSX.Element {
  const { lang } = useI18n()
  const text = v3Text(lang)
  const hint = cues.hints.get(entry.group.key)
  const twin = cues.twins.has(entry.session.id)
  const live = row.status === 'running' || row.status === 'awaiting'
  const card = useMemo(() => ({
    project: entry.group.label || text.projectFallback,
    cwd: entry.group.cwd,
    global: entry.session.scope === 'global',
    ago: compactAgo(sessionActivityAt(entry.session), now, lang),
    model: row.model,
    modelRef: row.modelRef,
    branch: branch ?? undefined,
    hint,
    toneKey: hint ? entry.group.cwd : undefined,
    hideProject: scoped
  }), [entry.group.label, entry.group.cwd, entry.session, row.model, row.modelRef, text.projectFallback, now, lang, branch, hint, scoped])
  const meta = useMemo(
    () => sessionRowMeta(entry.session, { now, lang, since: row.since, live, twin }),
    [entry.session, now, lang, row.since, live, twin]
  )
  return (
    <SidebarRow
      item={entry.session}
      title={row.title}
      isCurrent={row.isCurrent}
      status={row.status}
      code={row.code}
      card={card}
      meta={meta}
      onOpen={onOpen}
    />
  )
}

function ArchivedSlimRow({ row, onOpen, now }: { row: ArchiveShelfRow; onOpen: (item: SessionSummary) => void; now: number }): JSX.Element {
  const { lang } = useI18n()
  const text = v3Text(lang)
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const card = useMemo(() => {
    const owner = sessionProjectLabel(row.item, projects ?? [], projectNames ?? {})
    return {
      project: owner.label || text.projectFallback,
      cwd: owner.cwd,
      global: row.item.scope === 'global',
      ago: compactAgo(sessionActivityAt(row.item), now, lang),
      model: row.model,
      modelRef: row.modelRef,
      slim: true
    }
  }, [row.item, row.model, row.modelRef, projects, projectNames, text.projectFallback, now, lang])
  return <SidebarRow item={row.item} title={row.title} isCurrent={row.isCurrent} status={row.status} code={row.code} card={card} onOpen={onOpen} />
}

export function useArchivedSlimRow(onOpen: (item: SessionSummary) => void): (row: ArchiveShelfRow) => JSX.Element {
  const now = useMinuteClock()
  return (row) => <ArchivedSlimRow key={row.item.path} row={row} onOpen={onOpen} now={now} />
}

export const WORKING_SHELF_OPEN_EVENT = 'yan-v3-working-shelf-open'
export const FLAT_REVEAL_EVENT = 'yan-v3-flat-reveal'

export function WorkingShelf({
  entries,
  rowState,
  cues,
  onOpen
}: {
  entries: readonly FlatEntry[]
  rowState: (item: SessionSummary) => ArchiveShelfRow
  cues: FlatCues
  onOpen: (item: SessionSummary) => void
}): JSX.Element | null {
  const { lang } = useI18n()
  const own = sidebarText(lang)
  const now = useMinuteClock()
  const [open, setOpen] = useState(() => readShelfOpen(WORKING_OPEN_KEY))
  const shown = open ? entries : entries.filter((entry) => rowState(entry.session).isCurrent)
  const branches = useCwdBranches(shown.map((entry) => entry.session.cwd), now)
  useEffect(() => {
    const reveal = (): void => {
      writeShelfOpen(WORKING_OPEN_KEY, true)
      setOpen(true)
    }
    window.addEventListener(WORKING_SHELF_OPEN_EVENT, reveal)
    return () => window.removeEventListener(WORKING_SHELF_OPEN_EVENT, reveal)
  }, [])
  if (!entries.length) return null
  return (
    <section className="v3-shelf v3-shelf--working" data-open={open ? '1' : undefined} aria-label={own.workingShelf} data-testid="v3-working-shelf">
      <Collapsible
        className="v3-shelf-fold"
        isExpanded={open}
        onExpandedChange={(next) => {
          writeShelfOpen(WORKING_OPEN_KEY, next)
          setOpen(next)
        }}
      >
        <CollapsibleHeader chevron="end" tone="emphasized" icon={<TermSpinner />} accessory={<span className="ui-num">{entries.length}</span>} data-testid="v3-working-shelf-toggle">
          {own.workingShelf}
        </CollapsibleHeader>
        {shown.length ? (
          <div className="v3-shelf-list">
            {shown.map((entry) => (
              <FlatRow
                key={entry.session.path}
                entry={entry}
                row={rowState(entry.session)}
                now={now}
                branch={branches.get(entry.session.cwd)}
                cues={cues}
                onOpen={onOpen}
              />
            ))}
          </div>
        ) : null}
      </Collapsible>
    </section>
  )
}

export function FlatSessionList({
  scopeGroup,
  pinned,
  rows,
  onScope,
  projects,
  rowState,
  cues,
  onOpen,
  onNew
}: {
  scopeGroup?: SidebarGroup
  pinned: readonly FlatEntry[]
  rows: readonly FlatEntry[]
  onScope: (scope: string | null) => void
  projects: readonly ProjectRecord[]
  rowState: (item: SessionSummary) => ArchiveShelfRow
  cues: FlatCues
  onOpen: (item: SessionSummary) => void
  onNew: (group: SidebarGroup, projectId: string) => void
}): JSX.Element {
  const { lang } = useI18n()
  const own = sidebarText(lang)
  const text = v3Text(lang)
  const now = useMinuteClock()
  const [limit, setLimit] = useState(FLAT_PAGE_SIZE)
  const dragSource = useSessionDrag((s) => s.source)
  const dragging = !!dragSource?.startsWith('session:')
  const draggingPinned = dragging && pinned.some((entry) => dragSource === `session:${entry.session.path}`)

  useEffect(() => setLimit(FLAT_PAGE_SIZE), [scopeGroup?.key])

  useEffect(() => {
    const reveal = (event: Event): void => {
      const index = rows.findIndex((entry) => entry.session.path === (event as CustomEvent<string>).detail)
      if (index >= 0) setLimit((value) => Math.max(value, (Math.floor(index / FLAT_PAGE_SIZE) + 1) * FLAT_PAGE_SIZE))
    }
    window.addEventListener(FLAT_REVEAL_EVENT, reveal)
    return () => window.removeEventListener(FLAT_REVEAL_EVENT, reveal)
  }, [rows])

  const shown = rows.slice(0, limit)
  const current = rows.slice(limit).find((entry) => rowState(entry.session).isCurrent)
  if (current) shown.push(current)
  const hidden = Math.max(0, rows.length - limit)
  const branches = useCwdBranches([...pinned, ...shown].map((entry) => entry.session.cwd), now)
  const buckets = bucketByRecency(shown, (entry) => sessionActivityAt(entry.session), now)
  const bucketTotals = new Map<RecencyBucket, number>()
  for (const entry of rows) {
    const bucket = recencyBucket(sessionActivityAt(entry.session), now)
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + 1)
  }

  const render = (entry: FlatEntry): JSX.Element => (
    <FlatRow
      key={entry.session.path}
      entry={entry}
      row={rowState(entry.session)}
      now={now}
      branch={branches.get(entry.session.cwd)}
      cues={cues}
      scoped={!!scopeGroup}
      onOpen={onOpen}
    />
  )

  return (
    <div className="v3-flat" data-testid="v3-flat-list">
      {scopeGroup ? (
        <ProjectHeader
          group={scopeGroup}
          record={scopeGroup.projectId ? projects.find((project) => project.id === scopeGroup.projectId) : undefined}
          collapsed={false}
          onToggle={() => onScope(null)}
          onNew={(projectId) => onNew(scopeGroup, projectId)}
          clearLabel={own.clearScope}
        />
      ) : null}
      <div className="v3-pin-zone" data-pin-zone data-empty={pinned.length ? undefined : '1'} data-dragging={dragging && !draggingPinned ? '1' : undefined} data-testid="v3-pin-zone">
        {pinned.length ? <RecencyRule label={text.pinnedGroup} count={pinned.length} /> : null}
        {pinned.map(render)}
        {dragging && !draggingPinned ? <div className="v3-zone-drop" aria-hidden>{own.pinDrop}</div> : null}
      </div>
      <div className="v3-unpin-zone" data-unpin-zone data-dragging={draggingPinned ? '1' : undefined}>
        {draggingPinned ? <div className="v3-zone-drop" aria-hidden>{own.unpinDrop}</div> : null}
        {buckets.map((run) => (
          <Fragment key={run.bucket}>
            <RecencyRule label={recencyLabel(own, run.bucket)} count={bucketTotals.get(run.bucket) ?? run.entries.length} bucket={run.bucket} />
            {run.entries.map(render)}
          </Fragment>
        ))}
        {hidden > 0 ? (
          <ListRow className="v3-show-more" onClick={() => setLimit((value) => value + FLAT_PAGE_SIZE)} data-testid="v3-flat-more">
            {own.showMore.replace('{n}', String(Math.min(hidden, FLAT_PAGE_SIZE)))}
          </ListRow>
        ) : null}
      </div>
    </div>
  )
}
