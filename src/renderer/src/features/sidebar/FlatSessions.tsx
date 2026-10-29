import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { Archive, Check, ChevronRight, FolderOpen, FolderPlus, Link, ListFilter, MoreHorizontal, Plus, Replace, Search } from 'lucide-react'
import { useSessionDrag } from './session-drag'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Dialog, IconButton, Menu, MenuItem, Modal, ModalOverlay, Popover, SearchField } from '../../ui'
import { IconTip } from '../../app/IconTip'
import { v3Text } from '../../app/v3-text'
import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import { FLAT_PAGE_SIZE, compactAgo, sessionProjectLabel, isGlobalGroup, sessionActivityAt, type FlatEntry, type SidebarGroup } from './sidebar-model'
import type { ArchiveShelfRow } from './ArchiveShelf'
import { ProjectBadge } from './ProjectBadge'
import { ArchiveConfirm, ProjectDirectoryDialog, ProjectHeader, ensureProjectForCwd, setProjectArchived } from './ProjectHeader'
import { SidebarRow } from './SidebarRow'
import { sidebarText } from './sidebar-text'

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

function useMinuteClock(): number {
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
      <button type="button" className="ui-row v3-scope-pick" aria-pressed={active} onClick={onSelect} data-testid="v3-project-scope-item">
        <ProjectBadge label={name} global={isGlobalGroup(group)} />
        <span className="v3-scope-item">{name}</span>
        {active ? <Check size={14} aria-hidden /> : null}
      </button>
      {manageable ? (
        <>
          <IconButton size="sm" variant="ghost" className="v3-scope-more" aria-label={`${own.projectMenu} · ${name}`} onPress={() => setMenuOpen(true)} data-testid="v3-project-scope-more">
            <MoreHorizontal size={14} />
          </IconButton>
          <Popover triggerRef={rowRef} isOpen={menuOpen} onOpenChange={setMenuOpen} placement="end top" offset={4}>
            <Menu aria-label={own.projectMenu} autoFocus="first" onAction={(key) => onAction(key as ScopeAction)} onClose={() => setMenuOpen(false)} data-testid="v3-project-scope-actions">
              <MenuItem id="new" textValue={text.newInProject}>
                <Plus size={14} aria-hidden />
                {text.newInProject}
              </MenuItem>
              <MenuItem id="reveal" textValue={t('rail.reveal')}>
                <FolderOpen size={14} aria-hidden />
                {t('rail.reveal')}
              </MenuItem>
              <MenuItem id="copy" textValue={t('rail.copyPath')}>
                <Link size={14} aria-hidden />
                {t('rail.copyPath')}
              </MenuItem>
              <MenuItem id="directory" textValue={t('rail.changeDirectory')}>
                <Replace size={14} aria-hidden />
                {t('rail.changeDirectory')}
              </MenuItem>
              <MenuItem id="archive" textValue={t('rail.removeProject')} className="v3-menu-danger">
                <Archive size={14} aria-hidden />
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
      <IconTip label={label}>
        <IconButton
          ref={triggerRef}
          aria-label={label}
          className="v3-scope-btn"
          data-active={current ? '1' : undefined}
          onPress={() => setOpen(true)}
          data-testid="v3-project-scope"
        >
          {current ? <ProjectBadge label={current.label || text.projectFallback} global={isGlobalGroup(current)} /> : <ListFilter size={18} />}
        </IconButton>
      </IconTip>
      <Popover triggerRef={triggerRef} isOpen={open} onOpenChange={setOpen} placement="bottom end" offset={4}>
        <div className="v3-scope-pop" role="group" aria-label={own.projectScope} data-testid="v3-project-scope-menu">
          <button type="button" className="ui-row v3-scope-pick" aria-pressed={!current} onClick={() => pick(null)} data-testid="v3-project-scope-all">
            <ListFilter size={14} aria-hidden />
            <span className="v3-scope-item">{own.allProjects}</span>
            {current ? null : <Check size={14} aria-hidden />}
          </button>
          {groups.map((group) => (
            <ScopeRow key={group.key} group={group} active={group.key === scope} onSelect={() => pick(group.key)} onAction={(action) => void run(group, action)} />
          ))}
          <button
            type="button"
            className="ui-row v3-scope-pick v3-scope-add"
            onClick={() => {
              setOpen(false)
              onAddProject()
            }}
            data-testid="v3-project-scope-add"
          >
            <FolderPlus size={14} aria-hidden />
            <span className="v3-scope-item">{own.newChatInFolder}</span>
          </button>
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

interface FlatRowProps {
  entry: FlatEntry
  row: ArchiveShelfRow
  now: number
  branch?: string | null
  slim?: boolean
  onOpen: () => void
}

function FlatRow({ entry, row, now, branch, slim, onOpen }: FlatRowProps): JSX.Element {
  const { lang } = useI18n()
  const text = v3Text(lang)
  return (
    <SidebarRow
      item={entry.session}
      title={row.title}
      isCurrent={row.isCurrent}
      status={row.status}
      code={row.code}
      card={{
        project: entry.group.label || text.projectFallback,
        cwd: entry.group.cwd,
        global: entry.session.scope === 'global',
        ago: compactAgo(sessionActivityAt(entry.session), now, lang),
        model: row.model,
        modelRef: row.modelRef,
        branch: branch ?? undefined,
        slim
      }}
      onOpen={onOpen}
    />
  )
}

export function useArchivedSlimRow(onOpen: (item: SessionSummary) => void): (row: ArchiveShelfRow) => JSX.Element {
  const { lang } = useI18n()
  const text = v3Text(lang)
  const now = useMinuteClock()
  const projects = useStore((s) => s.settings?.projects)
  const projectNames = useStore((s) => s.settings?.projectNames)
  return (row) => {
    const owner = sessionProjectLabel(row.item, projects ?? [], projectNames ?? {})
    const project = owner.label || text.projectFallback
    return (
      <SidebarRow
        key={row.item.path}
        item={row.item}
        title={row.title}
        isCurrent={row.isCurrent}
        status={row.status}
        code={row.code}
        card={{
          project,
          cwd: owner.cwd,
          global: row.item.scope === 'global',
          ago: compactAgo(sessionActivityAt(row.item), now, lang),
          model: row.model,
          modelRef: row.modelRef,
          slim: true
        }}
        onOpen={() => onOpen(row.item)}
      />
    )
  }
}

export function WorkingShelf({
  entries,
  rowState,
  onOpen
}: {
  entries: readonly FlatEntry[]
  rowState: (item: SessionSummary) => ArchiveShelfRow
  onOpen: (item: SessionSummary) => void
}): JSX.Element | null {
  const { lang } = useI18n()
  const own = sidebarText(lang)
  const now = useMinuteClock()
  const [open, setOpen] = useState(() => readShelfOpen(WORKING_OPEN_KEY))
  const shown = open ? entries : entries.filter((entry) => rowState(entry.session).isCurrent)
  const branches = useCwdBranches(shown.map((entry) => entry.session.cwd), now)
  if (!entries.length) return null
  return (
    <section className="v3-shelf v3-shelf--working" data-open={open ? '1' : undefined} aria-label={own.workingShelf} data-testid="v3-working-shelf">
      <button
        type="button"
        className="v3-shelf-head"
        aria-expanded={open}
        onClick={() =>
          setOpen((value) => {
            writeShelfOpen(WORKING_OPEN_KEY, !value)
            return !value
          })
        }
        data-testid="v3-working-shelf-toggle"
      >
        <span className="v3-shelf-label">{own.workingShelf}</span>
        <span className="v3-shelf-rule" aria-hidden />
        <span className="v3-shelf-count">{entries.length}</span>
        <ChevronRight className="v3-shelf-chev" size={12} aria-hidden />
      </button>
      {shown.length ? (
        <div className="v3-shelf-list">
          {shown.map((entry) => (
            <FlatRow
              key={entry.session.path}
              entry={entry}
              row={rowState(entry.session)}
              now={now}
              branch={branches.get(entry.session.cwd)}
              onOpen={() => onOpen(entry.session)}
            />
          ))}
        </div>
      ) : null}
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
  onOpen,
  onNew
}: {
  scopeGroup?: SidebarGroup
  pinned: readonly FlatEntry[]
  rows: readonly FlatEntry[]
  onScope: (scope: string | null) => void
  projects: readonly ProjectRecord[]
  rowState: (item: SessionSummary) => ArchiveShelfRow
  onOpen: (item: SessionSummary) => void
  onNew: (group: SidebarGroup, projectId: string) => void
}): JSX.Element {
  const { lang } = useI18n()
  const own = sidebarText(lang)
  const now = useMinuteClock()
  const [limit, setLimit] = useState(FLAT_PAGE_SIZE)
  const dragSource = useSessionDrag((s) => s.source)
  const dragging = !!dragSource?.startsWith('session:')
  const draggingPinned = dragging && pinned.some((entry) => dragSource === `session:${entry.session.path}`)

  useEffect(() => setLimit(FLAT_PAGE_SIZE), [scopeGroup?.key])

  const shown = rows.slice(0, limit)
  const current = rows.slice(limit).find((entry) => rowState(entry.session).isCurrent)
  if (current) shown.push(current)
  const hidden = Math.max(0, rows.length - limit)
  const branches = useCwdBranches([...pinned, ...shown].map((entry) => entry.session.cwd), now)

  const render = (entry: FlatEntry): JSX.Element => (
    <FlatRow
      key={entry.session.path}
      entry={entry}
      row={rowState(entry.session)}
      now={now}
      branch={branches.get(entry.session.cwd)}
      onOpen={() => onOpen(entry.session)}
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
        {pinned.map(render)}
        {dragging && !draggingPinned ? <div className="v3-zone-drop" aria-hidden>{own.pinDrop}</div> : null}
      </div>
      <div className="v3-unpin-zone" data-unpin-zone data-dragging={draggingPinned ? '1' : undefined}>
        {draggingPinned ? <div className="v3-zone-drop" aria-hidden>{own.unpinDrop}</div> : null}
        {shown.map(render)}
        {hidden > 0 ? (
          <button type="button" className="ui-row v3-show-more" onClick={() => setLimit((value) => value + FLAT_PAGE_SIZE)} data-testid="v3-flat-more">
            {own.showMore.replace('{n}', String(Math.min(hidden, FLAT_PAGE_SIZE)))}
          </button>
        ) : null}
      </div>
    </div>
  )
}
