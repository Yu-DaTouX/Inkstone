import { Layers, PanelLeftClose, Settings } from '../../ui/icons'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'
import type { PressEvent } from 'react-aria-components'
import { shortcutKeysText, shortcutOverridesFromSettings } from '../../app/shortcuts'
import { v3Text } from '../../app/v3-text'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { openSidebarSession } from '../../features/sidebar/session-advance'
import { sameSessionPathLoose } from '../../features/sidebar/session-nav'
import { setSessionOrder, useSessionNav } from '../../features/sidebar/session-nav-store'
import { SessionMenu } from '../../features/sidebar/SessionMenu'
import { ProjectMenu } from '../../features/sidebar/ProjectMenu'
import { NewSessionPicker } from '../../features/sidebar/NewSessionPicker'
import { FolderManager } from '../../features/sidebar/FolderManager'
import { matchesStatusFilter, StatusFilter, type SessionStatusFilter } from '../../features/sidebar/StatusFilter'
import { openAddProjectPalette } from '../../features/projects'
import { quoteTargetUnder, SESSION_QUOTE_DROP_EVENT, sidebarEdge } from '../../features/sidebar/session-drag'
import { createSessionSplitDrag, setSplitBadge, type SessionSplitDrag } from '../../features/split/split-drag'
import { IconButton, Menu, MenuItem, Popover } from '../../ui'
import { compactAgo } from '../../features/sidebar/sidebar-model'
import { modelDisplayName } from '../../patterns/model-display-name'
import { sidebarText } from '../../features/sidebar/sidebar-text'
import { useSessionFileDrop } from '../../features/sidebar/use-session-file-drop'
import { useSessionJump } from '../../features/sidebar/use-session-jump'
import {
  NO_PROJECT_ID,
  discardSidebarDraft,
  resolveRowStatus,
  rowIsReceded,
  scopedKeyOf,
  sidebarActions,
  useActiveThreadKey,
  useMinuteClock,
  useSidebarDraftIds,
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
import { memoByReference } from '../lib/memoByReference'
import { resolveCollapsedFolderDot } from '../adapters/sidebar/status'
import { openSidebarThread as openView, SidebarSessionRow } from './SidebarSessionRow'
import {
  SidebarChromeFooter,
  SidebarChromeHeader,
  type SidebarUtilityEntry
} from '../components/sidebar/SidebarChrome'
import { SidebarDraftBlock } from '../components/sidebar/SidebarDraftBlock'
import { SidebarSearchContentMatches, SidebarThreadHeader } from '../components/sidebar/SidebarThreadHeader'
import { SidebarThreadUndoNotice } from '../components/sidebar/SidebarThreadUndoNotice'
import type { SidebarThreadRowView } from '../components/sidebar/SidebarThreadRow'
import type { SidebarProjectFolderView } from '../components/sidebar/SidebarProjectFolderHeader'
import './T3SidebarShell.css'

const SHELF_PAGE_SIZE = 10
const PROJECT_FILTER_KEY = 'inkstone.v3.sidebarProjectFilter'
const COLLAPSED_FOLDERS_KEY = 'inkstone.v3.sidebarCollapsedFolders'
const SHELVES_KEY = 'inkstone.v3.sidebarShelves'

function readStored<T>(key: string, parse: (raw: unknown) => T, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? parse(JSON.parse(raw)) : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

const DEFAULT_SHELVES = { working: true, snoozed: true, settled: true }
const EMPTY_SORTABLE = {}

const listedPaths = memoByReference((sessions: ReturnType<typeof useStore.getState>['sessions']) => {
  let previousPath: string | undefined
  let listed = true
  return (path: string): boolean => {
    if (path !== previousPath) {
      previousPath = path
      listed = sessions.some((entry) => sameSessionPathLoose(entry.path, path))
    }
    return listed
  }
})

export interface T3SidebarShellProps {
  inert?: boolean
  onClose?: () => void
  onArtifacts?: () => void
  onSettings?: () => void
  onSearch?: () => void
}

function refOf(view: SidebarThreadView): ThreadRef {
  return { environmentId: 'local', threadId: view.id }
}

function SidebarLooseDrafts({ ids, ...props }: { ids: readonly string[] } & Omit<ComponentProps<typeof SidebarDraftBlock>, 'drafts'>): ReactElement {
  const drafts = useSidebarDrafts(ids)
  const rows = useMemo(
    () => drafts.map((draft) => ({ draftId: draft.draftId, projectDisplayName: draft.projectDisplayName, preview: draft.preview, isActive: draft.active })),
    [drafts]
  )
  return <SidebarDraftBlock {...props} drafts={rows} />
}

export const T3SidebarShell = memo(function T3SidebarShell(props: T3SidebarShellProps): ReactElement {
  const { onArtifacts, onClose, onSettings } = props
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const own = sidebarText(lang)
  const asideRef = useRef<HTMLElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchFieldRef = useRef<HTMLDivElement>(null)
  const menuAnchorRef = useRef<HTMLElement | null>(null)
  const projectMenuAnchorRef = useRef<HTMLElement | null>(null)
  const draftMenuAnchorRef = useRef<HTMLElement | null>(null)
  const newPickerAnchorRef = useRef<HTMLElement | null>(null)
  const [newPickerOpen, setNewPickerOpen] = useState(false)
  const quoteTargetRef = useRef<HTMLElement | null>(null)
  const splitDragRef = useRef<{ key: string; drag: SessionSplitDrag } | null>(null)
  const [query, setQuery] = useState('')
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const startRename = useCallback((key: string, title: string) => {
    setRenameValue(title)
    setRenamingKey(key)
  }, [])
  const endRename = useCallback(() => setRenamingKey(null), [])
  const menuPointRef = useRef<HTMLSpanElement>(null)
  const [sessionMenu, setSessionMenu] = useState<{ key: string; open: boolean; point: { x: number; y: number } | null } | null>(null)
  const closeSessionMenu = useCallback((): void => setSessionMenu((previous) => previous ? { ...previous, open: false } : previous), [])
  const [projectMenu, setProjectMenu] = useState<{ id: string; open: boolean } | null>(null)
  const [draftMenuId, setDraftMenuId] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => readStored(COLLAPSED_FOLDERS_KEY,
    (raw) => new Set(Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []), new Set<string>()))
  const [shelves, setShelves] = useState(() => readStored(SHELVES_KEY, (raw) => {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    return {
      working: value.working !== false,
      snoozed: value.snoozed !== false,
      settled: value.settled !== false
    }
  }, DEFAULT_SHELVES))
  useEffect(() => writeStored(COLLAPSED_FOLDERS_KEY, [...collapsedFolders]), [collapsedFolders])
  useEffect(() => writeStored(SHELVES_KEY, shelves), [shelves])
  const [settledVisible, setSettledVisible] = useState(SHELF_PAGE_SIZE)
  const [retrying, setRetrying] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  const allSections = useSidebarSections()
  const projects = useSidebarProjects()
  const activeKey = useActiveThreadKey()
  const [projectFilterState, setProjectFilterState] = useState<string | null>(() => {
    try { return window.localStorage.getItem(PROJECT_FILTER_KEY) || null } catch { return null }
  })
  const projectFilter = projectFilterState === null || projectFilterState === NO_PROJECT_ID || projects.byId.get(projectFilterState)?.archived === false ? projectFilterState : null
  const setProjectFilter = useCallback((next: string | null): void => {
    setProjectFilterState(next)
    try {
      if (next === null) window.localStorage.removeItem(PROJECT_FILTER_KEY)
      else window.localStorage.setItem(PROJECT_FILTER_KEY, next)
    } catch {}
  }, [])
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const list of [allSections.pinned, allSections.active, allSections.working, allSections.snoozed, allSections.settled]) {
      for (const view of list) counts.set(view.projectId, (counts.get(view.projectId) ?? 0) + 1)
    }
    return counts
  }, [allSections])
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter | null>(null)
  const now = useMinuteClock()
  const sections = useMemo(() => {
    if (projectFilter === null && statusFilter === null) return allSections
    const keep = (list: SidebarThreadView[]): SidebarThreadView[] => list.filter((view) =>
      scopedKeyOf(view.id) === activeKey ||
      ((projectFilter === null || view.projectId === projectFilter) && (statusFilter === null || matchesStatusFilter(statusFilter, view, resolveRowStatus(view, now)))))
    return { pinned: keep(allSections.pinned), active: keep(allSections.active), working: keep(allSections.working), snoozed: keep(allSections.snoozed), settled: keep(allSections.settled) }
  }, [allSections, projectFilter, statusFilter, activeKey, now])
  const draftIdList = useSidebarDraftIds()
  const undo = useThreadUndoNotice()
  const wakeLabel = useSnoozeWakeLabel()
  const jump = useSessionNav((s) => s.jump)
  const fileDropPath = useSessionNav((s) => s.fileDropPath)
  const searching = query.trim().length > 0
  const search = useSidebarSearch(query, sections)
  const snoozePresets = useSnoozePresets(true, now)
  const rowSnoozePresets = useMemo(() => snoozePresets.map((preset) => ({ id: preset.id, label: preset.label, until: Date.parse(preset.snoozedUntil) })), [snoozePresets])

  const projectRecords = useStore((s) => s.settings?.projects)
  const profileName = useStore((s) => s.settings?.profile?.name)
  const shortcutOverrides = useStore((s) => s.settings?.shortcutOverrides)
  const conn = useStore((s) => s.conn)
  const connDetail = useStore((s) => s.connDetail)
  const currentSessionFile = useStore((s) => s.session?.sessionFile)
  const currentProjectId = useStore(
    (s) => s.runners.find((entry) => entry.id === s.activeRunnerId || entry.runId === s.activeRunnerId)?.projectId
  )
  const refreshSessions = useStore((s) => s.refreshSessions)
  const running = useStore((s) => !!(s.session?.isAgentRunning || s.session?.isStreaming))
  const currentListed = useStore(
    (s) => !(s.session?.isAgentRunning || s.session?.isStreaming) || !s.session.sessionFile || listedPaths(s.sessions)(s.session.sessionFile)
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
  const looseDraftIds = useMemo(() => draftIdList.filter((draftId) => !viewByKey.has(scopedKeyOf(draftId))), [draftIdList, viewByKey])
  const viewByPath = useMemo(() => new Map(allViews.map((view) => [view.path, view])), [allViews])
  const draftIds = useMemo(() => new Set(draftIdList), [draftIdList])

  const orderKey = useMemo(() => allViews.map((view) => view.path).join('\n'), [allViews])
  useEffect(() => {
    setSessionOrder(orderKey ? orderKey.split('\n') : [])
  }, [orderKey])

  const createGlobal = useCallback((): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void useStore.getState().newSession({ scope: 'global' })
  }, [])

  const projectRecord = useCallback(
    (projectId: string | undefined) => (projectId ? projectRecords?.find((entry) => entry.id === projectId) : undefined),
    [projectRecords]
  )

  const newThreadInProject = useCallback(
    (projectId: string | undefined, worktree?: boolean): void => {
      const record = projectRecord(projectId)
      if (!record) {
        createGlobal()
        return
      }
      useUiV3.getState().navigate({ name: 'chat' })
      void sidebarActions.newThreadIn(record, worktree)
    },
    [createGlobal, projectRecord]
  )

  const newThread = useCallback(
    (event: PressEvent): void => {
      if (event.shiftKey) {
        newThreadInProject(currentProjectId)
        return
      }
      newPickerAnchorRef.current = event.target as HTMLElement
      setNewPickerOpen(true)
    },
    [currentProjectId, newThreadInProject]
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
      const content = search.matches[0]
      if (!first && !content) return
      event.preventDefault()
      if (first) openView(first)
      else if (content) void openSidebarSession({ id: content.id ?? undefined, path: content.path })
    },
    [clearSearch, search.threads, search.matches]
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
      else void openSidebarSession({ path })
    },
    [viewByPath]
  )
  useSessionJump(asideRef, jumpToPath)
  useSessionFileDrop(asideRef, t)

  const projectFolders = useMemo<SidebarProjectFolderView[]>(() => {
    const grouped = new Map<string, SidebarThreadView[]>()
    for (const view of sections.active) {
      const list = grouped.get(view.projectId)
      if (list) list.push(view)
      else grouped.set(view.projectId, [view])
    }
    const order = projects.list
      .filter((project) => !project.archived && (projectFilter === null || project.projectId === projectFilter) && (statusFilter === null || grouped.has(project.projectId)))
      .map((project) => project.projectId)
    const ordered = new Set(order)
    const keys = [...order, ...Array.from(grouped.keys()).filter((id) => !ordered.has(id))]
    return keys.map((projectId) => {
      const rows = grouped.get(projectId) ?? []
      const project = projects.byId.get(projectId)
      const collapsed = collapsedFolders.has(projectId)
      const dot = collapsed ? resolveCollapsedFolderDot(rows, now) : null
      const threadKeys = rows.map((view) => scopedKeyOf(view.id))
      return {
        projectKey: projectId,
        displayName: project?.displayName ?? rows[0]?.projectDisplayName ?? text.groupUngrouped,
        collapsed,
        threadKeys,
        hiddenCount: collapsed ? threadKeys.length - Number(activeKey !== null && threadKeys.includes(activeKey)) : 0,
        dot,
        dotLabel: dot !== null ? own.attention : null,
        manageable: project !== undefined
      }
    })
  }, [activeKey, collapsedFolders, now, own.attention, projectFilter, projects, sections.active, statusFilter, text.groupUngrouped])

  const toggleFolder = useCallback((projectKey: string): void => {
    setCollapsedFolders((previous) => {
      const next = new Set(previous)
      if (next.has(projectKey)) next.delete(projectKey)
      else next.add(projectKey)
      return next
    })
  }, [])

  const openMenu = useCallback((threadKey: string, point: { x: number; y: number } | null = null): void => {
    const row = asideRef.current?.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(threadKey)}"]`)
    menuAnchorRef.current = row ?? null
    setDraftMenuId(null)
    setProjectMenu((previous) => previous ? { ...previous, open: false } : previous)
    setSessionMenu({ key: threadKey, open: true, point })
  }, [])

  const openProjectMenu = useCallback((projectKey: string, anchor?: HTMLElement): void => {
    if (!projectKey || projectKey === NO_PROJECT_ID) return
    projectMenuAnchorRef.current = anchor ?? asideRef.current?.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(`folder:${projectKey}`)}"]`) ?? null
    closeSessionMenu()
    setDraftMenuId(null)
    setProjectMenu({ id: projectKey, open: true })
  }, [closeSessionMenu])

  const openFolderMenu = useCallback((projectKey: string) => openProjectMenu(projectKey), [openProjectMenu])
  const newThreadInFolder = useCallback((projectKey: string) => newThreadInProject(projectKey), [newThreadInProject])
  const modelCatalog = useStore((s) => s.models)
  const rowView = useMemo(() => memoByReference(
    (view: SidebarThreadView): SidebarThreadRowView & { sessionPath: string } => {
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
        branch: view.branch,
        worktreePath: view.worktreePath,
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
        modelLabel: view.modelLabel ? modelDisplayName(view.modelLabel, modelCatalog ?? []) : null,
        diff: null
      }
    }
  ), [activeKey, draftIds, jump, lang, modelCatalog, now, wakeLabel])

  const renderRow = useCallback(
    (rowProps: SidebarRowRenderProps) => {
      const view = viewByKey.get(rowProps.threadKey)
      if (!view) return null
      const threadKey = rowProps.threadKey
      return (
        <SidebarSessionRow
          key={threadKey}
          id={view.id}
          view={rowView(view)}
          variant={rowProps.variant}
          isActive={threadKey === activeKey}
          navigationParent={rowProps.navigationParent}
          dropVerb={rowProps.dropVerb}
          isFileDragOver={fileDropPath === view.path}
          archived={view.archivedAt !== null}
          snoozedUntil={view.snoozedUntil}
          renameValue={renamingKey === threadKey ? renameValue : null}
          snoozePresets={rowSnoozePresets}
          sortable={rowProps.sortable}
          onMenu={openMenu}
          onRenameStart={startRename}
          onRenameChange={setRenameValue}
          onRenameEnd={endRename}
          onAnnounce={setAnnouncement}
        />
      )
    },
    [activeKey, endRename, fileDropPath, openMenu, renameValue, renamingKey, rowSnoozePresets, rowView, startRename, viewByKey]
  )

  const onDropPlan = useCallback(
    (input: SidebarDropInput): void => {
      const view = viewByKey.get(input.threadKey)
      if (!view) return
      const ref = refOf(view)
      void (async () => {
        const plan = input.plan
        if ((plan.kind === 'pin' || plan.kind === 'archive' || (plan.kind === 'move-active' && plan.unsnooze)) && view.snoozedUntil !== null && !await sidebarActions.unsnooze(ref)) return
        if (plan.kind === 'pin' || (plan.kind === 'move-active' && plan.unsettle)) {
          const project = useStore.getState().settings?.projects.find((item) => item.id === view.projectId)
          if (project?.archived && !await sidebarActions.restoreProject(project)) return
          if (view.archivedAt !== null && !await sidebarActions.unarchive(ref)) return
        }
        if (plan.kind === 'pin') await sidebarActions.pin(ref)
        else if (plan.kind === 'archive') await sidebarActions.archive(ref)
        else if (plan.kind === 'move-active' && plan.unpin) await sidebarActions.unpin(ref)
      })()
    },
    [viewByKey]
  )

  const clearQuoteTarget = useCallback((): void => {
    quoteTargetRef.current?.removeAttribute('data-quote-over')
    quoteTargetRef.current = null
    splitDragRef.current?.drag.end()
    splitDragRef.current = null
    setSplitBadge(null)
  }, [])

  const splitDragFor = useCallback(
    (threadKey: string): SessionSplitDrag | null => {
      if (splitDragRef.current?.key === threadKey) return splitDragRef.current.drag
      const view = viewByKey.get(threadKey)
      if (!view) return null
      const drag = createSessionSplitDrag({ id: view.id, path: view.path })
      splitDragRef.current = { key: threadKey, drag }
      return drag
    },
    [viewByKey]
  )

  useEffect(() => clearQuoteTarget, [clearQuoteTarget])

  const settledShown = useMemo(() => {
    const shown = sections.settled.slice(0, settledVisible)
    const current = activeKey === null ? -1 : sections.settled.findIndex((view) => scopedKeyOf(view.id) === activeKey)
    if (current >= settledVisible) shown.push(sections.settled[current])
    return shown
  }, [sections.settled, settledVisible, activeKey])
  const listSectionKeys = useMemo(() => {
    const keys = (views: SidebarThreadView[]) => views.map((view) => scopedKeyOf(view.id))
    return { pinned: keys(sections.pinned), active: keys(sections.active), working: keys(sections.working), snoozed: keys(sections.snoozed), settled: keys(settledShown) }
  }, [sections.pinned, sections.active, sections.working, sections.snoozed, settledShown])
  const settledRemaining = Math.max(0, sections.settled.length - settledShown.length)
  const undoNotice = undo.text === null ? null : { text: undo.text, label: undo.label, undo: undo.undo }
  const menuView = sessionMenu === null ? null : viewByKey.get(sessionMenu.key)
  const menuSession = useStore((s) => menuView ? s.sessions.find((entry) => entry.id === menuView.id) : undefined)
  const menuProject = projectMenu ? projectRecord(projectMenu.id) : undefined
  const menuDraftId = draftMenuId !== null && draftIds.has(draftMenuId) ? draftMenuId : null
  const connBannerShown = useUiV3((s) => s.route.name === 'chat')

  const connLabel = conn === 'ready' ? t('conn.ready') : conn === 'starting' ? t('conn.starting') : t('conn.down')
  const userName = profileName?.trim() || own.localUser
  const newThreadShortcut = useMemo(() => shortcutKeysText('newSession', shortcutOverridesFromSettings({ shortcutOverrides })), [shortcutOverrides])

  const utilities: SidebarUtilityEntry[] = []
  if (onSettings) utilities.push({ key: 'settings', label: text.settingsEntryHint, icon: <Settings />, onSelect: onSettings })
  if (onArtifacts) utilities.push({ key: 'artifacts', label: t('artifactLibrary.title'), icon: <Layers />, onSelect: onArtifacts })

  const closeLabel = text.toggleSidebar

  return (
    <aside ref={asideRef} inert={props.inert} className="v3-side" aria-label={text.sidebarLabel} data-testid="v3-sidebar" data-density-scope="comfortable">
      <div
        data-slot="sidebar-wrapper"
        data-sidebar-state="open"
        className="t3-sidebar-shell"
        style={{ '--workspace-topbar-height': 'var(--size-head)' } as CSSProperties}
      >
        <SidebarChromeHeader
          toggleLabel={closeLabel}
          leading={
            onClose ? (
              <IconButton
                data-t3-btn
                variant="ghost"
                size="md"
                aria-label={closeLabel}
                title={closeLabel}
                onPress={onClose}
                className="t3-sidebar-shell__close"
                data-testid="v3-side-close"
              >
                <PanelLeftClose />
              </IconButton>
            ) : null
          }
        />

        <div className="t3-sidebar-shell__header">
          <SidebarThreadHeader
            searchFieldRef={searchFieldRef}
            hasProjects={projects.list.length > 0}
            statusFilter={<StatusFilter value={statusFilter} onChange={setStatusFilter} />}
            folderManager={<FolderManager value={projectFilter} projects={projects.list} onChange={setProjectFilter} onManage={(projectId, anchor) => openProjectMenu(projectId, anchor)} onAdd={openAddProjectPalette} counts={folderCounts} />}
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
          className="t3-sidebar-shell__scroll"
        >
          {searching ? (
            <>
              {search.failed || (search.threads.length === 0 && search.matches.length === 0) ? (
                <p role="status" className="t3-sidebar-shell__empty">
                  {t(search.failed ? 'sidebar.t3.searchFailed' : search.pending ? 'sidebar.t3.searching' : 'sidebar.t3.noResults')}
                </p>
              ) : null}
              {search.threads.length > 0 ? (
                <ul aria-label={t('sidebar.t3.searchThreads')} className="v3-swap-fade t3-sidebar-shell__results">
                  {search.threads.map((view) => renderRow({ threadKey: scopedKeyOf(view.id), section: 'active', variant: 'slim', dropVerb: null, sortable: EMPTY_SORTABLE }))}
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
              sections={listSectionKeys}
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
              onFolderContextMenu={openFolderMenu}
              onNewThreadInFolder={newThreadInFolder}
              folderNewThreadLabel={(projectKey) => t('sidebar.t3.newThreadInProjectName', { name: projects.byId.get(projectKey)?.displayName ?? '' })}
              folderMenuLabel={own.projectMenu}
              draftRows={
                looseDraftIds.length === 0 ? null : (
                  <SidebarLooseDrafts
                    ids={looseDraftIds}
                    discardLabel={t('sidebar.t3.discardDraft')}
                    unsentLabel={t('sidebar.t3.unsentDraft')}
                    onNavigateToDraft={(draftId) => {
                      const view = viewByKey.get(scopedKeyOf(draftId))
                      if (view) {
                        openView(view)
                        return
                      }
                      const state = useStore.getState()
                      const runId = draftId.startsWith('run:') ? draftId.slice(4) : draftId.startsWith('pending:') ? draftId.slice(8) : ''
                      const runner = state.runners.find((item) => item.sessionId === draftId || (!!runId && (item.runId ?? item.id) === runId))
                      if (runner?.sessionFile) {
                        void openSidebarSession({ path: runner.sessionFile })
                        return
                      }
                      const text = state.sessionRuntimes[draftId]?.draft ?? ''
                      void state.newSession(runner?.cwd ? { cwd: runner.cwd } : undefined).then(() => {
                        useStore.setState({ editorInject: { text, mode: 'replace' } })
                        discardSidebarDraft(draftId)
                      })
                    }}
                    onDiscardDraft={(draftId) => discardSidebarDraft(draftId)}
                    onDraftContextMenu={(draftId) => {
                      draftMenuAnchorRef.current = asideRef.current?.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(`draft:${draftId}`)}"]`) ?? null
                      closeSessionMenu()
                      setProjectMenu((previous) => previous ? { ...previous, open: false } : previous)
                      setDraftMenuId(draftId)
                    }}
                  />
                )
              }
              draftKey={looseDraftIds.join('|')}
              undoNotice={undoNotice === null ? null : <SidebarThreadUndoNotice notice={undoNotice} />}
              emptyState={
                allViews.length === 0 ? (
                  <p className="t3-sidebar-shell__empty">{t('rail.empty')}</p>
                ) : null
              }
              renderRow={renderRow}
              onDropPlan={onDropPlan}
              onMoveOutside={({ x, y }, threadKey) => {
                const next = quoteTargetUnder(x, y)
                if (quoteTargetRef.current !== next) {
                  quoteTargetRef.current?.removeAttribute('data-quote-over')
                  next?.setAttribute('data-quote-over', '1')
                  quoteTargetRef.current = next
                }
                const split = splitDragFor(threadKey)
                if (next) {
                  split?.clear()
                  return true
                }
                return split?.move(x, y, sidebarEdge()) === true
              }}
              onDropOutside={({ x, y }, threadKey) => {
                const target = quoteTargetUnder(x, y)
                const view = viewByKey.get(threadKey)
                if (!view) return false
                if (target) {
                  target.dispatchEvent(new CustomEvent(SESSION_QUOTE_DROP_EVENT, { detail: { id: view.id, path: view.path, title: view.title } }))
                  return true
                }
                return splitDragFor(threadKey)?.drop(x, y, sidebarEdge()) === true
              }}
              onDragFinish={clearQuoteTarget}
              className="v3-swap-fade t3-sidebar-shell__threads"
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
          onRetryConnection={connBannerShown ? undefined : () => {
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

      {menuProject ? <ProjectMenu key={menuProject.id} project={menuProject} anchor={projectMenuAnchorRef} open={projectMenu?.open === true} onOpenChange={(open) => setProjectMenu((previous) => previous ? { ...previous, open } : previous)} onNew={() => newThreadInProject(menuProject.id)} onNewWorktree={() => newThreadInProject(menuProject.id, true)} /> : null}
      <NewSessionPicker
        anchor={newPickerAnchorRef}
        open={newPickerOpen}
        onOpenChange={setNewPickerOpen}
        onProject={(record) => newThreadInProject(record.id)}
        onStarted={() => useUiV3.getState().navigate({ name: 'chat' })}
      />
      <Popover triggerRef={draftMenuAnchorRef} isOpen={menuDraftId !== null} onOpenChange={(open) => { if (!open) setDraftMenuId(null) }} placement="bottom end" offset={4}>
        <Menu aria-label={t('sidebar.t3.unsentDraft')} autoFocus="first" onClose={() => setDraftMenuId(null)} onAction={() => { if (menuDraftId !== null) discardSidebarDraft(menuDraftId); setDraftMenuId(null) }} data-testid="sidebar-draft-menu">
          <MenuItem id="discard" tone="danger">{t('sidebar.t3.discardDraft')}</MenuItem>
        </Menu>
      </Popover>

      {createPortal(<span ref={menuPointRef} className="v3-side-menu-point" style={sessionMenu?.point ? { left: sessionMenu.point.x, top: sessionMenu.point.y } : undefined} aria-hidden />, document.body)}
      {menuView && menuSession ? (
        <SessionMenu
          key={menuView.id}
          item={menuSession}
          title={menuView.title}
          isCurrent={scopedKeyOf(menuView.id) === activeKey}
          anchor={menuAnchorRef}
          pointAnchor={sessionMenu?.point ? menuPointRef : undefined}
          open={sessionMenu?.open === true}
          onOpenChange={(open) => {
            if (!open) closeSessionMenu()
          }}
          onRename={() => {
            setRenameValue(menuView.title)
            setRenamingKey(scopedKeyOf(menuView.id))
            closeSessionMenu()
          }}
        />
      ) : null}
    </aside>
  )
})
