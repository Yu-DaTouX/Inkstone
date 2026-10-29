import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Archive, PanelLeftClose, Search, Settings, FolderPlus, SquarePen, Unplug } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { Avatar, Button, Dialog, DialogFooter, EmptyState, IconButton, ListRow, Modal, ModalOverlay, SearchField, StatusDot, type StatusDotKind } from '../../ui'
import { SESSION_FOLDER_DROP_EVENT, type SessionFolderDrop } from './session-drag'
import { newSessionInPickedFolder } from '../../lib/new-session-in-folder'
import { BrandMark } from './BrandMark'
import { v3Text, withShortcutKeys } from '../../app/v3-text'
import { shortcutKeysText, shortcutOverridesFromSettings } from '../../app/shortcuts'
import type { SessionSummary } from '../../../../shared/ipc'
import { GROUP_PAGE_SIZE, buildArchivedView, buildFlatSidebar, buildSidebarGroups, groupPage, indexRuns, withIdleProjects, type SidebarGroup } from './sidebar-model'
import { isUnreadRun, useRunsV3 } from '../../state/runs-v3'
import { markSessionRunsSeen } from '../../state/use-current-runs-seen'
import { ArchivedView } from './ArchivedView'
import { ArchiveShelf, type ArchiveShelfRow } from './ArchiveShelf'
import { ProjectHeader } from './ProjectHeader'
import { SidebarRow } from './SidebarRow'
import { SidebarTip } from './SidebarTip'
import { sidebarText } from './sidebar-text'
import { SideMore } from './SideMore'
import { ContentMatches, useContentSearch } from './ContentMatches'
import { FlatSessionList, FlatToolbar, ProjectScopeButton, WorkingShelf, useArchivedSlimRow, useFlatScope, useWorkingSet } from './FlatSessions'
import { turnModelLabel } from '../session/turn-model-label'
import { buildContentMatches } from './content-search'
import { sessionStatusKind, sessionUnread } from './session-status'
import { activeSessions, isSnoozed, snoozedSessions } from './session-snooze'
import { useSnoozeClock } from './use-session-snooze'
import { SnoozeShelf } from './SnoozeShelf'
import { createSidebarRunsSelector } from './sidebar-runs'
import './Sidebar.css'

function toggleKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

interface Props {
  preview?: boolean
  onPin?: () => void
  onClose?: () => void
  onSchedule?: () => void
  onCollab?: () => void
  onArtifacts?: () => void
  onSettings?: () => void
  onSearch?: () => void
}

export const Sidebar = memo(function Sidebar({ onClose, onSchedule, onCollab, onArtifacts, onSettings, onSearch, preview, onPin }: Props): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const own = sidebarText(lang)
  const asideRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [visibleCounts, setVisibleCounts] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [announcement, setAnnouncement] = useState('')
  const [scrolled, setScrolled] = useState(false)
  const revealedRef = useRef('')
  const listRef = useRef<HTMLElement>(null)
  const pendingFocusRef = useRef('')
  const [folderDrop, setFolderDrop] = useState<SessionFolderDrop | null>(null)

  useEffect(() => {
    const onFolderDrop = (event: Event): void => setFolderDrop((event as CustomEvent<SessionFolderDrop>).detail)
    window.addEventListener(SESSION_FOLDER_DROP_EVENT, onFolderDrop)
    return () => window.removeEventListener(SESSION_FOLDER_DROP_EVENT, onFolderDrop)
  }, [])

  const applyFolderDrop = (withCwd: boolean): void => {
    const drop = folderDrop
    setFolderDrop(null)
    if (drop) void useStore.getState().moveSession(drop.item.id, drop.projectId, withCwd ? drop.cwd : undefined)
  }

  const sessions = useStore((s) => s.sessions)
  const snoozeNow = useSnoozeClock()
  const listedSessions = useMemo(() => activeSessions(sessions, snoozeNow), [sessions, snoozeNow])
  const snoozedRows = useMemo(() => snoozedSessions(sessions, snoozeNow), [sessions, snoozeNow])
  const currentSessionId = useStore((s) => s.session?.sessionId)
  const settings = useStore((s) => s.settings)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const models = useStore((s) => s.models)
  const selectRuns = useMemo(createSidebarRunsSelector, [])
  const runs = useRunsV3(selectRuns)
  const conn = useStore((s) => s.conn)
  const connDetail = useStore((s) => s.connDetail)
  const [retrying, setRetrying] = useState(false)
  const newSession = useStore((s) => s.newSession)
  const switchSession = useStore((s) => s.switchSession)
  const refreshSessions = useStore((s) => s.refreshSessions)
  const running = useStore((s) => !!(s.session?.isAgentRunning || s.session?.isStreaming))
  const currentSessionFile = useStore((s) => s.session?.sessionFile)
  const route = useUiV3((s) => s.route.name)

  const currentListed = useStore((s) => !s.session?.sessionFile || s.sessions.some((entry) => entry.path === s.session?.sessionFile))

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

  const currentProjectId = useStore((s) => s.runners.find((r) => r.id === s.activeRunnerId || r.runId === s.activeRunnerId)?.projectId)
  const currentCwd = useStore((s) => s.runners.find((r) => r.id === s.activeRunnerId || r.runId === s.activeRunnerId)?.cwd || s.session?.cwd)
  const flat = settings?.sidebarLayout === 'flat'
  const [flatScope, setFlatScope] = useFlatScope()

  const groups = useMemo(
    () =>
      buildSidebarGroups({
        sessions: listedSessions,
        query,
        projects: settings?.projects ?? [],
        projectNames: settings?.projectNames ?? {},
        currentProjectId,
        currentCwd,
        titles,
        manualTitles,
        pinnedLabel: flat ? undefined : text.pinnedGroup
      }),
    [listedSessions, query, settings?.projects, settings?.projectNames, currentProjectId, currentCwd, titles, manualTitles, text.pinnedGroup, flat]
  )
  const scopeGroups = useMemo(
    () =>
      flat
        ? withIdleProjects(
            buildSidebarGroups({
              sessions: listedSessions,
              query: '',
              projects: settings?.projects ?? [],
              projectNames: settings?.projectNames ?? {},
              titles,
              manualTitles
            }),
            settings?.projects ?? [],
            settings?.projectNames ?? {}
          )
        : [],
    [flat, listedSessions, settings?.projects, settings?.projectNames, titles, manualTitles]
  )

  const archivedView = useMemo(
    () =>
      buildArchivedView({
        sessions,
        projects: settings?.projects ?? [],
        projectNames: settings?.projectNames ?? {},
        titles,
        manualTitles,
        query
      }),
    [sessions, settings?.projects, settings?.projectNames, titles, manualTitles, query]
  )
  const archivedCount = useMemo(
    () => (settings?.projects ?? []).filter((project) => project.archived).length + sessions.filter((item) => !!item.archivedAt).length,
    [settings?.projects, sessions]
  )
  const projectRecords = settings?.projects ?? []
  const runIndex = useMemo(() => indexRuns(runs), [runs])

  const total = groups.reduce((sum, group) => sum + group.list.length, 0)

  const contentState = useContentSearch(query, !showArchived)
  const contentMatches = useMemo(
    () =>
      buildContentMatches({
        hits: contentState.hits,
        sessions,
        shownPaths: groups.flatMap((group) => group.list.map((item) => item.path)),
        titleOf: (item) => manualTitles[item.id] ?? titles[item.id] ?? item.title,
        fallbackTitle: (updatedAt) =>
          own.contentFallbackTitle.replace(
            '{date}',
            new Date(updatedAt).toLocaleString(lang, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          )
      }),
    [contentState.hits, sessions, groups, manualTitles, titles, own.contentFallbackTitle, lang]
  )
  const contentVisible = contentState.status === 'searching' || contentState.status === 'failed' || contentMatches.length > 0

  const isCurrentItem = (item: SessionSummary): boolean =>
    currentSessionId === item.id || (!!currentSessionFile && currentSessionFile === item.path)

  const currentKey = currentSessionId ?? currentSessionFile ?? ''
  useEffect(() => {
    if (!currentKey || revealedRef.current === currentKey) return
    const group = groups.find((g) => g.list.some((item) => isCurrentItem(item)))
    if (!group) return
    revealedRef.current = currentKey
    setCollapsedKeys((prev) => (prev.has(group.slot) ? toggleKey(prev, group.slot) : prev))
  }, [currentKey, groups, currentSessionId, currentSessionFile])

  const rowState = (item: SessionSummary): ArchiveShelfRow => {
    const isCurrent = isCurrentItem(item)
    const run = runIndex.latest({ id: item.id, path: item.path })
    const paneSelected = isCurrent
    const unread = run ? sessionUnread({ unread: isUnreadRun(run), paneSelected }) : false
    return {
      item,
      title: manualTitles[item.id] ?? titles[item.id] ?? item.title,
      isCurrent,
      status: sessionStatusKind({ phase: run?.phase ?? null, unread, archived: !!item.archivedAt, markedUnread: item.markedUnread }),
      code: run?.code,
      model: run?.model?.label || (item.model ? turnModelLabel(item.model, models).label : undefined),
      modelRef: run?.model ?? item.model
    }
  }

  const showShelf = !showArchived && archivedCount > 0

  const scopeGroup = flat ? groups.find((group) => group.key === flatScope) : undefined
  const flatView = useMemo(() => buildFlatSidebar(flat ? groups : [], scopeGroup?.key ?? null), [flat, groups, scopeGroup])
  const runningPaths = flatView.rows.filter((entry) => rowState(entry.session).status === 'running').map((entry) => entry.session.path)
  const working = useWorkingSet(runningPaths)
  const workingRows = flatView.rows.filter((entry) => working.has(entry.session.path))
  const activeRows = workingRows.length ? flatView.rows.filter((entry) => !working.has(entry.session.path)) : flatView.rows

  const pageOf = (group: SidebarGroup): ReturnType<typeof groupPage> =>
    groupPage(
      group.list,
      visibleCounts.get(group.slot) ?? 0,
      group.list.find((item) => isCurrentItem(item)) ?? null
    )

  useEffect(() => {
    const path = pendingFocusRef.current
    if (!path) return
    pendingFocusRef.current = ''
    asideRef.current?.querySelector<HTMLElement>(`[data-session-path="${CSS.escape(path)}"] .v3-row`)?.focus()
  }, [visibleCounts])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = (): void => {
      list.style.setProperty('--v3-nav-lane', `${Math.max(0, list.offsetWidth - list.clientWidth)}px`)
      setScrolled(list.scrollTop > 2)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    list.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      list.removeEventListener('scroll', measure)
    }
  }, [])

  useEffect(() => {
    let frame = 0
    const focus = (): void => {
      cancelAnimationFrame(frame)
      setFiltering(true)
      frame = requestAnimationFrame(() => {
        const input = asideRef.current?.querySelector<HTMLInputElement>('.v3-side-search input')
        input?.focus()
        input?.select()
      })
    }
    window.addEventListener('yan-v3-focus-search', focus)
    return () => {
      window.removeEventListener('yan-v3-focus-search', focus)
      cancelAnimationFrame(frame)
    }
  }, [])

  const openSession = useCallback((item: { id: string; path: string }): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void switchSession(item.path).then(() => {
      if (useStore.getState().peekedPath !== item.path) return
      markSessionRunsSeen(item)
    })
  }, [switchSession])

  const openSnoozed = useCallback((item: SessionSummary): void => {
    if (isSnoozed(item, Date.now())) void useStore.getState().setSessionSnoozed(item.id, null)
    openSession(item)
  }, [openSession])
  const archivedSlimRow = useArchivedSlimRow(openSession)

  const createGlobal = (): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void newSession({ scope: 'global' })
  }

  const createInFolder = (): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void newSessionInPickedFolder(t)
  }

  const createInProject = (group: SidebarGroup, projectId: string): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void newSession({ cwd: group.cwd, projectId, scope: 'project' })
  }

  const showMore = (group: SidebarGroup, keyboard: boolean): void => {
    const revealed = visibleCounts.get(group.slot) ?? 0
    const page = pageOf(group)
    if (page.expanded) {
      setVisibleCounts((prev) => {
        const next = new Map(prev)
        next.delete(group.slot)
        return next
      })
      setAnnouncement(own.showLessAnnounce.replace('{group}', group.label))
      return
    }
    const target = group.list[GROUP_PAGE_SIZE + revealed]
    if (keyboard && target) pendingFocusRef.current = target.path
    setVisibleCounts((prev) => {
      const next = new Map(prev)
      next.set(group.slot, revealed + GROUP_PAGE_SIZE)
      return next
    })
    setAnnouncement(own.showMoreAnnounce.replace('{n}', String(page.revealable)).replace('{group}', group.label))
  }

  const connLabel = conn === 'ready' ? t('conn.ready') : conn === 'starting' ? t('conn.starting') : t('conn.down')
  const connDot: StatusDotKind = conn === 'ready' ? 'ok' : conn === 'starting' ? 'pending' : 'fail'
  const connBroken = conn === 'exited' || conn === 'error'
  const userName = settings?.profile?.name?.trim() || own.localUser
  const newChatLabel = withShortcutKeys(text.newChatShortcut, shortcutKeysText('newSession', shortcutOverridesFromSettings(settings)))

  return (
    <aside className="v3-side" ref={asideRef} aria-label={text.sidebarLabel} data-testid="v3-sidebar" data-density-scope="comfortable" data-layout={flat ? 'flat' : undefined}>
      <div className="v3-side-top">
        <span className="v3-side-brand">
          <BrandMark size={16} decorative />
          <span className="v3-side-name">Inkstone</span>
        </span>
        <div className="v3-side-top-actions">
          {flat ? null : (
            <IconButton aria-label={newChatLabel} tooltip={newChatLabel} onPress={createGlobal} data-testid="v3-new-chat">
              <SquarePen size={16} />
            </IconButton>
          )}
          {onClose ? (
            <IconButton
              aria-label={preview ? own.pin : text.toggleSidebar}
              tooltip={text.toggleSidebar}
              onPress={preview ? onPin : onClose}
              className="v3-side-close"
              data-testid="v3-side-close"
            >
              <PanelLeftClose size={16} />
            </IconButton>
          ) : null}
        </div>
      </div>

      {flat ? (
        <FlatToolbar
          query={query}
          onQuery={setQuery}
          filtering={filtering}
          onFiltering={setFiltering}
          tools={
            <>
              <ProjectScopeButton groups={scopeGroups} scope={flatScope} onScope={setFlatScope} onNew={createInProject} onAddProject={createInFolder} />
              <IconButton aria-label={own.newChatInFolder} tooltip={own.newChatInFolder} onPress={createInFolder} data-testid="v3-nav-new-chat-folder">
                <FolderPlus size={18} />
              </IconButton>
              <IconButton aria-label={newChatLabel} tooltip={newChatLabel} onPress={createGlobal} data-testid="v3-new-chat">
                <SquarePen size={18} />
              </IconButton>
              <SideMore route={route} onSchedule={onSchedule} onCollab={onCollab} onArtifacts={onArtifacts} compact />
            </>
          }
        />
      ) : (
        <>
          <div className="v3-side-search">
            {filtering || query ? (
              <SearchField
                aria-label={own.filterSessions}
                placeholder={own.filterSessions}
                value={query}
                onChange={setQuery}
                autoFocus
                onBlur={() => { if (!query) setFiltering(false) }}
                onKeyDown={(event) => { if (event.key === 'Escape' && !query) setFiltering(false) }}
                data-testid="v3-search"
              />
            ) : (
              <SidebarTip label={own.searchHint}>
                <ListRow variant="field" icon={<Search size={16} />} aria-label={own.searchHint} onClick={onSearch} data-testid="v3-search-open">
                  {own.search}
                </ListRow>
              </SidebarTip>
            )}
          </div>

          <div className="v3-side-entries">
            <ListRow icon={<FolderPlus size={16} />} onClick={createInFolder} data-testid="v3-nav-new-chat-folder">
              {own.newChatInFolder}
            </ListRow>
            <SideMore route={route} onSchedule={onSchedule} onCollab={onCollab} onArtifacts={onArtifacts} />
          </div>
        </>
      )}

      <nav className="v3-side-list" ref={listRef} data-scrolled={scrolled ? '1' : undefined}>
        {showArchived ? (
          <ArchivedView
            view={archivedView}
            titleOf={(item) => manualTitles[item.id] ?? titles[item.id] ?? item.title}
            onOpen={openSession}
          />
        ) : (
          <div className="v3-side-active" data-archive-restore data-drop-label={own.restoreDrop}>
            {groups.length === 0 && snoozedRows.length === 0 && !contentVisible ? (
            <EmptyState size="sm" title={query ? t('rail.noMatch') : t('rail.empty')} />
          ) : flat ? (
            <FlatSessionList
              scopeGroup={scopeGroup}
              pinned={flatView.pinned}
              rows={activeRows}
              onScope={setFlatScope}
              projects={projectRecords}
              rowState={rowState}
              onOpen={openSession}
              onNew={createInProject}
            />
          ) : (
            groups.map((group) => {
              const collapsed = collapsedKeys.has(group.slot)
              const page = pageOf(group)
              const rows = collapsed ? [] : page.rows
              return (
                <div
                  key={group.slot}
                  className="v3-group"
                  data-collapsed={collapsed ? '1' : undefined}
                  data-move-cwd={group.key !== 'pinned' && group.cwd ? group.cwd : undefined}
                  data-move-project={group.projectId}
                  data-move-label={group.label}
                >
                  <ProjectHeader
                    group={group}
                    record={group.projectId ? projectRecords.find((project) => project.id === group.projectId) : undefined}
                    collapsed={collapsed}
                    onToggle={() => setCollapsedKeys((prev) => toggleKey(prev, group.slot))}
                    onNew={(projectId) => createInProject(group, projectId)}
                  />
                  {rows.map((item) => {
                    const row = rowState(item)
                    return (
                      <SidebarRow
                        key={item.path}
                        item={item}
                        title={row.title}
                        isCurrent={row.isCurrent}
                        status={row.status}
                        code={row.code}
                        onOpen={openSession}
                      />
                    )
                  })}
                  {!collapsed && group.list.length > GROUP_PAGE_SIZE ? (
                    <ListRow
                      className="v3-show-more"
                      aria-expanded={page.expanded}
                      aria-label={
                        page.expanded
                          ? own.showLessLabel.replace('{group}', group.label)
                          : own.showMoreLabel.replace('{n}', String(page.revealable)).replace('{group}', group.label)
                      }
                      onClick={(event) => showMore(group, event.detail === 0)}
                      data-testid="v3-group-more"
                    >
                      {page.expanded ? own.showLess : own.showMore.replace('{n}', String(page.revealable))}
                    </ListRow>
                  ) : null}
                </div>
              )
            })
          )}
          <SnoozeShelf rows={snoozedRows.map(rowState)} now={snoozeNow} onOpen={openSnoozed} />
          </div>
        )}
        {showArchived ? null : (
          <ContentMatches
            query={query}
            state={contentState}
            matches={contentMatches}
            currentPath={currentSessionFile}
            text={own}
            onOpen={(match) => openSession({ id: match.id ?? '', path: match.path })}
          />
        )}
        {query && total === 0 && !contentVisible ? <span className="v3-visually-hidden" aria-live="polite">{t('rail.noMatch')}</span> : null}
        <span className="v3-visually-hidden" role="status">{announcement}</span>
      </nav>

      {flat && !showArchived && (workingRows.length || showShelf) ? (
        <div className="v3-flat-shelves">
          <WorkingShelf entries={workingRows} rowState={rowState} onOpen={openSession} />
          {showShelf ? (
            <ArchiveShelf
              rows={archivedView.sessions.map(rowState)}
              total={archivedCount}
              onOpen={openSession}
              onShowAll={() => setShowArchived(true)}
              renderRow={archivedSlimRow}
              emphasized
            />
          ) : null}
        </div>
      ) : null}

      {showShelf && !flat ? (
        <ArchiveShelf
          rows={archivedView.sessions.map(rowState)}
          total={archivedCount}
          onOpen={openSession}
          onShowAll={() => setShowArchived(true)}
        />
      ) : null}

      {showArchived ? (
        <ListRow
          className="v3-archive-toggle"
          icon={<Archive size={16} />}
          aria-pressed={showArchived}
          onClick={() => setShowArchived((value) => !value)}
          data-testid="v3-archive-toggle"
        >
          {showArchived ? own.archivedBack : own.archivedEntryCount.replace('{n}', String(archivedCount))}
        </ListRow>
      ) : null}

      <div className="v3-side-foot">
        <span className="v3-side-user" title={userName} data-testid="v3-side-user">
          <span className="v3-side-avatar"><Avatar name={userName} /></span>
          <span className="v3-side-user-name">{userName}</span>
        </span>
        {connBroken ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={retrying}
              data-testid="v3-conn-retry"
              onPress={() => {
                setRetrying(true)
                void window.yan.start().then(() => refreshSessions()).catch(() => undefined).finally(() => setRetrying(false))
              }}
            >
              {t('conn.retry')}
            </Button>
            <IconButton aria-label={own.connectionSettings} tooltip={own.connectionSettings} onPress={() => useStore.getState().openSettings('devices')} data-testid="v3-conn-settings">
              <Unplug size={16} />
            </IconButton>
          </>
        ) : null}
        <span className="v3-side-conn" role="status" aria-label={connLabel} title={connDetail ? `${connLabel}\n${connDetail}` : connLabel} data-testid="v3-side-conn">
          <StatusDot kind={connDot} />
        </span>
        {onSettings ? (
          <IconButton aria-label={text.settingsEntryHint} tooltip={text.settingsEntryHint} onPress={onSettings} data-testid="v3-side-settings">
            <Settings size={16} />
          </IconButton>
        ) : null}
      </div>

      <ModalOverlay isDismissable isOpen={!!folderDrop} onOpenChange={(open) => { if (!open) setFolderDrop(null) }}>
        <Modal>
          <Dialog title={own.moveDropTitle.replace('{folder}', folderDrop?.label ?? '')} closeLabel={text.cancel} data-testid="v3-session-folder-drop">
            <div className="v3-confirm">
              <p className="v3-confirm-body">{own.moveDropBody.replace('{name}', folderDrop?.item.title ?? '')}</p>
              {folderDrop?.projectId ? <p className="v3-confirm-body">{own.moveDropOwnerOnly} · {own.moveDropOwnerOnlyHint}</p> : null}
              <p className="v3-confirm-body">{own.moveDropWithCwd} · {own.moveDropWithCwdHint.replace('{cwd}', folderDrop?.cwd ?? '')}</p>
              <DialogFooter>
                <Button variant="secondary" onPress={() => setFolderDrop(null)}>{text.cancel}</Button>
                {folderDrop?.projectId ? (
                  <Button variant="secondary" onPress={() => applyFolderDrop(false)} data-testid="v3-session-folder-drop-owner">
                    {own.moveDropOwnerOnly}
                  </Button>
                ) : null}
                <Button variant="primary" onPress={() => applyFolderDrop(true)} data-testid="v3-session-folder-drop-cwd">
                  {own.moveDropWithCwd}
                </Button>
              </DialogFooter>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </aside>
  )
})
