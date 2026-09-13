import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { SessionSummary } from '../../../../shared/ipc'
import { shortProject } from './rail-utils'
import { forkLatest } from '../../lib/fork'
import { RailUser } from './RailUser'
import { ancestorPaths, useSidebarValue } from './sidebar-state'

/**
 * 左栏 —— 对齐 Agents-Anywhere 的结构。
 *
 * 结构（自上而下）：
 *   品牌 + 图标按钮（搜索 / 新对话 / 钉住 / 自动）
 *   「新对话」操作行
 *   ─────
 *   项目分组（可折叠，标题右侧有动作）
 *     └ 项目行（可折叠）
 *         └ 会话行（缩进一级）
 *   ─────
 *   底部：用户块（头像 + 当前项目 + 设置）
 *
 * 与上一版的区别：
 *   · 会话**嵌套在项目下**缩进显示（上一版是平铺，项目只是个小标签）
 *   · 分组标题带 `+` 动作
 *   · 底部是用户块而不是一行状态文字
 *   · 去掉卡片式边框，全部靠背景色与缩进表达层级
 */
/**
 * 模式列表（入口先做出来，只有当前模式可选 —— 其余标「即将支持」）。
 *
 * 为什么先只做入口（用户的原话）：模式的**行为**差异（工具集、提示词、
 * 默认思考档……）需要先定清楚，先把入口/文案/交互定下来，
 * 接入时只换这份数据。这也是本项目的惯例：
 * 不做假状态 —— 未接入的项明确写「即将支持」而不是让它看着能用。
 */
const MODES = [
  { id: 'coding', labelKey: 'mode.coding' },
  { id: 'ask', labelKey: 'mode.daily' }
] as const

/** 当前模式（暂时只有一个） */
const MODE_ID = 'coding'
/** Zustand selector 的稳定空值，禁止在 selector 内创建 `{}`。 */
const EMPTY_PROJECT_NAMES: Record<string, string> = {}

export function Rail() {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const session = useStore((s) => s.session)
  const switchSession = useStore((s) => s.switchSession)
  const newSession = useStore((s) => s.newSession)
  const refreshSessions = useStore((s) => s.refreshSessions)
  const titles = useStore((s) => s.titles)
  /** 用户手动重命名的会话名（优先于自动标题） */
  const manualTitles = useStore((s) => s.manualTitles)
  // 不能在 selector 里 `?? {}`：每次都会制造新引用，React 19 会判定快照持续变化并陷入重渲染。
  const settings = useStore((s) => s.settings)
  const projectNames = settings?.projectNames ?? EMPTY_PROJECT_NAMES
  const projectRecords = settings?.projects ?? []
  const projectGroups = settings?.projectGroups ?? []
  const patchSettings = useStore((s) => s.patchSettings)

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [projectsOpen, setProjectsOpen] = useSidebarValue('projects-open', true)
  const [collapsed, setCollapsed] = useSidebarValue<string[]>('collapsed-projects', [])
  const [expanded, setExpanded] = useSidebarValue<string[]>('expanded-branches', [])
  const [pinned, setPinned] = useSidebarValue<string[]>('pinned', [])
  const archived = useMemo(() => projectRecords.filter((p) => p.archived).map((p) => p.cwd), [projectRecords])
  const [showArchived, setShowArchived] = useState(false)
  const [unread, setUnread] = useSidebarValue<string[]>('unread', [])
  const railPinned = useStore((s) => s.railPinned)
  const setRailPinned = useStore((s) => s.setRailPinned)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** 正在重命名哪个项目（cwd）；null = 没有 */
  const [projRename, setProjRename] = useState<string | null>(null)
  const [projDraft, setProjDraft] = useState('')
  /** 模式菜单（用户要求：软件名加一个菜单用来切换模式，先只做入口） */
  const [modeMenu, setModeMenu] = useState(false)
  const [projectMenu, setProjectMenu] = useState<string | null>(null)
  const [projectError, setProjectError] = useState('')
  const [groupingProject, setGroupingProject] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)

  useEffect(() => {
    const clearCurrent = (): void => {
      const path = useStore.getState().session?.sessionFile
      if (path) setUnread((prev) => prev.includes(path) ? prev.filter((p) => p !== path) : prev)
    }
    const unsubscribe = useStore.subscribe((next, prev) => {
      const current = next.session
      if (current?.sessionFile && current.sessionId === prev.session?.sessionId &&
        prev.session?.isAgentRunning && !current.isAgentRunning && !document.hasFocus()) {
        setUnread((old) => [...new Set([...old, current.sessionFile!])])
      }
    })
    window.addEventListener('focus', clearCurrent)
    return () => { unsubscribe(); window.removeEventListener('focus', clearCurrent) }
  }, [setUnread])

  // 会话列表在有新消息后会变（标题、时间），settled 时刷一次
  const msgCount = useStore((s) => s.messages.length)
  useEffect(() => {
    if (msgCount === 0) return
    const id = setTimeout(() => void refreshSessions(), 800)
    return () => clearTimeout(id)
  }, [msgCount, refreshSessions])

  useEffect(() => {
    if (!menuFor && !projectMenu) return
    const close = (): void => { setMenuFor(null); setProjectMenu(null) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuFor, projectMenu])

  /* 模式菜单：点外面关掉（与其它浮层同一套做法） */
  useEffect(() => {
    if (!modeMenu) return
    const close = (): void => setModeMenu(false)
    // 延后一帧挂，免得打开的那一下点击立刻把它关掉
    const id = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', close)
    }
  }, [modeMenu])

  /** 按项目（cwd）分组；当前项目永远排最前，其余按最近活动排 */
  const projects = useMemo(() => {
    const q = query.trim().toLowerCase()

    /**
     * 会话的**真实最近活动**（最后一条消息的时间）。
     * 老数据可能没有（升级前拉的列表）→ 退回 mtime。
     */
    const activity = (s: SessionSummary): number => s.lastActivityAt ?? s.updatedAt

    /**
     * 排序：先按家族分组，再按“新→旧”。
     *
     * 用户报「顺序不对 很乱」：以前所有会话混在一起排，
     * 分叉出来的子会话散落在各处，找不到“它从哪来”。
     * 现在：根会话按最近活动倒序，**子会话紧跟在它的父会话后面**
     *（同族按创建先后），家族内部不再交错。
     *
     * ⚠️ 排序键用 lastActivityAt（最后一条 message 的时间），
     * 不用 updatedAt（= mtime）：打开会话会写会话文件，mtime 一变
     * 那行就跳到顶部（用户上一轮报的「进入会话就置顶」）。
     */
    const orderFamily = (list: SessionSummary[]): SessionSummary[] => {
      const inList = new Set(list.map((s) => s.path))
      const children = new Map<string, SessionSummary[]>()
      for (const s of list) {
        if (!s.parentSession || !inList.has(s.parentSession)) continue
        const arr = children.get(s.parentSession) ?? []
        arr.push(s)
        children.set(s.parentSession, arr)
      }
      for (const arr of children.values()) arr.sort((a, b) => a.createdAt - b.createdAt)

      const roots = list.filter((s) => !s.parentSession || !inList.has(s.parentSession))
      roots.sort((a, b) => activity(b) - activity(a))

      const out: SessionSummary[] = []
      const seen = new Set<string>()
      const push = (s: SessionSummary): void => {
        if (seen.has(s.path)) return
        seen.add(s.path)
        out.push(s)
        for (const c of children.get(s.path) ?? []) push(c)
      }
      for (const r of roots) push(r)
      for (const s of list) push(s) // 兑底：不丢行
      return out
    }

    /**
     * ⚠️ pi 的会话文件是**懒创建**的 —— 新建的会话在第一条消息之前不落盘，
     * sessions 列表里根本没有它。不补一条的话，点「新对话」后左栏毫无反应，
     * 也看不出「当前就在这个新会话里」。
     * 这条合成条目在落盘后会自动被真实条目取代（path 相同）。
     */
    const currentPath = session?.sessionFile
    const synthetic: SessionSummary[] = currentPath && !sessions.some((x) => x.path === currentPath)
      ? [
          {
            id: session?.sessionId ?? 'current',
            path: currentPath,
            cwd: session?.cwd ?? '',
            title: session?.sessionName ?? t('rail.untitled'),
            named: !!session?.sessionName,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0
          }
        ]
      : []

    // 用模型生成的短标题覆盖列表标题（如果有）；用户手动名优先
    const all = [...synthetic, ...sessions].map((x) => {
      const manual = manualTitles[x.id]
      if (manual) return { ...x, title: manual, named: true }
      const t = titles[x.id]
      return t ? { ...x, title: t } : x
    })
    const parents = new Map(all.filter((s) => s.parentSession).map((s) => [s.path, s.parentSession!]))
    const matches = new Set<string>()
    for (const s of all) {
      if (!q || [s.title, s.cwd, projectNames[s.cwd] ?? ''].some((v) => v.toLowerCase().includes(q))) {
        matches.add(s.path)
        for (const p of ancestorPaths(s.path, parents)) matches.add(p)
      }
    }
    const filtered = all.filter((s) => matches.has(s.path))

    const byCwd = new Map<string, SessionSummary[]>()
    for (const s of filtered) {
      const rootPath = ancestorPaths(s.path, parents).at(-1)
      const root = rootPath ? all.find((x) => x.path === rootPath) : s
      const key = (root?.cwd || s.cwd) || '—'
      const list = byCwd.get(key) ?? []
      list.push(s)
      byCwd.set(key, list)
    }

    for (const cwd of settings?.recentCwds ?? []) {
      if (!byCwd.has(cwd) && (!q || (projectNames[cwd] || cwd).toLowerCase().includes(q))) byCwd.set(cwd, [])
    }
    const cur = session?.cwd
    return [...byCwd.entries()]
      .map(([cwdKey, list]) => ({
        cwd: cwdKey,
        label: cwdKey === '—' ? t('rail.local') : projectNames[cwdKey] || shortProject(cwdKey),
        list: orderFamily(list),
        isCurrent: cwdKey === cur
      }))
      .filter((p) => showArchived === archived.includes(p.cwd))
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
        const at = (p: { list: SessionSummary[] }) =>
          p.list[0] ? (p.list[0].lastActivityAt ?? p.list[0].updatedAt) : 0
        return at(b) - at(a)
      })
  }, [sessions, query, session, t, titles, manualTitles, projectNames, settings?.recentCwds, archived, showArchived])

  // 将项目实体按持久化分组重新排列；分组标题会在项目列表中作为一级标题显示。
  // 组内仍保留项目原本的活动排序，未分组项目统一放在最后。
  const displayProjects = useMemo(() => {
    const groupIdFor = (cwd: string): string | undefined => projectRecords.find((record) => record.cwd === cwd)?.groupId
    const byGroup = new Map<string, typeof projects>()
    for (const project of projects) {
      const key = groupIdFor(project.cwd) ?? ''
      const list = byGroup.get(key) ?? []
      list.push(project)
      byGroup.set(key, list)
    }
    const ordered: typeof projects = []
    for (const group of projectGroups) ordered.push(...(byGroup.get(group.id) ?? []))
    ordered.push(...(byGroup.get('') ?? []))
    return ordered
  }, [projects, projectRecords, projectGroups])

  /**
   * 会话分支关系（用户要求：左栏显示分支数 / 分支编号）。
   *
   * 数据来自 pi 的 session 头：`parentSession` 指向分叉来源的会话文件。
   * 从这里算出：
   *   · branchCount：这个会话被分叉出去几次（父会话行上显示）
   *   · branchIndex：这个会话是父会话的第几个分支（子会话行上显示 #N）
   * 编号按 createdAt 升序 —— 与分支创建的先后一致。
   */
  const { branchIndex } = useMemo(() => {
    const kids = new Map<string, SessionSummary[]>()
    for (const s of sessions) {
      if (!s.parentSession) continue
      const arr = kids.get(s.parentSession) ?? []
      arr.push(s)
      kids.set(s.parentSession, arr)
    }
    const count = new Map<string, number>()
    const index = new Map<string, number>()
    for (const [parent, list] of kids) {
      count.set(parent, list.length)
      list.sort((a, b) => a.createdAt - b.createdAt)
      list.forEach((s, i) => index.set(s.path, i + 1))
    }
    return { branchCount: count, branchIndex: index, branchesOf: kids }
  }, [sessions])

  const toggleProject = (key: string): void =>
    setCollapsed((prev) => prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key])
  const toggleBranch = (key: string): void =>
    setExpanded((prev) => prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key])
  const select = async (path: string): Promise<void> => {
    const parents = new Map(sessions.filter((s) => s.parentSession).map((s) => [s.path, s.parentSession!]))
    if (!query) setExpanded((prev) => [...new Set([...prev, ...ancestorPaths(path, parents)])])
    await switchSession(path)
    setUnread((prev) => prev.filter((p) => p !== path))
  }
  const renderSession = (s: SessionSummary, list: SessionSummary[], depth = 0, lineage = new Set<string>()): React.ReactNode => {
    if (lineage.has(s.path)) return null
    const next = new Set(lineage).add(s.path)
    const children = list.filter((c) => c.parentSession === s.path && !next.has(c.path))
    const isOpen = !!query || expanded.includes(s.path)
    return <SessionRow key={s.path} s={s} selected={session?.sessionFile === s.path}
      depth={depth} branchCount={children.length} branchIndex={branchIndex.get(s.path)}
      branchesOpen={isOpen} onToggleBranches={() => toggleBranch(s.path)}
      children={isOpen ? children.map((c) => renderSession(c, list, depth + 1, next)) : null}
      menuOpen={menuFor === s.path} onToggleMenu={() => setMenuFor(menuFor === s.path ? null : s.path)}
      onSelect={() => void select(s.path)} pinned={pinned.includes(s.path)} unread={unread.includes(s.path)}
      onPin={() => setPinned((prev) => prev.includes(s.path) ? prev.filter((p) => p !== s.path) : [...prev, s.path])}
      onRequestDelete={() => setDeleteTarget(s)} />
  }

  const total = sessions.length
  const shown = projects.reduce((n, p) => n + p.list.length, 0)

  return (
    <aside className="rail">
      {!railPinned ? <div className="rail-compact">
        <button title={t('mode.switch')} onClick={() => { setRailPinned(true); setModeMenu(true) }}>砚</button>
        <button title={t('rail.search')} onClick={() => { setRailPinned(true); setSearching(true) }}><Icon name="search" size={16} /></button>
        <button title={t('rail.new')} onClick={() => void newSession()}><Icon name="plus" size={16} /></button>
        <span className="spacer" />
        <button title={t('rail.settings')} onClick={() => useStore.getState().openSettings()}><Icon name="settings" size={16} /></button>
      </div> : null}
      {/* ---- 顶部：品牌（带模式菜单）+ 动作 ---- */}
      <div className="rail-top">
        {/*
         * 品牌字 + 模式菜单（用户要求，参考 Codex 的「Codex ⌄」）。
         *
         * 「先只做入口」：菜单里列出模式，但除当前模式外都标**未接入** ——
         * 不做假状态（同左栏头像那个「登录（尚未接入）」的做法）。
         * 这样入口、交互、文案都定下来了，接入时只需换掉菜单数据。
         */}
        <div className="rail-mode-wrap">
          <button
            className={`rail-mode-btn ${modeMenu ? 'open' : ''}`}
            onClick={() => setModeMenu((v) => !v)}
            data-testid="mode-menu-btn"
            aria-expanded={!!modeMenu}
            aria-haspopup="menu"
            title={t('mode.switch')}
          >
            <span className="rail-brand">砚</span>
            <Icon name="chevron-right" size={12} className="rail-mode-chev" />
          </button>
          {modeMenu ? (
            <div className="rail-mode-menu" role="menu" data-testid="mode-menu">
              <div className="rmm-head">{t('mode.title')}</div>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={`rmm-item ${m.id === MODE_ID ? 'cur' : ''}`}
                  role="menuitem"
                  data-testid={`mode-${m.id}`}
                  disabled={m.id !== MODE_ID}
                  onClick={() => {
                    /* 只有当前模式是可选的；其余明确提示未接入 */
                    if (m.id === MODE_ID) setModeMenu(false)
                  }}
                >
                  <span className="rmm-dot" aria-hidden />
                  <span className="rmm-name">{t(m.labelKey)}</span>
                  <span className="spacer" />
                  <span className="rmm-tag">
                    {m.id === MODE_ID ? t('mode.current') : t('mode.soon')}
                  </span>
                </button>
              ))}
              <div className="rmm-foot">{t('mode.foot')}</div>
            </div>
          ) : null}
        </div>
        <span className="rail-spacer" />
        <button
          className={`rail-icon ${searching ? 'on' : ''}`}
          title={t('rail.search')}
          onClick={() => {
            setSearching((v) => !v)
            if (searching) setQuery('')
          }}
          data-testid="rail-search-btn"
        >
          <Icon name="search" size={12} />
        </button>
      </div>

      {searching ? (
        <div className="rail-search">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('rail.search')}
            data-testid="rail-search"
          />
          {query ? (
            <button className="rail-search-clear" onClick={() => setQuery('')} title={t('rail.clear')}>
              ✕
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ---- 操作行 ---- */}
      <button className="rail-action" onClick={() => void newSession()} data-testid="rail-new">
        <Icon name="plus" size={12} />
        <span>{t('rail.new')}</span>
      </button>

      {/* ---- 项目分组 ---- */}
      <div className="rail-section">
        <div className="rail-section-head">
          <button
            className={`rail-section-title ${projectsOpen ? '' : 'collapsed'}`}
            onClick={() => setProjectsOpen((v) => !v)}
            data-testid="rail-projects-head"
          >
            <span>{t('rail.projects')}</span>
            <Icon name="chevron-right" size={12} className="chev" />
          </button>
          <button
            className="rail-icon sm"
            title={t('rail.addProject')}
            onClick={async () => { const cwd = await window.yan.pickCwd(); if (!cwd) return; const r = await window.yan.setCwd(cwd); if (!r.ok) setProjectError(r.error || t('rail.projectError')); else await useStore.getState().bootstrap() }}
          >
            <Icon name="plus" size={12} />
          </button>
        </div>

        <div className="rail-body">
          {projectError ? <div className="rail-empty" role="alert">{projectError}</div> : null}
          {!query && !showArchived && pinned.some((p) => sessions.some((s) => s.path === p && !archived.includes(s.cwd))) ? <div className="rail-pins">
            <div className="rail-section-title">{t('rail.pinned')}</div>
            {sessions.filter((s) => pinned.includes(s.path) && !archived.includes(s.cwd)).map((s) => renderSession({ ...s, title: manualTitles[s.id] || titles[s.id] || s.title }, []))}
          </div> : null}
          <button className="rail-archive-toggle" onClick={() => setShowArchived((v) => !v)}>{showArchived ? t('rail.backProjects') : t('rail.archivedProjects', { n: archived.length })}</button>
          {total === 0 && projects.length === 0 ? (
            <div className="rail-empty">{t('rail.empty')}</div>
          ) : shown === 0 && projects.length === 0 ? (
            <div className="rail-empty">{t('rail.noMatch')}</div>
          ) : projectsOpen || query ? (
            displayProjects.map((p, projectIndex) => {
              const pOpen = !!query || !collapsed.includes(p.cwd)
              const groupId = projectRecords.find((record) => record.cwd === p.cwd)?.groupId
              const group = groupId ? projectGroups.find((candidate) => candidate.id === groupId) : undefined
              const previous = displayProjects[projectIndex - 1]
              const previousGroupId = previous ? projectRecords.find((record) => record.cwd === previous.cwd)?.groupId : undefined
              return (
                <div key={p.cwd} className="proj">
                  {group && groupId !== previousGroupId ? <div className="proj-group-heading" data-testid="rail-project-group" title={group.name}>{group.name}</div> : null}
                  {projRename === p.cwd ? (
                    /* 项目行内重命名：Enter 提交 / Esc 取消 / 失焦提交 */
                    <div className="proj-head renaming" data-testid="rail-project-rename">
                      <Icon name="folder" size={12} />
                      <input
                        className="proj-rename-input"
                        autoFocus
                        value={projDraft}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setProjDraft(e.target.value)}
                        onBlur={() => {
                          const names = { ...projectNames }
                          if (projDraft.trim()) names[p.cwd] = projDraft.trim()
                          else { setProjRename(null); return }
                          void patchSettings({ projectNames: names })
                          setProjRename(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            e.currentTarget.blur()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setProjRename(null)
                          }
                        }}
                      />
                    </div>
                  ) : (
                  <button
                    className={`proj-head ${pOpen ? '' : 'collapsed'}`}
                    onClick={() => toggleProject(p.cwd)}
                    onDoubleClick={() => { setProjDraft(p.label); setProjRename(p.cwd) }}
                    onContextMenu={(e) => { e.preventDefault(); setProjectMenu(p.cwd) }}
                    title={p.cwd}
                    data-testid="rail-project"
                    data-current={p.isCurrent ? '1' : '0'}
                  >
                    <Icon name={pOpen ? 'folder-open' : 'folder'} size={12} />
                    <span className="proj-labels">
                      <span className="proj-name">{p.label}</span>
                      {projectRecords.find((record) => record.cwd === p.cwd)?.groupId ? <span className="proj-group">{projectGroups.find((g) => g.id === projectRecords.find((record) => record.cwd === p.cwd)?.groupId)?.name}</span> : null}
                    </span>
                    <span
                      className="proj-rename"
                      role="button"
                      tabIndex={0}
                      title={t('rail.more')}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setProjectMenu(p.cwd) } }}
                      onClick={(event) => {
                        event.stopPropagation()
                        // ⚠️ Electron 不支持 window.prompt（返回 null，什么都发生不了）
                        setProjectMenu(projectMenu === p.cwd ? null : p.cwd)
                      }}
                    ><Icon name="menu" size={12} /></span>
                    <span className="proj-count">{p.list.length}</span>
                  </button>
                  )}

                  {projectMenu === p.cwd ? <div className="project-menu" onClick={(e) => e.stopPropagation()}>
                    <button onClick={async () => { setProjectMenu(null); const r = await window.yan.setCwd(p.cwd); if (!r.ok) setProjectError(r.error || t('rail.projectError')); else { await useStore.getState().bootstrap(); await newSession() } }}>{t('rail.new')}</button>
                    <button onClick={() => { setProjectMenu(null); setProjDraft(p.label); setProjRename(p.cwd) }}>{t('rail.renameProject')}</button>
                    <button onClick={() => { void window.yan.revealPath(p.cwd); setProjectMenu(null) }}>{t('rail.reveal')}</button>
                    <button onClick={() => { void navigator.clipboard.writeText(p.cwd); setProjectMenu(null) }}>{t('rail.copyPath')}</button>
                    <button onClick={() => {
                      void patchSettings({ projects: projectRecords.map((project) => project.cwd === p.cwd ? { ...project, archived: !showArchived, updatedAt: Date.now() } : project) })
                      setProjectMenu(null)
                    }}>{showArchived ? t('rail.restoreProject') : t('rail.archiveProject')}</button>
                    <button onClick={() => { setGroupingProject(p.cwd); setGroupDraft(''); setProjectMenu(null) }}>{t('rail.moveGroup')}</button>
                  </div> : null}
                  {groupingProject === p.cwd ? <div className="project-menu project-group-menu">
                    <input autoFocus value={groupDraft} placeholder={t('rail.newGroup')} onChange={(e) => setGroupDraft(e.target.value)} />
                    <button onClick={() => {
                      const name = groupDraft.trim()
                      if (!name) return
                      const existing = projectGroups.find((group) => group.name.toLowerCase() === name.toLowerCase())
                      const group = existing ?? { id: `group-${Date.now().toString(36)}`, name, createdAt: Date.now() }
                      void patchSettings({ projectGroups: existing ? projectGroups : [...projectGroups, group], projects: projectRecords.map((project) => project.cwd === p.cwd ? { ...project, groupId: group.id, updatedAt: Date.now() } : project) })
                      setGroupingProject(null)
                    }}>{t('rail.saveGroup')}</button>
                    {projectGroups.map((group) => <button key={group.id} onClick={() => { void patchSettings({ projects: projectRecords.map((project) => project.cwd === p.cwd ? { ...project, groupId: group.id, updatedAt: Date.now() } : project) }); setGroupingProject(null) }}>{group.name}</button>)}
                    <button onClick={() => { void patchSettings({ projects: projectRecords.map((project) => project.cwd === p.cwd ? { ...project, groupId: undefined, updatedAt: Date.now() } : project) }); setGroupingProject(null) }}>{t('rail.noGroup')}</button>
                  </div> : null}
                  {pOpen ? <>
                    {p.list.filter((s) => !s.parentSession || !p.list.some((p) => p.path === s.parentSession)).map((s) => renderSession(s, p.list))}
                  </> : null}
                </div>
              )
            })
          ) : null}
        </div>
      </div>

      {/* ---- 底部：用户块（名字 / 自定义头像 / 登录预留）---- */}
      <RailUser />
      {deleteTarget ? <SessionDeleteDialog session={deleteTarget} onClose={() => setDeleteTarget(null)} /> : null}
    </aside>
  )
}

/* ---------------------------------------------------------------- 会话行 */

function SessionRow({ s, selected, branchCount, branchIndex, branchesOpen, onToggleBranches,
  children, depth, menuOpen, onToggleMenu, onSelect, pinned, onPin, unread, onRequestDelete
}: {
  s: SessionSummary; selected: boolean; branchCount: number; branchIndex?: number;
  branchesOpen: boolean; onToggleBranches: () => void; children: React.ReactNode; depth: number;
  menuOpen: boolean; onToggleMenu: () => void; onSelect: () => void; pinned: boolean; onPin: () => void; unread: boolean;
  onRequestDelete: () => void
}) {
  const t = useT()
  const running = useStore((state) => state.session?.sessionFile === s.path && !!state.session?.isAgentRunning)
  const waiting = useStore((state) => state.session?.sessionFile === s.path && state.uiRequests.length > 0)
  const failure = useStore((state) => state.session?.sessionFile === s.path && (state.conn === 'error' || state.conn === 'exited') ? state.connDetail : '')
  /**
   * 行内重命名。
   *
   * ⚠️ 以前用 `window.prompt` —— 而 **Electron 不支持 prompt()**
   *    （调用返回 null 并报错），于是点「重命名」什么都不会发生，
   *    用户看到的就是「左栏会话没办法重命名」。
   *    改成行内 input：不依赖浏览器对话框，也少一层弹窗。
   */
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(s.title)

  const commitRename = (): void => {
    const name = draft.trim()
    setRenaming(false)
    if (!name || name === s.title) return
    void useStore.getState().setManualTitle(s.id, name)
  }

  return (
    <div className={`srow-wrap has-acts ${menuOpen ? 'menu-open' : ''}`} data-session-path={s.path} data-depth={depth} style={{ '--branch-depth': Math.min(depth, 3) } as React.CSSProperties}>
      {/* 行主体：会话按钮（占满，可省略号） + 分叉开关 + 相对时间 */}
      <div className={`srow-row ${selected ? 'selected' : ''}`} onContextMenu={(e) => { e.preventDefault(); onToggleMenu() }}>
        {renaming ? (
          /* 行内重命名：Enter 提交 / Esc 取消 / 失焦提交 */
          <input
            className="srow-rename-input"
            data-testid="rail-rename-input"
            autoFocus
            value={draft}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setRenaming(false)
                setDraft(s.title)
              }
            }}
          />
        ) : (
          <button className={`srow ${selected ? 'sel' : ''}`} onClick={onSelect} title={`${s.title}${s.branchOrigin ? '\n' + s.branchOrigin : ''}\n${s.path}`} data-testid={depth ? 'rail-branch-item' : 'rail-session'}>
            <span className="srow-text">
              <span className="srow-line">
                {/* 分支编号：这个会话是从别的会话分出来的第几个 */}
                {branchIndex ? (
                  <span className="srow-bno" data-testid="rail-branch-no" title={t('rail.branchNo', { n: branchIndex })}>
                    #{branchIndex}
                  </span>
                ) : null}
                <span className="srow-name">{s.title}</span>
              </span>
              {/* 分叉自父会话的哪句话 */}
              {s.branchOrigin ? (
                <span className="srow-origin" data-testid="rail-branch-origin" title={s.branchOrigin}>
                  {t('rail.fromMessage', { text: s.branchOrigin })}
                </span>
              ) : null}
            </span>
          </button>
        )}

        {branchCount > 0 ? (
          <button
            className={`srow-btoggle ${branchesOpen ? 'open' : ''}`}
            data-testid="rail-branch-toggle"
            data-open={branchesOpen ? '1' : '0'}
            aria-expanded={branchesOpen}
            title={t('rail.branchCount', { n: branchCount })}
            onClick={onToggleBranches}
          >
            <Icon name="layers" size={12} />
            <span className="srow-btoggle-n">{branchCount}</span>
            <Icon name="chevron-right" size={12} className="chev" />
          </button>
        ) : null}

        {waiting ? <span className="session-status waiting" title={t('rail.waiting')}>?</span> : failure ? <span className="session-status waiting" title={failure}><Icon name="alert-circle" size={12} /></span> : running ? <span className="session-status running" title={t('rail.running')}><Icon name="activity" size={12} /></span> : unread ? <span className="session-status" title={t('rail.unread')}>●</span> : null}
        {/* 显示的时间必须与排序键一致，否则看起来“没排序” */}
        <span className="srow-time">{relTime(s.lastActivityAt ?? s.updatedAt)}</span>
      </div>

      {branchesOpen && children ? <div className="session-children" data-testid="rail-branch-tree">{children}</div> : null}

      {/*
       * 动作按钮（⋯）**每一行都渲染**，悬停才显形。
       *
       * ⚠️ 以前只在 selected 行渲染 ── 而菜单里的「删除」又对 selected 行
       *    禁用（当前会话不能删）→ **删除功能永远点不到**（用户报的）。
       *    现在任何行悬停都能开菜单，未选中的行删除可用。
       *    隐藏时 pointer-events:none，否则看不见的按钮会抢走“点行选中”的点击。
       */}
      <span className="srow-acts">
        <button className="rail-icon sm" title={t('rail.more')} onClick={(e) => {
          e.stopPropagation()
          onToggleMenu()
        }}>
          <Icon name="menu" size={12} />
        </button>
      </span>

      {menuOpen ? (
        <div className="srow-menu" onClick={(e) => e.stopPropagation()}>
          <div className="srow-menu-path" title={s.path}>
            {s.path}
          </div>
          <button className="srow-menu-btn" onClick={() => { onPin(); onToggleMenu() }}><Icon name="pin" size={12} />{pinned ? t('rail.unpin') : t('rail.pin')}</button>
          <button
            disabled={!selected || running}
            title={!selected ? t('rail.openBeforeFork') : ''}
            style={{ '--i': 1 } as React.CSSProperties}
            className="srow-menu-btn"
            onClick={() => {
              void forkLatest()
              onToggleMenu()
            }}
          >
            <Icon name="layers" size={12} />
            {t('rail.forkLast')}
          </button>
          <button
            style={{ '--i': 2 } as React.CSSProperties}
            className="srow-menu-btn"
            data-testid="rail-rename"
            onClick={() => {
              /*
               * 重命名。
               *
               * ⚠️ 这里曾经**没有入口** —— 后来加上了，但用 `window.prompt`；
               *    而 **Electron 不支持 prompt()**（返回 null），于是点了没反应，
               *    用户看到的就是「左栏会话没办法重命名」。
               *    现在改成行内 input（见上面的 renaming），不再依赖浏览器对话框。
               */
              setDraft(s.title)
              setRenaming(true)
              onToggleMenu()
            }}
          >
            <Icon name="tag" size={12} />
            {t('rail.rename')}
          </button>
          <button
            style={{ '--i': 3 } as React.CSSProperties}
            className="srow-menu-btn"
            onClick={() => {
              void window.yan.revealPath(s.path)
              onToggleMenu()
            }}
          >
            <Icon name="folder" size={12} />
            {t('rail.reveal')}
          </button>
          <button
            className="srow-menu-btn danger"
            style={{ '--i': 4 } as React.CSSProperties}
            disabled={selected}
            title={selected ? t('rail.cantDeleteCurrent') : ''}
            onClick={() => { onRequestDelete(); onToggleMenu() }}
          >
            <Icon name="alert-circle" size={12} />
            {t('rail.delete')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 删除会话不能依赖浏览器原生 confirm：它没有明确告知“可撤销”，在某些
 * Electron 环境下也不能稳定地呈现。这里要求输入完整标题再启用动作。
 */
function SessionDeleteDialog({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const t = useT()
  const descendantCount = useStore((state) => {
    const children = new Map<string, string[]>()
    for (const item of state.sessions) {
      if (!item.parentSession) continue
      const list = children.get(item.parentSession) ?? []
      list.push(item.path)
      children.set(item.parentSession, list)
    }
    const walk = (path: string): number => (children.get(path) ?? []).reduce((n, child) => n + 1 + walk(child), 0)
    return walk(session.path)
  })
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [undoToken, setUndoToken] = useState<string | null>(null)
  const confirmed = typed.trim() === session.title.trim()

  const remove = async (): Promise<void> => {
    if (!confirmed || busy) return
    setBusy(true)
    const res = await window.yan.deleteSession(session.path)
    if (!res.ok) {
      setError(res.error ?? t('rail.deleteFailed'))
      setBusy(false)
      return
    }
    await useStore.getState().refreshSessions()
    setUndoToken(res.undoToken ?? null)
    setBusy(false)
  }

  const restore = async (): Promise<void> => {
    if (!undoToken || busy) return
    setBusy(true)
    const res = await window.yan.restoreSession(undoToken)
    if (!res.ok) {
      setError(res.error ?? t('rail.deleteFailed'))
      setBusy(false)
      return
    }
    await useStore.getState().refreshSessions()
    onClose()
  }

  if (undoToken) return <div className="modal-scrim rail-delete-scrim" role="dialog" aria-modal="true" aria-labelledby="delete-session-title">
    <div className="modal rail-delete-dialog">
      <div className="modal-head"><Icon name="alert-circle" size={14} /><span className="modal-title" id="delete-session-title">{t('rail.delete')}</span></div>
      <div className="modal-message">{t('rail.deletedUndo')}</div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>{t('ui.ok')}</button>
        <span className="spacer" />
        <button className="send" disabled={busy} onClick={() => void restore()}>{t('rail.undoDelete')}</button>
      </div>
    </div>
  </div>

  return <div className="modal-scrim rail-delete-scrim" role="dialog" aria-modal="true" aria-labelledby="delete-session-title">
    <div className="modal rail-delete-dialog">
      <div className="modal-head">
        <Icon name="alert-circle" size={14} />
        <span className="modal-title" id="delete-session-title">{t('rail.delete')}</span>
      </div>
      <div className="modal-message">
        {t('rail.deleteExplain', { name: session.title })}{descendantCount ? ` ${t('rail.deleteBranches', { n: descendantCount })}` : ''}
      </div>
      <input
        className="modal-input"
        autoFocus
        value={typed}
        placeholder={session.title}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter') void remove() }}
      />
      {error ? <div className="rail-delete-error" role="alert">{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={onClose} disabled={busy}>{t('ui.cancel')}</button>
        <span className="spacer" />
        <button className="btn danger" disabled={!confirmed || busy} onClick={() => void remove()}>
          {busy ? t('rail.deleting') : t('rail.delete')}
        </button>
      </div>
    </div>
  </div>
}

/* ---------------------------------------------------------------- 工具 */

/* 分叉的两个入口在 lib/fork.ts —— 对话区（消息上的分支按钮）也要用，
   放在这里会让对话区反过来 import 左栏。 */
/** 相对时间：12m / 5h / 3d */
function relTime(ts: number): string {
  const d = Math.max(0, Date.now() - ts)
  const m = Math.floor(d / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d`
  return `${Math.floor(days / 30)}mo`
}
