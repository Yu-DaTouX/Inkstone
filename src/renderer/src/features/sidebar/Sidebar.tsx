import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Activity, Archive, CalendarClock, FileDiff, PanelLeftClose, Settings, SquarePen } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { IconButton, SearchField } from '../../ui'
import { IconTip } from '../../app/IconTip'
import { BrandMark } from './BrandMark'
import { v3Text } from '../../app/v3-text'
import type { SessionSummary } from '../../../../shared/ipc'
import { buildArchivedView, buildSidebarGroups, latestRunForSession, type SidebarGroup } from './sidebar-model'
import { isUnreadRun, phaseWord, runTone, useRunsV3 } from '../../state/runs-v3'
import { ArchivedView } from './ArchivedView'
import { ProjectHeader } from './ProjectHeader'
import { SidebarRow } from './SidebarRow'
import { sidebarText } from './sidebar-text'
import './Sidebar.css'

const GROUP_LIMIT = 5

function toggleKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

interface Props {
  preview?: boolean
  onPin?: () => void
  onPointerLeave?: () => void
  onClose?: () => void
  onRuns?: () => void
  onSchedule?: () => void
  onReview?: () => void
  onSettings?: () => void
}

export const Sidebar = memo(function Sidebar({ onClose, onRuns, onSchedule, onReview, onSettings, preview, onPin, onPointerLeave }: Props): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const own = sidebarText(lang)
  const asideRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const revealedRef = useRef('')

  const sessions = useStore((s) => s.sessions)
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const runners = useStore((s) => s.runners)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const runs = useRunsV3((s) => s.runs)
  const conn = useStore((s) => s.conn)
  const newSession = useStore((s) => s.newSession)
  const switchSession = useStore((s) => s.switchSession)
  const refreshSessions = useStore((s) => s.refreshSessions)
  const messageCount = useStore((s) => s.messages.length)
  const currentSessionFile = useStore((s) => s.session?.sessionFile)
  const route = useUiV3((s) => s.route.name)

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

  const isCurrentItem = (item: SessionSummary): boolean =>
    session?.sessionId === item.id || (!!session?.sessionFile && session.sessionFile === item.path)

  const currentKey = session?.sessionId ?? session?.sessionFile ?? ''
  useEffect(() => {
    if (!currentKey || revealedRef.current === currentKey) return
    const group = groups.find((g) => g.list.some((item) => isCurrentItem(item)))
    if (!group) return
    revealedRef.current = currentKey
    setCollapsedKeys((prev) => (prev.has(group.key) ? toggleKey(prev, group.key) : prev))
  }, [currentKey, groups, session?.sessionId, session?.sessionFile])

  const visibleRows = (group: SidebarGroup): SessionSummary[] => {
    if (expandedKeys.has(group.key) || group.list.length <= GROUP_LIMIT) return group.list
    const head = group.list.slice(0, GROUP_LIMIT)
    const current = group.list.find((item) => isCurrentItem(item))
    return current && !head.includes(current) ? [...head, current] : head
  }

  useEffect(() => {
    let frame = 0
    const focus = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const input = asideRef.current?.querySelector('input')
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

  const createInProject = (group: SidebarGroup): void => {
    if (!group.projectId) return
    useUiV3.getState().navigate({ name: 'chat' })
    void newSession({ cwd: group.cwd, projectId: group.projectId, scope: 'project' })
  }

  const connLabel = conn === 'ready' ? t('conn.ready') : conn === 'starting' ? t('conn.starting') : t('conn.down')

  return (
    <aside className="v3-side" ref={asideRef} aria-label={text.sidebarLabel} data-testid="v3-sidebar" onPointerLeave={onPointerLeave}>
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
        <SearchField aria-label={t('rail.search')} value={query} onChange={setQuery} data-testid="v3-search" />
      </div>

      <div className="v3-side-entries">
        <button type="button" className="v3-entry" onClick={createGlobal} data-testid="v3-nav-new-chat">
          <SquarePen size={16} aria-hidden />
          <span className="v3-entry-label">{own.newChat}</span>
        </button>
        {onSchedule ? (
          <button type="button" className="v3-entry" onClick={onSchedule} aria-current={route === 'schedule' ? 'true' : undefined} data-testid="v3-schedule-entry">
            <CalendarClock size={16} aria-hidden />
            <span className="v3-entry-label">{text.schedule}</span>
          </button>
        ) : null}
        {onReview ? (
          <button type="button" className="v3-entry" onClick={onReview} aria-current={route === 'review' ? 'true' : undefined} data-testid="v3-review-entry">
            <FileDiff size={16} aria-hidden />
            <span className="v3-entry-label">{text.review}</span>
          </button>
        ) : null}
        {onRuns ? (
          <button type="button" className="v3-entry" onClick={onRuns} aria-current={route === 'runs' ? 'true' : undefined} data-testid="v3-runs-entry">
            <Activity size={16} aria-hidden />
            <span className="v3-entry-label">{own.runRecords}</span>
          </button>
        ) : null}
      </div>

      <nav className="v3-side-list">
        {showArchived ? (
          <ArchivedView
            view={archivedView}
            titleOf={(item) => manualTitles[item.id] ?? titles[item.id] ?? item.title}
            onOpen={openSession}
          />
        ) : groups.length === 0 ? (
          <p className="v3-side-empty">{query ? t('rail.noMatch') : t('rail.empty')}</p>
        ) : (
          groups.map((group) => {
            const collapsed = collapsedKeys.has(group.key)
            const expanded = expandedKeys.has(group.key)
            const rows = collapsed ? [] : visibleRows(group)
            return (
              <div key={group.key} className="v3-group" data-collapsed={collapsed ? '1' : undefined}>
                <ProjectHeader
                  group={group}
                  record={group.projectId ? projectRecords.find((project) => project.id === group.projectId) : undefined}
                  collapsed={collapsed}
                  onToggle={() => setCollapsedKeys((prev) => toggleKey(prev, group.key))}
                  onNew={() => createInProject(group)}
                />
                {rows.map((item) => {
                  const isCurrent = isCurrentItem(item)
                  const title = manualTitles[item.id] ?? titles[item.id] ?? item.title
                  const run = latestRunForSession(runs, { id: item.id, path: item.path })
                  const tone = run ? runTone(run.phase) : 'idle'
                  const word = run && (tone === 'ask' || tone === 'stall' || tone === 'fail') ? phaseWord(lang, run.phase) : null
                  return (
                    <SidebarRow
                      key={item.path}
                      item={item}
                      title={title}
                      isCurrent={isCurrent}
                      phase={run?.phase ?? null}
                      unread={run ? isUnreadRun(run) : false}
                      code={run?.code}
                      word={word}
                      tone={tone}
                      onOpen={() => openSession(item)}
                    />
                  )
                })}
                {!collapsed && group.list.length > GROUP_LIMIT ? (
                  <button
                    type="button"
                    className="v3-show-more"
                    aria-expanded={expanded}
                    onClick={() => setExpandedKeys((prev) => toggleKey(prev, group.key))}
                    data-testid="v3-group-more"
                  >
                    {expanded ? own.showLess : own.showMore}
                  </button>
                ) : null}
              </div>
            )
          })
        )}
        {query && total === 0 ? <span className="v3-visually-hidden" aria-live="polite">{t('rail.noMatch')}</span> : null}
      </nav>

      {archivedCount > 0 || showArchived ? (
        <button
          type="button"
          className="v3-archive-toggle"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((value) => !value)}
          data-testid="v3-archive-toggle"
        >
          <Archive size={14} aria-hidden />
          <span className="v3-entry-label">
            {showArchived ? own.archivedBack : own.archivedEntryCount.replace('{n}', String(archivedCount))}
          </span>
        </button>
      ) : null}

      <div className="v3-side-foot">
        {onSettings ? (
          <IconTip label={text.settingsEntryHint}>
            <IconButton aria-label={text.settingsEntryHint} onPress={onSettings} data-testid="v3-side-settings">
              <Settings size={16} />
            </IconButton>
          </IconTip>
        ) : null}
        <span className="v3-side-conn" title={connLabel}>
          <span className={`v3-conn-dot v3-conn-dot-${conn}`} aria-hidden />
          {connLabel}
        </span>
      </div>
    </aside>
  )
})
