import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Archive, CirclePlus, Clock, PanelLeftClose, Search, Settings, SquarePen, Unplug, Users } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { Avatar, Button, EmptyState, IconButton, SearchField, StatusDot, type StatusDotKind } from '../../ui'
import { IconTip } from '../../app/IconTip'
import { BrandMark } from './BrandMark'
import { v3Text } from '../../app/v3-text'
import type { SessionSummary } from '../../../../shared/ipc'
import { GROUP_PAGE_SIZE, buildArchivedView, buildSidebarGroups, groupPage, latestRunForSession, type SidebarGroup } from './sidebar-model'
import { isUnreadRun, useRunsV3 } from '../../state/runs-v3'
import { useSplitView } from '../../state/split-view'
import { useNarrowLayout } from '../workbench/tool-tiles'
import { ArchivedView } from './ArchivedView'
import { ProjectHeader } from './ProjectHeader'
import { SidebarRow } from './SidebarRow'
import { sidebarText } from './sidebar-text'
import { collabText } from '../collab/collab-text'
import { ContentMatches, useContentSearch } from './ContentMatches'
import { buildContentMatches } from './content-search'
import { paneShowsSession, sessionStatusKind, sessionUnread, visiblePaneSessions } from './session-status'
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
  onSettings?: () => void
  onSearch?: () => void
}

export const Sidebar = memo(function Sidebar({ onClose, onSchedule, onCollab, onSettings, onSearch, preview, onPin }: Props): ReactElement {
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

  const sessions = useStore((s) => s.sessions)
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const runners = useStore((s) => s.runners)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const runs = useRunsV3((s) => s.runs)
  const conn = useStore((s) => s.conn)
  const connDetail = useStore((s) => s.connDetail)
  const [retrying, setRetrying] = useState(false)
  const newSession = useStore((s) => s.newSession)
  const switchSession = useStore((s) => s.switchSession)
  const refreshSessions = useStore((s) => s.refreshSessions)
  const messageCount = useStore((s) => s.messages.length)
  const currentSessionFile = useStore((s) => s.session?.sessionFile)
  const route = useUiV3((s) => s.route.name)
  const split = useSplitView((s) => s.split)
  const narrowPanes = useNarrowLayout()
  const paneSessions = useMemo(() => (route === 'chat' ? visiblePaneSessions(split, narrowPanes) : []), [route, split, narrowPanes])

  useEffect(() => {
    const id = window.setTimeout(() => void refreshSessions(), 800)
    return () => window.clearTimeout(id)
  }, [messageCount, currentSessionFile, refreshSessions])

  const activeRunner = runners.find((r) => r.id === activeRunnerId || r.runId === activeRunnerId)
  const currentProjectId = activeRunner?.projectId
  const currentCwd = activeRunner?.cwd || session?.cwd

  const groups = useMemo(
    () =>
      buildSidebarGroups({
        sessions,
        query,
        projects: settings?.projects ?? [],
        projectNames: settings?.projectNames ?? {},
        currentProjectId,
        currentCwd,
        titles,
        manualTitles,
        pinnedLabel: text.pinnedGroup
      }),
    [sessions, query, settings?.projects, settings?.projectNames, currentProjectId, currentCwd, titles, manualTitles, text.pinnedGroup]
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
    session?.sessionId === item.id || (!!session?.sessionFile && session.sessionFile === item.path)

  const currentKey = session?.sessionId ?? session?.sessionFile ?? ''
  useEffect(() => {
    if (!currentKey || revealedRef.current === currentKey) return
    const group = groups.find((g) => g.list.some((item) => isCurrentItem(item)))
    if (!group) return
    revealedRef.current = currentKey
    setCollapsedKeys((prev) => (prev.has(group.slot) ? toggleKey(prev, group.slot) : prev))
  }, [currentKey, groups, session?.sessionId, session?.sessionFile])

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

  const openSession = (item: { id: string; path: string }): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void switchSession(item.path).then(() => {
      if (useStore.getState().peekedPath !== item.path) return
      const run = latestRunForSession(useRunsV3.getState().runs, item)
      if (run && isUnreadRun(run)) useRunsV3.getState().requestMarkSeen(run.runId)
    })
  }

  const createGlobal = (): void => {
    useUiV3.getState().navigate({ name: 'chat' })
    void newSession({ scope: 'global' })
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

  return (
    <aside className="v3-side" ref={asideRef} aria-label={text.sidebarLabel} data-testid="v3-sidebar">
      <div className="v3-side-top">
        <span className="v3-side-brand">
          <BrandMark size={16} decorative />
          <span className="v3-side-name">Inkstone</span>
        </span>
        <div className="v3-side-top-actions">
          <IconTip label={text.newChatShortcut}>
            <IconButton aria-label={text.newChatShortcut} onPress={createGlobal} data-testid="v3-new-chat">
              <SquarePen size={16} />
            </IconButton>
          </IconTip>
          {onClose ? (
            <IconTip label={text.toggleSidebar}>
              <IconButton aria-label={preview ? (lang === 'en-US' ? 'Pin session list' : '固定会话列表') : text.toggleSidebar} onPress={preview ? onPin : onClose} data-testid="v3-side-close">
                <PanelLeftClose size={16} />
              </IconButton>
            </IconTip>
          ) : null}
        </div>
      </div>

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
          <button type="button" className="ui-row ui-row--field" aria-label={own.searchHint} title={own.searchHint} onClick={onSearch} data-testid="v3-search-open">
            <span className="ui-row__lead"><Search size={16} aria-hidden /></span>
            <span className="ui-row__label">{own.search}</span>
          </button>
        )}
      </div>

      <div className="v3-side-entries">
        <button type="button" className="ui-row" onClick={createGlobal} data-testid="v3-nav-new-chat">
          <span className="ui-row__lead"><CirclePlus size={16} aria-hidden /></span>
          <span className="ui-row__label">{own.newChat}</span>
        </button>
        {onSchedule ? (
          <button type="button" className="ui-row" onClick={onSchedule} aria-current={route === 'schedule' ? 'page' : undefined} data-testid="v3-schedule-entry">
            <span className="ui-row__lead"><Clock size={16} aria-hidden /></span>
            <span className="ui-row__label">{text.schedule}</span>
          </button>
        ) : null}
        {onCollab ? (
          <button type="button" className="ui-row" onClick={onCollab} aria-current={route === 'collab' ? 'page' : undefined} data-testid="v3-collab-entry">
            <span className="ui-row__lead"><Users size={16} aria-hidden /></span>
            <span className="ui-row__label">{collabText(lang).nav}</span>
          </button>
        ) : null}
      </div>

      <nav className="v3-side-list" ref={listRef} data-scrolled={scrolled ? '1' : undefined}>
        {showArchived ? (
          <ArchivedView
            view={archivedView}
            titleOf={(item) => manualTitles[item.id] ?? titles[item.id] ?? item.title}
            onOpen={openSession}
          />
        ) : groups.length === 0 && !contentVisible ? (
          <EmptyState size="sm" title={query ? t('rail.noMatch') : t('rail.empty')} />
        ) : (
          groups.map((group) => {
            const collapsed = collapsedKeys.has(group.slot)
            const page = pageOf(group)
            const rows = collapsed ? [] : page.rows
            return (
              <div key={group.slot} className="v3-group" data-collapsed={collapsed ? '1' : undefined}>
                <ProjectHeader
                  group={group}
                  record={group.projectId ? projectRecords.find((project) => project.id === group.projectId) : undefined}
                  collapsed={collapsed}
                  onToggle={() => setCollapsedKeys((prev) => toggleKey(prev, group.slot))}
                  onNew={(projectId) => createInProject(group, projectId)}
                />
                {rows.map((item) => {
                  const isCurrent = isCurrentItem(item)
                  const title = manualTitles[item.id] ?? titles[item.id] ?? item.title
                  const run = latestRunForSession(runs, { id: item.id, path: item.path })
                  const paneSelected = isCurrent || paneShowsSession(paneSessions, item)
                  const unread = run ? sessionUnread({ unread: isUnreadRun(run), paneSelected }) : false
                  const status = sessionStatusKind({ phase: run?.phase ?? null, unread, archived: !!item.archivedAt })
                  return (
                    <SidebarRow
                      key={item.path}
                      item={item}
                      title={title}
                      isCurrent={isCurrent}
                      status={status}
                      code={run?.code}
                      onOpen={() => openSession(item)}
                    />
                  )
                })}
                {!collapsed && group.list.length > GROUP_PAGE_SIZE ? (
                  <button
                    type="button"
                    className="ui-row v3-show-more"
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
                  </button>
                ) : null}
              </div>
            )
          })
        )}
        {showArchived ? null : (
          <ContentMatches
            query={query}
            state={contentState}
            matches={contentMatches}
            currentPath={session?.sessionFile}
            text={own}
            onOpen={(match) => openSession({ id: match.id ?? '', path: match.path })}
          />
        )}
        {query && total === 0 && !contentVisible ? <span className="v3-visually-hidden" aria-live="polite">{t('rail.noMatch')}</span> : null}
        <span className="v3-visually-hidden" role="status">{announcement}</span>
      </nav>

      {archivedCount > 0 || showArchived ? (
        <button
          type="button"
          className="ui-row v3-archive-toggle"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((value) => !value)}
          data-testid="v3-archive-toggle"
        >
          <span className="ui-row__lead"><Archive size={16} aria-hidden /></span>
          <span className="ui-row__label">
            {showArchived ? own.archivedBack : own.archivedEntryCount.replace('{n}', String(archivedCount))}
          </span>
        </button>
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
            <IconTip label={own.connectionSettings}>
              <IconButton aria-label={own.connectionSettings} onPress={() => useStore.getState().openSettings('devices')} data-testid="v3-conn-settings">
                <Unplug size={16} />
              </IconButton>
            </IconTip>
          </>
        ) : null}
        <span className="v3-side-conn" role="status" aria-label={connLabel} title={connDetail ? `${connLabel}\n${connDetail}` : connLabel} data-testid="v3-side-conn">
          <StatusDot kind={connDot} />
        </span>
        {onSettings ? (
          <IconTip label={text.settingsEntryHint}>
            <IconButton aria-label={text.settingsEntryHint} onPress={onSettings} data-testid="v3-side-settings">
              <Settings size={16} />
            </IconButton>
          </IconTip>
        ) : null}
      </div>
    </aside>
  )
})
