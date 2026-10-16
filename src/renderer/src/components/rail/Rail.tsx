import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { ContextMenu } from '../common/ContextMenu'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import { RailUser } from './RailUser'
import { ancestorPaths, useSidebarJson, useSidebarValue } from './sidebar-state'
import { RailViewMenu } from './RailViewMenu'
import { buildRailSections, DEFAULT_RAIL_VIEW, normalizeRailView, type RailRunState } from '../../../../shared/rail-view'
import { buildBranchIndex } from '../../../../shared/session-map'
import { RunDot } from '../ui'
import { type TrashNotice, TrashNoticeBar, SessionDeleteDialog, ProjectRemoveDialog } from './RailDialogs'
import { SessionRow } from './SessionRow'
import { useRailDrag } from './useRailDrag'
import { useRailProjects } from './useRailProjects'
import { ProjectDirectoryDialog } from './ProjectDirectoryDialog'

const PROJECT_PREVIEW = 5
const SESSION_PREVIEW = 5
const RECENT_PREVIEW = 5
const EMPTY_PROJECT_NAMES: Record<string, string> = {}

export function Rail() {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const session = useStore((s) => s.session)
  const viewingPath = useStore((s) => s.peekedPath ?? s.session?.sessionFile)
  const switchSession = useStore((s) => s.switchSession)
  const newSession = useStore((s) => s.newSession)
  const refreshSessions = useStore((s) => s.refreshSessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const settings = useStore((s) => s.settings)
  const projectNames = settings?.projectNames ?? EMPTY_PROJECT_NAMES
  const projectRecords = settings?.projects ?? []
  const projectGroups = settings?.projectGroups ?? []
  const patchSettings = useStore((s) => s.patchSettings)

  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [projectsOpen, setProjectsOpen] = useSidebarValue('projects-open', true)
  const [collapsed, setCollapsed] = useSidebarValue<string[]>('collapsed-projects', [])
  const [shownAllSessions, setShownAllSessions] = useSidebarValue<string[]>('expanded-sessions', [])
  const railPinned = useStore((s) => s.railPinned)
  const railWasPinned = useRef(railPinned)
  useEffect(() => {
    if (railWasPinned.current && !railPinned) {
      setShownAllSessions([])
      setMenuFor(null)
      setProjectMenu(null)
      setGroupMenu(null)
    }
    railWasPinned.current = railPinned
  }, [railPinned, setShownAllSessions])
  const [expanded, setExpanded] = useSidebarValue<string[]>('expanded-branches', [])
  const pinned = useMemo(() => sessions.filter((s) => s.pinned).map((s) => s.path), [sessions])
  const [viewRaw, setViewRaw] = useSidebarJson('view', DEFAULT_RAIL_VIEW)
  const view = useMemo(() => normalizeRailView(viewRaw), [viewRaw])
  const projectMode = view.group === 'project'
  const showArchivedSessions = view.show === 'archived'
  const visibleSessions = useMemo(() => sessions.filter((s) => showArchivedSessions === !!s.archivedAt), [sessions, showArchivedSessions])

  const pinMigrated = useRef(false)
  useEffect(() => {
    if (pinMigrated.current || sessions.length === 0) return
    pinMigrated.current = true
    let legacy: string[] = []
    try {
      const parsed = JSON.parse(localStorage.getItem('yan.sidebar.pinned') ?? 'null')
      legacy = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch { }
    if (!legacy.length) return
    const todo = sessions.filter((s) => legacy.includes(s.path) && !s.pinned)
    void (async () => {
      let failed = false
      for (const s of todo) {
        const res = await window.yan.setSessionPinned(s.id, true).catch(() => ({ ok: false }))
        if (!res.ok) failed = true
      }
      if (!failed) { try { localStorage.removeItem('yan.sidebar.pinned') } catch { } }
      await refreshSessions()
    })()
  }, [sessions, refreshSessions])
  const archived = useMemo(() => projectRecords.filter((p) => p.archived).map((p) => p.cwd), [projectRecords])
  const [showArchived, setShowArchived] = useState(false)
  const [unread, setUnread] = useSidebarValue<string[]>('unread', [])
  const runners = useStore((s) => s.runners)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const runningIn = useMemo(() => {
    const files = new Set(runners.filter((r) => r.running && r.sessionFile).map((r) => r.sessionFile!))
    return (list: SessionSummary[]): number => list.filter((s) => files.has(s.path)).length
  }, [runners])

  const recentSessions = useMemo(
    () => visibleSessions
      .filter((s) => (s.lastOpenedAt ?? 0) > 0 && !pinned.includes(s.path) && !archived.includes(s.cwd))
      .sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt))
      .slice(0, RECENT_PREVIEW),
    [visibleSessions, pinned, archived]
  )

  const flatSections = useMemo(() => {
    if (projectMode) return []
    const q = query.trim().toLowerCase()
    const byFile = new Map(runners.filter((r) => !!r.sessionFile).map((r) => [r.sessionFile!, r]))
    const items = visibleSessions
      .filter((s) => (showArchivedSessions || !pinned.includes(s.path)) && !archived.includes(s.cwd))
      .map((s) => ({ ...s, title: manualTitles[s.id] || titles[s.id] || s.title }))
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q))
    const stateOf = (s: SessionSummary): RailRunState => {
      const r = byFile.get(s.path)
      return r?.waiting ? 'waiting' : r?.failed ? 'failed' : r?.running ? 'running' : 'idle'
    }
    return buildRailSections(items, view, stateOf, Date.now())
  }, [projectMode, query, visibleSessions, showArchivedSessions, pinned, archived, manualTitles, titles, runners, view])

  const [menuFor, setMenuFor] = useState<{ key: string; path: string; x: number; y: number; trigger: HTMLElement | null } | null>(null)
  const [projRename, setProjRename] = useState<string | null>(null)
  const [projDraft, setProjDraft] = useState('')
  const [projectMenu, setProjectMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement | null } | null>(null)
  const [projectError, setProjectError] = useState('')
  const patchRailSettings = async (patch: Parameters<typeof patchSettings>[0]): Promise<boolean> => {
    try { await patchSettings(patch); setProjectError(''); return true }
    catch (cause) { setProjectError(cause instanceof Error ? cause.message : t('rail.projectError')); return false }
  }
  const [groupingProject, setGroupingProject] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  const [groupRename, setGroupRename] = useState<string | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement | null } | null>(null)
  const [groupError, setGroupError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)
  const [projectToRemove, setProjectToRemove] = useState<{ id: string; name: string } | null>(null)
  const [projectDirectoryEdit, setProjectDirectoryEdit] = useState<ProjectRecord | null>(null)
  const [trashNotice, setTrashNotice] = useState<TrashNotice | null>(null)

  const undoTrash = async (): Promise<void> => {
    const n = trashNotice
    if (!n || n.busy || n.restored || !n.token) return
    setTrashNotice({ ...n, busy: true, error: '' })
    const res = await window.yan.restoreSession(n.token)
    if (!res.ok) {
      setTrashNotice({ ...n, busy: false, error: res.error ?? t('rail.deleteFailed') })
      return
    }
    await refreshSessions()
    setTrashNotice({ ...n, busy: false, restored: true })
  }

  useEffect(() => {
    if (!trashNotice || trashNotice.busy) return
    const id = setTimeout(() => setTrashNotice(null), trashNotice.restored ? 2600 : 30_000)
    return () => clearTimeout(id)
  }, [trashNotice])

  useEffect(() => {
    const clearCurrent = (): void => {
      const path = useStore.getState().peekedPath ?? useStore.getState().session?.sessionFile
      if (path) setUnread((prev) => prev.includes(path) ? prev.filter((p) => p !== path) : prev)
    }
    window.addEventListener('focus', clearCurrent)
    return () => window.removeEventListener('focus', clearCurrent)
  }, [setUnread])

  const runnersSeen = useRef<Map<string, boolean>>(new Map())
  useEffect(() => {
    const prev = runnersSeen.current
    const next = new Map<string, boolean>()
    for (const r of runners) {
      if (!r.sessionFile) continue
      next.set(r.sessionFile, r.running)
      if (prev.get(r.sessionFile) === true && !r.running && !document.hasFocus()) {
        setUnread((old) => (old.includes(r.sessionFile!) ? old : [...old, r.sessionFile!]))
      }
    }
    runnersSeen.current = next
  }, [runners, setUnread])

  const msgCount = useStore((s) => s.messages.length)
  useEffect(() => {
    if (msgCount === 0) return
    const id = setTimeout(() => void refreshSessions(), 800)
    return () => clearTimeout(id)
  }, [msgCount, refreshSessions])

  useEffect(() => {
    if (!menuFor && !projectMenu && !groupMenu) return
    const close = (): void => { setMenuFor(null); setProjectMenu(null); setGroupMenu(null) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuFor, projectMenu, groupMenu])

  const { projects, displayProjects } = useRailProjects({ query, showArchived, sortBy: view.sort, showArchivedSessions })

  const [projectsExpanded, setProjectsExpanded] = useState<boolean | null>(null)

  const currentOutOfPreview = useMemo(() => {
    const i = displayProjects.findIndex((p) => p.isCurrent)
    return i >= PROJECT_PREVIEW
  }, [displayProjects])

  const showAllProjects = !!query || (projectsExpanded ?? currentOutOfPreview)
  const shownProjects = showAllProjects ? displayProjects : displayProjects.slice(0, PROJECT_PREVIEW)
  const hiddenProjects = Math.max(0, displayProjects.length - PROJECT_PREVIEW)

  const { dragItem, dropHint, dropInto, beginDrag, consumeDragClick } = useRailDrag({
    query, projectsOpen, displayProjects, projectRecords, projectGroups, patchSettings,
    expandAllProjects: () => setProjectsExpanded(true)
  })

  useEffect(() => {
    setProjectsExpanded(null)
  }, [session?.cwd])

  const groupRunning = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of displayProjects) {
      const gid = projectRecords.find((r) => r.cwd === p.cwd)?.groupId
      if (!gid) continue
      m.set(gid, (m.get(gid) ?? 0) + runningIn(p.list))
    }
    return m
  }, [displayProjects, projectRecords, runningIn])

  const { branchIndex } = useMemo(() => buildBranchIndex(sessions), [sessions])

  const toggleProject = (key: string): void =>
    setCollapsed((prev) => prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key])
  const saveRename = async (cwd: string): Promise<void> => {
    const name = projDraft.trim()
    if (!name) { setProjRename(null); return }
    try {
      await patchSettings({ projectNames: { ...projectNames, [cwd]: name } })
      setProjectError('')
      setProjRename(null)
    } catch {
      setProjectError(t('rail.renameFailed', { name }))
    }
  }
  const saveGroupRename = async (id: string): Promise<void> => {
    const group = projectGroups.find((g) => g.id === id)
    if (!group) { setGroupRename(null); return }
    const name = groupDraft.trim()
    if (!name) { setGroupError(t('rail.groupNameEmpty')); return }
    if (name === group.name) { setGroupError(''); setGroupRename(null); return }
    if (projectGroups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) {
      setGroupError(t('rail.groupNameTaken', { name }))
      return
    }
    try {
      await patchSettings({
        projectGroups: projectGroups.map((g) => (g.id === id ? { ...g, name } : g))
      })
      setGroupError('')
      setGroupRename(null)
    } catch {
      setGroupError(t('rail.groupRenameFailed', { name }))
    }
  }

  const dissolveGroup = async (id: string): Promise<void> => {
    try {
      await patchSettings({
        projectGroups: projectGroups.filter((g) => g.id !== id),
        projects: projectRecords.map((r) => (r.groupId === id ? { ...r, groupId: undefined } : r))
      })
      setGroupError('')
      setGroupMenu(null)
    } catch {
      setGroupError(t('rail.groupRenameFailed', { name: '' }))
    }
  }

  const switchProject = async (cwd: string, projectId?: string): Promise<void> => {
    const activeProjectId = runners.find((runner) => runner.id === activeRunnerId)?.projectId
    if (cwd === session?.cwd && projectId === activeProjectId) return
    const res = await window.yan.setCwd(cwd)
    if (!res.ok) {
      setProjectError(res.error || t('rail.projectError'))
      return
    }
    setProjectError('')
    const store = useStore.getState()
    await store.refreshSessions()
    const target = store.pickProjectSession(cwd, projectId)
    if (target) await store.switchSession(target)
    else await store.newSession({ cwd, ...(projectId ? { projectId } : {}), scope: projectId ? 'project' : 'global' })
    await store.refreshSessions()
  }

  const toggleBranch = (key: string): void =>
    setExpanded((prev) => prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key])
  const select = async (path: string): Promise<void> => {
    const parents = new Map(sessions.filter((s) => s.parentSession).map((s) => [s.path, s.parentSession!]))
    if (!query) setExpanded((prev) => [...new Set([...prev, ...ancestorPaths(path, parents)])])
    await switchSession(path)
    setUnread((prev) => prev.filter((p) => p !== path))
  }
  const openSessionMenu = (key: string, path: string) => (trigger: HTMLElement | null, point?: { x: number; y: number }): void => {
    if (menuFor?.key === key) { setMenuFor(null); return }
    const rect = trigger?.getBoundingClientRect()
    setMenuFor({ key, path, x: point?.x ?? rect?.left ?? 0, y: point?.y ?? rect?.bottom ?? 0, trigger })
  }
  const closeSessionMenu = (): void => {
    const trigger = menuFor?.trigger
    setMenuFor(null)
    trigger?.focus?.()
  }

  const renderSession = (s: SessionSummary, list: SessionSummary[], depth = 0, lineage = new Set<string>(), containerKey = ''): React.ReactNode => {
    if (lineage.has(s.path)) return null
    const next = new Set(lineage).add(s.path)
    const children = list.filter((c) => c.parentSession === s.path && !next.has(c.path))
    const isOpen = !!query || expanded.includes(s.path)
    const instanceKey = `${containerKey}|${s.path}`
    return <SessionRow key={s.path} s={s} selected={viewingPath === s.path}
      depth={depth} branchCount={children.length} branchIndex={branchIndex.get(s.path)}
      branchesOpen={isOpen} onToggleBranches={() => toggleBranch(s.path)}
      children={isOpen ? children.map((c) => renderSession(c, list, depth + 1, next, containerKey)) : null}
      menuOpen={menuFor?.key === instanceKey} menuAnchor={menuFor?.key === instanceKey ? menuFor : null}
      onOpenMenu={openSessionMenu(instanceKey, s.path)} onCloseMenu={closeSessionMenu}
      onSelect={() => void select(s.path)} pinned={pinned.includes(s.path)} unread={unread.includes(s.path)}
      projectRecords={projectRecords}
      dragging={dragItem?.kind === 'session' && dragItem.id === s.id}
      onDragStart={(e) => beginDrag(e, 'session', s.id, '', containerKey)}
      onPin={() => void useStore.getState().setSessionPinned(s.id, !pinned.includes(s.path))}
      archived={!!s.archivedAt} onArchive={() => void useStore.getState().setSessionArchived(s.id, !s.archivedAt)}
      onRequestDelete={() => setDeleteTarget(s)} />
  }

  const total = sessions.length
  const shown = projects.reduce((n, p) => n + p.list.length, 0)

  return (
    <aside className="rail">
      <div className="rail-top">
        <button className="rail-action" onClick={() => void newSession({ scope: 'global' })} data-testid="rail-new">
          <Icon name="plus" size={14} />
          <span>{t('rail.new')}</span>
          <kbd className="ui-kbd plain">Ctrl N</kbd>
        </button>
        <button className="rail-action" onClick={() => window.dispatchEvent(new CustomEvent('inkstone-schedule-open'))} data-testid="rail-schedule">
          <Icon name="history" size={14} />
          <span>{t('rail.schedule')}</span>
        </button>
        <div className="rail-search-row">
        <label className="rail-search">
          <Icon name="search" size={12} />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              if (query) setQuery('')
              else e.currentTarget.blur()
            }}
            placeholder={t('rail.search')}
            aria-label={t('rail.search')}
            data-testid="rail-search"
          />
          {query ? (
            <button
              className="rail-search-clear"
              onClick={() => {
                setQuery('')
                searchInputRef.current?.focus()
              }}
              title={t('rail.clear')}
              data-testid="rail-search-clear"
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </label>
        <RailViewMenu view={view} onChange={setViewRaw} />
        </div>
      </div>

      <div className="rail-section">
        <div className="rail-body">
          {projectError ? <div className="rail-empty" role="alert">{projectError}</div> : null}
          {!query && !showArchived && !showArchivedSessions && pinned.some((p) => sessions.some((s) => s.path === p && !s.archivedAt && !archived.includes(s.cwd))) ? <div className="rail-pins">
            <div className="rail-section-head"><span className="rail-label">{t('rail.pinned')}</span><span className="rail-label-line" aria-hidden /></div>
            {sessions.filter((s) => pinned.includes(s.path) && !s.archivedAt && !archived.includes(s.cwd)).map((s) => renderSession({ ...s, title: manualTitles[s.id] || titles[s.id] || s.title }, []))}
          </div> : null}
          {projectMode && !query && !showArchived && !showArchivedSessions && recentSessions.length > 0 ? <div className="rail-recent" data-testid="rail-recent">
            <div className="rail-section-head"><span className="rail-label">{t('rail.recent')}</span><span className="rail-label-line" aria-hidden /></div>
            {recentSessions.map((s) => renderSession({ ...s, title: manualTitles[s.id] || titles[s.id] || s.title }, []))}
          </div> : null}
          {projectMode && (showArchived || archived.length > 0) ? (
            <button className="rail-archive-toggle" onClick={() => setShowArchived((v) => !v)}>{showArchived ? t('rail.backProjects') : t('rail.archivedProjects', { n: archived.length })}</button>
          ) : null}
          {!projectMode ? (
            flatSections.length === 0 ? <div className="rail-empty">{query ? t('rail.noMatch') : showArchivedSessions ? t('rail.noArchived') : t('rail.empty')}</div>
              : flatSections.map((section) => <div key={section.key} className="rail-flat" data-testid={`rail-section-${section.key}`}>
                {view.group === 'none' ? null : <div className="rail-section-head"><span className="rail-label">{t(`rail.section.${section.key}`)}</span><span className="rail-label-line" aria-hidden /></div>}
                {section.items.map((s) => renderSession(s, [], 0, new Set<string>(), 'flat'))}
              </div>)
          ) : <>
          <div className="rail-section-head">
            <button
              className={`rail-label ${projectsOpen ? '' : 'collapsed'}`}
              onClick={() => setProjectsOpen((v) => !v)}
              aria-expanded={projectsOpen}
              data-testid="rail-projects-head"
            >
              {t('rail.projects')}
              <Icon name="chevron-right" size={12} className="chev" />
            </button>
            <span className="rail-label-line" aria-hidden />
            <button
              className="rail-icon sm"
              title={t('rail.addProject')}
              aria-label={t('rail.addProject')}
              onClick={async () => { const cwd = await window.yan.pickCwd(); if (!cwd) return; const r = await window.yan.setCwd(cwd); if (!r.ok) setProjectError(r.error || t('rail.projectError')); else await useStore.getState().bootstrap() }}
            >
              <Icon name="plus" size={12} />
            </button>
          </div>
          {total === 0 && projects.length === 0 ? (
            <div className="rail-empty">{t('rail.empty')}</div>
          ) : shown === 0 && projects.length === 0 ? (
            <div className="rail-empty">{showArchivedSessions && !query ? t('rail.noArchived') : t('rail.noMatch')}</div>
          ) : projectsOpen || query ? (
            shownProjects.map((p, projectIndex) => {
              const pOpen = !!query || !collapsed.includes(p.id)
              const groupId = p.projectId ? projectRecords.find((record) => record.id === p.projectId)?.groupId : undefined
              const group = groupId ? projectGroups.find((candidate) => candidate.id === groupId) : undefined
              const previous = shownProjects[projectIndex - 1]
              const previousGroupId = previous?.projectId ? projectRecords.find((record) => record.id === previous.projectId)?.groupId : undefined
              return (
                <div key={p.id} className="proj">
                  {group && groupId !== previousGroupId ? (
                    <div
                      className={`proj-group-heading${dragItem?.kind === 'group' && dragItem.id === group.id ? ' is-dragging' : ''}${dropHint?.kind === 'group' && dropHint.id === group.id ? (dropHint.after ? ' drop-after' : ' drop-before') : ''}`}
                      data-testid="rail-project-group"
                      data-group-id={group.id}
                      data-drag-kind="group"
                      data-drag-id={group.id}
                      onPointerDown={(e) => beginDrag(e, 'group', group.id)}
                      onClickCapture={(e) => {
                        if (consumeDragClick()) {
                          e.stopPropagation()
                          e.preventDefault()
                        }
                      }}
                    >
                      {groupRename === group.id ? (
                        <input
                          className="proj-rename-input group-rename-input"
                          autoFocus
                          value={groupDraft}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) => setGroupDraft(e.target.value)}
                          onBlur={() => void saveGroupRename(group.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void saveGroupRename(group.id)
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              setGroupRename(null)
                              setGroupError('')
                            }
                          }}
                          data-testid="rail-group-rename"
                        />
                      ) : (
                        <>
                          <Icon name="group" size={12} className="proj-group-ico" />
                          <span className="proj-group-name" title={group.name}>{group.name}</span>
                          {(groupRunning.get(group.id) ?? 0) > 0 ? (
                            <span
                              className="proj-group-running"
                              data-testid="rail-group-running"
                              title={t('rail.runningCount', { n: groupRunning.get(group.id) ?? 0 })}
                            >
                              <RunDot />
                              {groupRunning.get(group.id)}
                            </span>
                          ) : null}
                          <span className="spacer" />
                          <button
                            className="proj-group-act"
                            title={t('rail.groupMenu')}
                            aria-label={t('rail.groupMenu')}
                            data-testid={`rail-group-menu-${group.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              setGroupError('')
                              if (groupMenu?.id === group.id) { setGroupMenu(null); return }
                              const rect = event.currentTarget.getBoundingClientRect()
                              setGroupMenu({ id: group.id, x: rect.left, y: rect.bottom, trigger: event.currentTarget })
                            }}
                          ><Icon name="menu" size={12} /></button>
                        </>
                      )}
                    </div>
                  ) : null}
                  {group && groupId !== previousGroupId ? (
                    <ContextMenu
                      open={groupMenu?.id === group.id}
                      anchor={groupMenu?.id === group.id ? groupMenu : null}
                      testid="rail-group-menu-panel"
                      onClose={() => { const trigger = groupMenu?.trigger; setGroupMenu(null); trigger?.focus?.() }}
                      items={[
                        {
                          id: 'rail-group-rename-action',
                          label: t('rail.renameGroup'),
                          icon: 'pencil',
                          onSelect: () => {
                            setGroupDraft(group.name)
                            setGroupError('')
                            setGroupRename(group.id)
                          }
                        },
                        {
                          id: 'rail-group-dissolve',
                          label: t('rail.dissolveGroup'),
                          danger: true,
                          onSelect: () => void dissolveGroup(group.id)
                        }
                      ]}
                    />
                  ) : null}
                  {group && groupId !== previousGroupId && groupError && (groupRename === group.id || groupMenu?.id === group.id) ? (
                    <div className="rail-group-err" role="alert" data-testid="rail-group-error">{groupError}</div>
                  ) : null}
                  {projRename === p.cwd ? (
                    <div className="proj-head renaming" data-testid="rail-project-rename">
                      <Icon name="folder" size={12} />
                      <input
                        className="proj-rename-input"
                        autoFocus
                        value={projDraft}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setProjDraft(e.target.value)}
                        onBlur={() => { void saveRename(p.cwd) }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void saveRename(p.cwd)
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setProjRename(null)
                          }
                        }}
                      />
                    </div>
                  ) : (
                  <div
                    className={`proj-head ${pOpen ? '' : 'collapsed'}${dragItem?.kind === 'project' && dragItem.id === p.projectId ? ' is-dragging' : ''}${dropHint?.kind === 'project' && dropHint.id === p.projectId ? (dropHint.after ? ' drop-after' : ' drop-before') : ''}${dropInto?.key === (p.projectId ? `project:${p.projectId}` : `global:${p.cwd}`) ? ' drop-into' : ''}`}
                    onContextMenu={(e) => { e.preventDefault(); if (p.projectId) setProjectMenu({ id: p.id, x: e.clientX, y: e.clientY, trigger: e.currentTarget }) }}
                    title={p.cwd}
                    data-testid="rail-project-row"
                    data-current={p.isCurrent ? '1' : '0'}
                    data-drop-into={p.projectId ? `project:${p.projectId}` : `global:${p.cwd}`}
                    data-drag-kind={p.projectId ? 'project' : undefined}
                    data-drag-id={p.projectId}
                    data-drag-group={p.projectId ? (groupId ?? '') : undefined}
                    onPointerDown={p.projectId ? (e) => beginDrag(e, 'project', p.projectId!, groupId ?? '') : undefined}
                    onClickCapture={(e) => {
                      if (consumeDragClick()) {
                        e.stopPropagation()
                        e.preventDefault()
                      }
                    }}
                  >
                    <button
                      className="proj-pick"
                      data-testid="rail-project"
                      title={p.projectId ? `${p.label}\n${p.cwd}` : `${t('rail.global')}\n${p.cwd}`}
                      aria-current={p.isCurrent ? 'true' : undefined}
                      aria-expanded={pOpen}
                      onClick={() => toggleProject(p.id)}
                    >
                      <Icon name={p.projectId ? (pOpen ? 'folder-open' : 'folder') : 'globe'} size={12} />
                      <span className="proj-labels">
                        <span className="proj-name">{p.label}</span>
                        {p.projectId && projectRecords.find((record) => record.id === p.projectId)?.groupId ? <span className="proj-group">{projectGroups.find((g) => g.id === projectRecords.find((record) => record.id === p.projectId)?.groupId)?.name}</span> : null}
                      </span>
                    </button>
                    <button
                      className="proj-fold"
                      data-testid="rail-project-fold"
                      aria-expanded={pOpen}
                      title={pOpen ? t('rail.foldProject') : t('rail.unfoldProject')}
                      onClick={() => toggleProject(p.id)}
                    >
                      <Icon name="chevron-right" size={12} className={`chev ${pOpen ? 'open' : ''}`} />
                    </button>
                    {p.projectId ? (
                      <span
                        className="proj-rename"
                        role="button"
                        tabIndex={0}
                        title={t('rail.more')}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setProjectMenu({ id: p.id, x: r.left, y: r.bottom, trigger: e.currentTarget as HTMLElement }) } }}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (projectMenu?.id === p.id) { setProjectMenu(null); return }
                          const r = (event.currentTarget as HTMLElement).getBoundingClientRect()
                          setProjectMenu({ id: p.id, x: r.left, y: r.bottom, trigger: event.currentTarget as HTMLElement })
                        }}
                      ><Icon name="menu" size={12} /></span>
                    ) : null}
                    <span className="proj-count">{p.list.length}</span>
                    {runningIn(p.list) > 0 ? (
                      <span
                        className="proj-running"
                        data-testid="rail-project-running"
                        title={t('rail.runningCount', { n: runningIn(p.list) })}
                      >
                        <RunDot />
                        {runningIn(p.list)}
                      </span>
                    ) : null}
                  </div>
                  )}

                  <ContextMenu
                    open={projectMenu?.id === p.id && !!p.projectId}
                    anchor={projectMenu?.id === p.id ? projectMenu : null}
                    testid="rail-project-menu-panel"
                    onClose={() => { const trigger = projectMenu?.trigger; setProjectMenu(null); trigger?.focus?.() }}
                    items={[
                      { id: 'rail-project-open', label: t('rail.openProject'), icon: 'folder-open', onSelect: () => { void switchProject(p.cwd, p.projectId) } },
                      {
                        id: 'rail-project-new',
                        label: t('rail.new'),
                        icon: 'plus',
                        onSelect: async () => {
                          const r = await window.yan.setCwd(p.cwd)
                          if (!r.ok) setProjectError(r.error || t('rail.projectError'))
                          else { await newSession({ cwd: p.cwd, projectId: p.projectId, scope: 'project' }); await useStore.getState().refreshSessions() }
                        }
                      },
                      { id: 'rail-project-rename', label: t('rail.renameProject'), icon: 'pencil', onSelect: () => { setProjDraft(p.label); setProjRename(p.cwd) } },
                      { id: 'rail-project-directory', label: t('rail.changeDirectory'), icon: 'folder-open', onSelect: () => {
                        const record = projectRecords.find((item) => item.id === p.projectId)
                        if (record) setProjectDirectoryEdit({ ...record })
                      } },
                      { id: 'rail-project-reveal', label: t('rail.reveal'), icon: 'folder-open', onSelect: () => { void window.yan.revealPath(p.cwd).catch((cause) => setProjectError(cause instanceof Error ? cause.message : t('rail.projectError'))) } },
                      { id: 'rail-project-copy', label: t('rail.copyPath'), onSelect: () => { void navigator.clipboard.writeText(p.cwd).catch((cause) => setProjectError(cause instanceof Error ? cause.message : t('rail.projectError'))) } },
                      {
                        id: 'rail-project-remove',
                        label: showArchived ? t('rail.restoreProject') : t('rail.removeProject'),
                        icon: showArchived ? 'refresh' : 'alert-circle',
                        danger: !showArchived,
                        onSelect: () => {
                          if (showArchived) {
                            void patchRailSettings({ projects: projectRecords.map((project) => project.id === p.projectId ? { ...project, archived: false, updatedAt: Date.now() } : project) })
                            return
                          }
                          setProjectToRemove({ id: p.projectId!, name: p.label })
                        }
                      },
                      { id: 'rail-project-group', label: t('rail.moveGroup'), icon: 'group', onSelect: () => { setGroupingProject(p.cwd); setGroupDraft('') } }
                    ]}
                  />
                  {groupingProject === p.cwd ? <div className="project-menu project-group-menu">
                    <input autoFocus value={groupDraft} placeholder={t('rail.newGroup')} onChange={(e) => setGroupDraft(e.target.value)} />
                    <button onClick={() => {
                      const name = groupDraft.trim()
                      if (!name) return
                      const existing = projectGroups.find((group) => group.name.toLowerCase() === name.toLowerCase())
                      const group = existing ?? { id: `group-${Date.now().toString(36)}`, name, createdAt: Date.now() }
                      void patchRailSettings({ projectGroups: existing ? projectGroups : [...projectGroups, group], projects: projectRecords.map((project) => project.id === p.projectId ? { ...project, groupId: group.id, updatedAt: Date.now() } : project) }).then((ok) => { if (ok) setGroupingProject(null) })
                    }}>{t('rail.saveGroup')}</button>
                    {projectGroups.map((group) => <button key={group.id} onClick={() => { void patchRailSettings({ projects: projectRecords.map((project) => project.id === p.projectId ? { ...project, groupId: group.id, updatedAt: Date.now() } : project) }).then((ok) => { if (ok) setGroupingProject(null) }) }}>{group.name}</button>)}
                    <button onClick={() => { void patchRailSettings({ projects: projectRecords.map((project) => project.id === p.projectId ? { ...project, groupId: undefined, updatedAt: Date.now() } : project) }).then((ok) => { if (ok) setGroupingProject(null) }) }}>{t('rail.noGroup')}</button>
                  </div> : null}
                  {pOpen ? (() => {
                    const roots = p.list.filter((s) => !s.parentSession || !p.list.some((x) => x.path === s.parentSession))
                    const currentIndex = roots.findIndex((s) => s.path === viewingPath)
                    const floor = Math.max(SESSION_PREVIEW, currentIndex + 1)
                    const all = shownAllSessions.includes(p.id)
                    const limit = all ? roots.length : floor
                    const hidden = roots.length - limit
                    const containerKey = p.projectId ? `project:${p.projectId}` : `global:${p.cwd}`
                    return <>
                      {roots.slice(0, limit).map((s) => renderSession(s, p.list, 0, new Set<string>(), containerKey))}
                      {hidden > 0 ? (
                        <button
                          className="rail-more-sessions"
                          data-testid="rail-more-sessions"
                          data-count={hidden}
                          title={t('rail.moreSessionsTip', { n: hidden })}
                          onClick={() => setShownAllSessions((prev) => [...prev, p.id])}
                        >
                          <Icon name="chevron-right" size={12} className="chev" />
                          {t('rail.moreSessions', { n: hidden })}
                        </button>
                      ) : null}
                      {all && roots.length > floor ? (
                        <button
                          className="rail-more-sessions"
                          data-testid="rail-fold-sessions"
                          onClick={() => setShownAllSessions((prev) => prev.filter((x) => x !== p.id))}
                        >{t('rail.foldSessions')}</button>
                      ) : null}
                    </>
                  })() : null}
                </div>
              )
            })
          ) : null}
          {projectsOpen && !query && hiddenProjects > 0 ? (
            <button
              className="rail-more-projects"
              onClick={() => setProjectsExpanded(!showAllProjects)}
              data-testid="rail-more-projects"
              data-expanded={showAllProjects ? '1' : '0'}
            >
              <Icon name="chevron-right" size={12} className={`chev ${showAllProjects ? 'on' : ''}`} />
              <span>
                {showAllProjects ? t('rail.lessProjects') : t('rail.moreProjects', { n: hiddenProjects })}
              </span>
            </button>
          ) : null}
          </>}
        </div>
      </div>

      <RailUser />
      {trashNotice ? (
        <TrashNoticeBar
          notice={trashNotice}
          onUndo={() => void undoTrash()}
          onClose={() => setTrashNotice(null)}
        />
      ) : null}

      {projectDirectoryEdit ? <ProjectDirectoryDialog key={projectDirectoryEdit.id} project={projectDirectoryEdit} onClose={() => setProjectDirectoryEdit(null)} /> : null}
      {projectToRemove ? (
        <ProjectRemoveDialog
          project={projectToRemove}
          onClose={() => setProjectToRemove(null)}
          onRemoved={() => setProjectToRemove(null)}
        />
      ) : null}

      {deleteTarget ? (
        <SessionDeleteDialog
          session={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={(token, refreshFailed) => {
            setTrashNotice({ token, title: deleteTarget.title, busy: false, error: '', restored: false, refreshFailed })
            setDeleteTarget(null)
          }}
        />
      ) : null}
    </aside>
  )
}
