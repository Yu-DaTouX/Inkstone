import { Clock, Layers, PanelLeftClose, Settings, Users } from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { shortcutKeysText, shortcutOverridesFromSettings } from '../../app/shortcuts'
import { v3Text } from '../../app/v3-text'
import { useI18n, useT } from '../../i18n'
import { newSessionInPickedFolder } from '../../lib/new-session-in-folder'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { collabText } from '../../features/collab/collab-text'
import { usePendingPairInvite } from '../../features/collab/pending-invite'
import { openSidebarSession } from '../../features/sidebar/session-advance'
import { setSessionOrder, useSessionNav } from '../../features/sidebar/session-nav-store'
import { SessionMenu } from '../../features/sidebar/SessionMenu'
import { compactAgo } from '../../features/sidebar/sidebar-model'
import { sidebarText } from '../../features/sidebar/sidebar-text'
import { useSessionFileDrop } from '../../features/sidebar/use-session-file-drop'
import { useSessionJump } from '../../features/sidebar/use-session-jump'
import {
  NO_PROJECT_ID,
  resolveRowStatus,
  rowIsReceded,
  scopedKeyOf,
  sidebarActions,
  useActiveThreadKey,
  useMinuteClock,
  useSidebarDrafts,
  useSidebarProjects,
  useSidebarSections,
  useSidebarSearch,
  useSnoozePresets,
  useSnoozeWakeLabel,
  useThreadUndoNotice,
  type SidebarThreadView,
  type ThreadRef
} from '../adapters/sidebar'
import { SidebarThreadList, type SidebarDropInput, type SidebarRowRenderProps } from '../components/Sidebar'
import { ProjectFavicon } from '../components/ProjectFavicon'
import {
  SidebarAttentionSummary,
  SidebarChromeFooter,
  SidebarChromeHeader,
  type SidebarAttentionKind,
  type SidebarUtilityEntry
} from '../components/sidebar/SidebarChrome'
import { SidebarDraftBlock } from '../components/sidebar/SidebarDraftBlock'
import { SidebarSearchContentMatches, SidebarThreadHeader } from '../components/sidebar/SidebarThreadHeader'
import { SidebarThreadUndoNotice } from '../components/sidebar/SidebarThreadUndoNotice'
import {
  SidebarThreadRow,
  type SidebarThreadRowView
} from '../components/sidebar/SidebarThreadRow'
import type { SidebarProjectFolderView } from '../components/sidebar/SidebarProjectFolderHeader'

const SHELF_PAGE_SIZE = 10

export interface T3SidebarShellProps {
  preview?: boolean
  onPin?: () => void
  onClose?: () => void
  onSchedule?: () => void
  onCollab?: () => void
  onArtifacts?: () => void
  onSettings?: () => void
  onSearch?: () => void
}

function refOf(view: SidebarThreadView): ThreadRef {
  return { environmentId: 'local', threadId: view.id }
}

export const T3SidebarShell = memo(function T3SidebarShell(props: T3SidebarShellProps): ReactElement {
  const { onArtifacts, onClose, onCollab, onPin, onSchedule, onSettings, preview } = props
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const own = sidebarText(lang)
  const asideRef = useRef<HTMLElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchFieldRef = useRef<HTMLDivElement>(null)
  const menuAnchorRef = useRef<HTMLElement | null>(null)
  const jumpCursor = useRef<Partial<Record<SidebarAttentionKind, string>>>({})
  const [query, setQuery] = useState('')
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set())
  const [shelves, setShelves] = useState({ working: true, snoozed: true, settled: true })
  const [settledVisible, setSettledVisible] = useState(SHELF_PAGE_SIZE)
  const [retrying, setRetrying] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  const sections = useSidebarSections()
  const projects = useSidebarProjects()
  const drafts = useSidebarDrafts()
  const undo = useThreadUndoNotice()
  const activeKey = useActiveThreadKey()
  const now = useMinuteClock()
  const wakeLabel = useSnoozeWakeLabel()
  const jump = useSessionNav((s) => s.jump)
  const fileDropPath = useSessionNav((s) => s.fileDropPath)
  const searching = query.trim().length > 0
  const search = useSidebarSearch(query)
  const snoozePresets = useSnoozePresets(menuKey !== null)
  const invitePending = usePendingPairInvite((s) => s.invite !== null)

  const sessions = useStore((s) => s.sessions)
  const settings = useStore((s) => s.settings)
  const conn = useStore((s) => s.conn)
  const connDetail = useStore((s) => s.connDetail)
  const currentSessionFile = useStore((s) => s.session?.sessionFile)
  const currentProjectId = useStore(
    (s) => s.runners.find((entry) => entry.id === s.activeRunnerId || entry.runId === s.activeRunnerId)?.projectId
  )
  const refreshSessions = useStore((s) => s.refreshSessions)
  const running = useStore((s) => !!(s.session?.isAgentRunning || s.session?.isStreaming))
  const currentListed = useStore(
    (s) => !s.session?.sessionFile || s.sessions.some((entry) => entry.path === s.session?.sessionFile)
  )

  useEffect(() => {
    if (running) return undefined
    const id = window.setTimeout(() => void refreshSessions(), 800)
    return () => window.clearTimeout(id)
  }, [running, currentSessionFile, refreshSessions])

  useEffect(() => {
    if (!running || currentListed) return undefined
    const id = window.setInterval(() => void refreshSessions(), 2500)
    return () => window.clearInterval(id)
  }, [running, currentListed, refreshSessions])

  const allViews = useMemo(
    () => [...sections.pinned, ...sections.active, ...sections.working, ...sections.snoozed, ...sections.settled],
    [sections]
  )
  const viewByKey = useMemo(() => new Map(allViews.map((view) => [scopedKeyOf(view.id), view])), [allViews])
  const viewByPath = useMemo(() => new Map(allViews.map((view) => [view.path, view])), [allViews])
  const draftIds = useMemo(() => new Set(drafts.map((draft) => draft.draftId)), [drafts])

  const orderKey = useMemo(() => allViews.map((view) => view.path).join('\n'), [allViews])
  useEffect(() => {
    setSessionOrder(orderKey ? orderKey.split('\n') : [])
  }, [orderKey])

  const openView = useCallback((view: SidebarThreadView): void => {
    if (view.snoozedUntil !== null) void sidebarActions.unsnooze(refOf(view))
    void openSidebarSession({ id: view.id, path: view.path })
  }, [])

  const createGlobal = useCallback((): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void useStore.getState().newSession({ scope: 'global' })
  }, [])

  const createInFolder = useCallback((): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void newSessionInPickedFolder(t)
  }, [t])

  const projectRecord = useCallback(
    (projectId: string | undefined) => (projectId ? settings?.projects.find((entry) => entry.id === projectId) : undefined),
    [settings?.projects]
  )

  const newThreadInProject = useCallback(
    (projectId: string | undefined): void => {
      const record = projectRecord(projectId)
      if (!record) {
        createGlobal()
        return
      }
      useUiV3.getState().navigate({ name: 'chat' })
      void sidebarActions.newThreadIn(record)
    },
    [createGlobal, projectRecord]
  )

  const newThread = useCallback(
    (event: ReactMouseEvent): void => {
      if (event.shiftKey) newThreadInProject(currentProjectId)
      else createGlobal()
    },
    [createGlobal, currentProjectId, newThreadInProject]
  )

  const clearSearch = useCallback((): void => {
    setQuery('')
  }, [])

  const onSearchKeyDown = useCallback(
    (event: { key: string; preventDefault(): void }): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        clearSearch()
        return
      }
      if (event.key !== 'Enter') return
      const first = search.threads[0]
      if (!first) return
      event.preventDefault()
      openView(first)
    },
    [clearSearch, openView, search.threads]
  )

  useEffect(() => {
    let frame = 0
    const focus = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      })
    }
    window.addEventListener('yan-v3-focus-search', focus)
    return () => {
      window.removeEventListener('yan-v3-focus-search', focus)
      cancelAnimationFrame(frame)
    }
  }, [])

  const jumpToPath = useCallback(
    (path: string): void => {
      const view = viewByPath.get(path)
      if (view) openView(view)
    },
    [openView, viewByPath]
  )
  useSessionJump(asideRef, jumpToPath)
  useSessionFileDrop(asideRef, t)

  const attention = useMemo(() => {
    const counts: Record<SidebarAttentionKind, number> = { running: 0, awaiting: 0, unread: 0 }
    const paths: Record<SidebarAttentionKind, string[]> = { running: [], awaiting: [], unread: [] }
    for (const view of allViews) {
      const status = resolveRowStatus(view, now)
      const kind: SidebarAttentionKind | null =
        status === 'working'
          ? 'running'
          : status === 'approval' || status === 'input' || status === 'waiting'
            ? 'awaiting'
            : status === 'done'
              ? 'unread'
              : null
      if (kind === null) continue
      counts[kind] += 1
      paths[kind].push(view.path)
    }
    const stateLabel = (kind: SidebarAttentionKind): string =>
      kind === 'running' ? own.attentionRunning : kind === 'awaiting' ? own.attentionAwaiting : own.attentionUnread
    return {
      items: (['running', 'awaiting', 'unread'] as const)
        .filter((kind) => counts[kind] > 0)
        .map((kind) => ({
          kind,
          count: counts[kind],
          label: own.attentionJump.replace('{state}', stateLabel(kind)).replace('{n}', String(counts[kind]))
        })),
      paths
    }
  }, [allViews, now, own.attentionAwaiting, own.attentionJump, own.attentionRunning, own.attentionUnread])

  const jumpToAttention = useCallback(
    (kind: SidebarAttentionKind): void => {
      const list = attention.paths[kind]
      if (list.length === 0) return
      const last = jumpCursor.current[kind]
      const at = last === undefined ? -1 : list.findIndex((path) => path === last)
      const next = list[(at + 1) % list.length]
      if (next === undefined) return
      jumpCursor.current[kind] = next
      jumpToPath(next)
    },
    [attention.paths, jumpToPath]
  )

  const projectFolders = useMemo<SidebarProjectFolderView[]>(() => {
    const grouped = new Map<string, SidebarThreadView[]>()
    for (const view of sections.active) {
      const list = grouped.get(view.projectId)
      if (list) list.push(view)
      else grouped.set(view.projectId, [view])
    }
    const order = projects.list.map((project) => project.projectId)
    const keys = [
      ...order.filter((id) => grouped.has(id)),
      ...Array.from(grouped.keys()).filter((id) => !order.includes(id))
    ]
    return keys.map((projectId) => {
      const rows = grouped.get(projectId) ?? []
      const project = projects.byId.get(projectId)
      const statuses = rows.map((view) => resolveRowStatus(view, now))
      const dot: SidebarProjectFolderView['dot'] =
        statuses.some((status) => status === 'approval' || status === 'input' || status === 'waiting')
          ? 'attention'
          : statuses.some((status) => status === 'failed')
            ? 'failed'
            : rows.some((view) => view.unread)
              ? 'unread'
              : statuses.some((status) => status === 'working')
                ? 'working'
                : null
      const collapsed = collapsedFolders.has(projectId)
      return {
        projectKey: projectId,
        displayName: project?.displayName ?? rows[0]?.projectDisplayName ?? text.groupUngrouped,
        icon: project ? <ProjectFavicon project={{ projectId: project.projectId, displayName: project.displayName }} /> : null,
        collapsed,
        threadKeys: rows.map((view) => scopedKeyOf(view.id)),
        hiddenCount: collapsed ? rows.length : 0,
        dot: collapsed ? dot : null,
        dotLabel: collapsed && dot !== null ? own.attention : null
      }
    })
  }, [collapsedFolders, now, own.attention, projects, sections.active, text.groupUngrouped])

  const toggleFolder = useCallback((projectKey: string): void => {
    setCollapsedFolders((previous) => {
      const next = new Set(previous)
      if (next.has(projectKey)) next.delete(projectKey)
      else next.add(projectKey)
      return next
    })
  }, [])

  const openMenu = useCallback((threadKey: string): void => {
    const row = asideRef.current?.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(threadKey)}"]`)
    menuAnchorRef.current = row ?? null
    setMenuKey(threadKey)
  }, [])

  const rowView = useCallback(
    (view: SidebarThreadView): SidebarThreadRowView => {
      const threadKey = scopedKeyOf(view.id)
      const status = resolveRowStatus(view, now)
      const startedAt = view.runtime?.activityStartedAt === null || view.runtime === null ? NaN : Date.parse(view.runtime.activityStartedAt ?? '')
      const jumpIndex = jump?.get(view.path)
      return {
        threadKey,
        sessionPath: view.path,
        title: view.title,
        project: view.projectId === NO_PROJECT_ID ? null : { projectId: view.projectId, displayName: view.projectDisplayName ?? '' },
        projectDisplayName: view.projectDisplayName,
        branch: null,
        worktreePath: null,
        status,
        workingStartedAt: Number.isNaN(startedAt) ? null : startedAt,
        timeLabel: compactAgo(view.activityAt, now, lang === 'en-US' ? 'en-US' : 'zh-CN'),
        pinned: view.pinnedAt !== null,
        recede: rowIsReceded(status, view.unread, threadKey === activeKey),
        isUnread: view.unread,
        isWoke: false,
        snoozeWakeLabel: view.snoozedUntil === null ? null : wakeLabel(view.snoozedUntil),
        hasUnsentDraft: draftIds.has(view.id),
        jumpLabel: jumpIndex === undefined ? null : String(jumpIndex),
        modelLabel: view.modelLabel,
        diff: null
      }
    },
    [activeKey, draftIds, jump, lang, now, wakeLabel]
  )

  const renderRow = useCallback(
    (rowProps: SidebarRowRenderProps) => {
      const view = viewByKey.get(rowProps.threadKey)
      if (!view) return null
      const ref = refOf(view)
      const threadKey = rowProps.threadKey
      return (
        <SidebarThreadRow
          view={rowView(view)}
          variant={rowProps.variant}
          isActive={threadKey === activeKey}
          navigationParent={rowProps.navigationParent}
          dropVerb={rowProps.dropVerb}
          isDragging={rowProps.sortable.isDragging === true}
          isFileDragOver={fileDropPath !== null && fileDropPath === view.path}
          renaming={renamingKey === threadKey}
          renameValue={renamingKey === threadKey ? renameValue : ''}
          snoozePresets={snoozePresets.map((preset) => ({ id: preset.id, label: preset.label, until: Date.parse(preset.snoozedUntil) }))}
          sortable={rowProps.sortable}
          onOpen={() => openView(view)}
          onActivate={() => openView(view)}
          onContextMenu={() => openMenu(threadKey)}
          onRenameStart={() => {
            setRenameValue(view.title)
            setRenamingKey(threadKey)
          }}
          onRenameChange={(value) => setRenameValue(value)}
          onRenameCommit={() => {
            const next = renameValue.trim()
            setRenamingKey(null)
            if (next && next !== view.title) void sidebarActions.rename(ref, next)
          }}
          onRenameCancel={() => setRenamingKey(null)}
          onArchive={view.archivedAt === null ? () => void sidebarActions.archive(ref) : undefined}
          onUnarchive={view.archivedAt === null ? undefined : () => void sidebarActions.unarchive(ref)}
          onDelete={() => void sidebarActions.remove(ref)}
          onSnooze={(until) => {
            void sidebarActions.snooze(ref, until)
            setAnnouncement(t('sidebar.t3.snooze'))
          }}
          onUnsnooze={() => void sidebarActions.unsnooze(ref)}
          onUnpin={() => void sidebarActions.unpin(ref)}
          onDiscardDraft={() => sidebarActions.discardDraft(ref)}
        />
      )
    },
    [activeKey, fileDropPath, openMenu, openView, renameValue, renamingKey, rowView, snoozePresets, t, viewByKey]
  )

  const onDropPlan = useCallback(
    (input: SidebarDropInput): void => {
      const view = viewByKey.get(input.threadKey)
      if (!view) return
      const ref = refOf(view)
      if (input.plan.kind === 'pin') void sidebarActions.pin(ref)
      else if (input.plan.kind === 'archive') void sidebarActions.archive(ref)
      else if (input.plan.kind === 'move-active') {
        if (input.plan.unpin) void sidebarActions.unpin(ref)
        if (input.plan.unsettle) void sidebarActions.unarchive(ref)
        if (input.plan.unsnooze) void sidebarActions.unsnooze(ref)
      }
    },
    [viewByKey]
  )

  const settledRemaining = Math.max(0, sections.settled.length - Math.min(settledVisible, sections.settled.length))
  const undoNotice = undo.text === null ? null : { text: undo.text, label: undo.label, undo: undo.undo }
  const menuView = menuKey === null ? null : viewByKey.get(menuKey)
  const menuSession = menuView ? sessions.find((entry) => entry.id === menuView.id) : undefined

  const connLabel = conn === 'ready' ? t('conn.ready') : conn === 'starting' ? t('conn.starting') : t('conn.down')
  const userName = settings?.profile?.name?.trim() || own.localUser
  const newThreadShortcut = shortcutKeysText('newSession', shortcutOverridesFromSettings(settings))

  const utilities: SidebarUtilityEntry[] = []
  if (onSettings) utilities.push({ key: 'settings', label: text.settingsEntryHint, icon: <Settings />, onSelect: onSettings })
  if (onSchedule) utilities.push({ key: 'schedule', label: text.schedule, icon: <Clock />, onSelect: onSchedule })
  if (onCollab) {
    utilities.push({
      key: 'collab',
      label: collabText(lang).nav,
      icon: <Users />,
      attention: invitePending ? 'awaiting' : null,
      onSelect: onCollab
    })
  }
  if (onArtifacts) utilities.push({ key: 'artifacts', label: t('artifactLibrary.title'), icon: <Layers />, onSelect: onArtifacts })

  const closeLabel = preview ? own.pin : text.toggleSidebar

  return (
    <aside ref={asideRef} className="v3-side" aria-label={text.sidebarLabel} data-testid="v3-sidebar" data-density-scope="comfortable">
      <div
        data-slot="sidebar-wrapper"
        data-sidebar-state={preview ? 'preview' : 'open'}
        className="flex min-h-0 flex-1 flex-col bg-sidebar text-sidebar-foreground"
        style={{ '--workspace-topbar-height': 'var(--size-head)' } as CSSProperties}
      >
        <SidebarChromeHeader
          toggleLabel={closeLabel}
          status={
            <span className="flex min-w-0 items-center gap-1">
              <SidebarAttentionSummary ariaLabel={own.attention} items={attention.items} onJump={jumpToAttention} />
              {onClose || onPin ? (
                <button
                  type="button"
                  aria-label={closeLabel}
                  title={closeLabel}
                  onClick={preview ? onPin : onClose}
                  data-testid="v3-side-close"
                  className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-(--control-radius) text-(--sidebar-icon-color) outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <PanelLeftClose className="size-4" />
                </button>
              ) : null}
            </span>
          }
        />

        <div className="flex flex-col gap-px px-[var(--sidebar-content-inset)] pb-1">
          <SidebarThreadHeader
            searchFieldRef={searchFieldRef}
            hasProjects={projects.list.length > 0}
            projectScope={null}
            onNewProject={createInFolder}
            onNewThread={newThread}
            newThreadDisabled={false}
            newThreadShortcutLabel={newThreadShortcut}
            newThreadInProjectShortcutLabel={null}
            showNewThreadInProjectHint={currentProjectId !== undefined}
            searchInputRef={searchInputRef}
            searchQuery={query}
            onSearchQueryChange={setQuery}
            onSearchKeyDown={onSearchKeyDown}
            isSearching={searching}
            searchResultCount={search.threads.length}
            activeSearchResultIndex={-1}
            onClearSearch={clearSearch}
          />
        </div>

        <div
          data-slot="sidebar-content"
          className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-[var(--sidebar-content-inset)] pb-2 [scrollbar-width:none]"
        >
          {searching ? (
            <>
              {search.threads.length === 0 && search.matches.length === 0 ? (
                <p role="status" className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
                  {search.pending ? t('sidebar.t3.searching') : t('sidebar.t3.noResults')}
                </p>
              ) : null}
              {search.threads.length > 0 ? (
                <ul aria-label={t('sidebar.t3.searchThreads')} className="flex flex-col gap-px">
                  {search.threads.map((view) => (
                    <SidebarThreadRow
                      key={view.id}
                      view={rowView(view)}
                      variant="slim"
                      isActive={scopedKeyOf(view.id) === activeKey}
                      onOpen={() => openView(view)}
                      onActivate={() => openView(view)}
                      onContextMenu={() => openMenu(scopedKeyOf(view.id))}
                    />
                  ))}
                </ul>
              ) : null}
              <SidebarSearchContentMatches
                query={query}
                matches={search.matches}
                currentPath={currentSessionFile ?? undefined}
                onOpen={(match) => jumpToPath(match.path)}
                pending={search.pending}
              />
            </>
          ) : (
            <SidebarThreadList
              sections={{
                pinned: sections.pinned.map((view) => scopedKeyOf(view.id)),
                active: sections.active.map((view) => scopedKeyOf(view.id)),
                working: sections.working.map((view) => scopedKeyOf(view.id)),
                snoozed: sections.snoozed.map((view) => scopedKeyOf(view.id)),
                settled: sections.settled.slice(0, settledVisible).map((view) => scopedKeyOf(view.id))
              }}
              labels={{
                tree: t('sidebar.t3.threads'),
                pinned: t('sidebar.t3.pinned'),
                active: t('sidebar.t3.active'),
                working: own.workingShelf,
                snoozed: t('sidebar.t3.snoozed'),
                settled: own.archiveShelf
              }}
              shelves={shelves}
              onToggleShelf={(shelf) => setShelves((current) => ({ ...current, [shelf]: !current[shelf] }))}
              settledCount={sections.settled.length}
              settledExpanded={shelves.settled}
              settledVisibleCount={settledVisible}
              settledRouteThreadKey={activeKey}
              showMore={
                settledRemaining === 0
                  ? undefined
                  : {
                      label: own.showMore.replace('{n}', String(Math.min(settledRemaining, SHELF_PAGE_SIZE))),
                      disabled: false,
                      onShowMore: () => setSettledVisible((count) => count + SHELF_PAGE_SIZE)
                    }
              }
              projectFolders={projectFolders}
              onToggleFolder={toggleFolder}
              onNewThreadInFolder={(projectKey) => newThreadInProject(projects.byId.get(projectKey)?.projectId)}
              folderNewThreadLabel={(projectKey) => t('sidebar.t3.newThreadInProjectName', { name: projects.byId.get(projectKey)?.displayName ?? '' })}
              draftRows={
                drafts.length === 0 ? null : (
                  <SidebarDraftBlock
                    drafts={drafts.map((draft) => ({
                      draftId: draft.draftId,
                      projectDisplayName: draft.projectDisplayName,
                      preview: draft.preview,
                      isActive: draft.active
                    }))}
                    discardLabel={t('sidebar.t3.discardDraft')}
                    unsentLabel={t('sidebar.t3.unsentDraft')}
                    onNavigateToDraft={(draftId) => {
                      const view = viewByKey.get(scopedKeyOf(draftId))
                      if (view) openView(view)
                    }}
                    onDiscardDraft={(draftId) => drafts.find((entry) => entry.draftId === draftId)?.discard()}
                    onDraftContextMenu={(draftId) => openMenu(`draft:${draftId}`)}
                  />
                )
              }
              undoNotice={undoNotice === null ? null : <SidebarThreadUndoNotice notice={undoNotice} />}
              emptyState={
                allViews.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">{t('rail.empty')}</p>
                ) : null
              }
              renderRow={renderRow}
              onDropPlan={onDropPlan}
              className="pb-1"
            />
          )}
          <span className="v3-visually-hidden" role="status">
            {announcement}
          </span>
          <span className="v3-visually-hidden" aria-live="polite">
            {fileDropPath ? t('sidebar.fileDrop.status', { name: viewByPath.get(fileDropPath)?.title ?? '' }) : ''}
          </span>
        </div>

        <SidebarChromeFooter
          showUndoNotice={searching || allViews.length === 0}
          undo={undoNotice}
          userName={userName}
          connection={{ state: conn, label: connLabel, detail: connDetail }}
          utilities={utilities}
          retrying={retrying}
          retryLabel={t('conn.retry')}
          onRetryConnection={() => {
            setRetrying(true)
            void window.yan
              .start()
              .then(() => refreshSessions())
              .catch(() => undefined)
              .finally(() => setRetrying(false))
          }}
          connectionSettingsLabel={own.connectionSettings}
          onConnectionSettings={() => useStore.getState().openSettings('devices')}
        />
      </div>

      {menuView && menuSession ? (
        <SessionMenu
          item={menuSession}
          title={menuView.title}
          isCurrent={scopedKeyOf(menuView.id) === activeKey}
          anchor={menuAnchorRef}
          open
          onOpenChange={(open) => {
            if (!open) setMenuKey(null)
          }}
          onRename={() => {
            setRenameValue(menuView.title)
            setRenamingKey(scopedKeyOf(menuView.id))
            setMenuKey(null)
          }}
        />
      ) : null}
    </aside>
  )
})
