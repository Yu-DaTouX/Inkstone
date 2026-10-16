import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Activity, Archive, CalendarClock, FileDiff, MoreHorizontal, PanelLeftClose, Settings, SquarePen } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover, SearchField } from '../../ui'
import { IconTip } from '../../app/IconTip'
import { BrandMark } from '../../components/shell/BrandMark'
import { v3Text } from '../../app/v3-text'
import type { SessionSummary } from '../../../../shared/ipc'
import { buildArchivedView, buildSidebarGroups, latestRunForSession, type SidebarGroup } from './sidebar-model'
import { isUnreadRun, phaseWord, runTone, useRunsV3 } from '../../state/runs-v3'
import { ArchivedView } from './ArchivedView'
import { ProjectHeader } from './ProjectHeader'
import { SidebarRow } from './SidebarRow'
import { sidebarText } from './sidebar-text'
import './Sidebar.css'

/** 每个分区默认最多显示的会话条数，超出的收进「显示更多」 */
const GROUP_LIMIT = 5

/** 集合里增删一个键，返回新集合（状态更新不改原对象） */
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
  /** 收起侧栏（宽屏）或关闭浮层（窄窗） */
  onClose?: () => void
  /** 打开运行总览（正式 RunsPage） */
  onRuns?: () => void
  /** 打开定时任务页（正式 ScheduleTasksPage） */
  onSchedule?: () => void
  /** 打开代码评审页（正式 ReviewPage） */
  onReview?: () => void
  /** 打开精简设置 */
  onSettings?: () => void
}

/**
 * v3 侧栏：新对话、搜索、入口、按项目分组的会话列表、底部设置与连接状态。
 *
 * 会话切换与新建都走主 store 的正式流程（`switchSession` / `newSession`），
 * 不自己发明第二套；状态点/等待词/编号读权威 `RunSnapshot`（每会话取最新
 * `startedAt` 的一轮），没有快照就显示空点，不伪造阶段。
 */
export function Sidebar({ onClose, onRuns, onSchedule, onReview, onSettings, preview, onPin, onPointerLeave }: Props): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const text = v3Text(lang)
  const own = sidebarText(lang)
  const asideRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  /* 「已归档」视图：已归档的项目与单独归档的会话，不是会话列表的另一种排序 */
  const [showArchived, setShowArchived] = useState(false)
  /* 分区折叠与「显示更多」只留在内存里，切换视图或重开应用后回到默认（展开、前 5 条） */
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

  /*
   * 会话列表只在启动、连接恢复、新建/切换等少数动作后拉取；首条消息落盘、
   * 标题生成都发生在这些动作之后，列表不会自己更新。这里跟 v2 左栏一样：
   * 消息数或当前会话文件变化时稍后拉一次（合并短时间内的多次变化）。
   */
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
  /* 不带搜索词的总数，用于入口上的计数（搜索不改变「有多少归档」） */
  const archivedCount = useMemo(
    () => (settings?.projects ?? []).filter((project) => project.archived).length + sessions.filter((item) => !!item.archivedAt).length,
    [settings?.projects, sessions]
  )
  const projectRecords = settings?.projects ?? []

  const total = groups.reduce((sum, group) => sum + group.list.length, 0)

  const isCurrentItem = (item: SessionSummary): boolean =>
    session?.sessionId === item.id || (!!session?.sessionFile && session.sessionFile === item.path)

  /* 切到某个会话时，若它所在分区被折叠，自动展开这一组（每个会话只处理一次，之后尊重用户的折叠） */
  const currentKey = session?.sessionId ?? session?.sessionFile ?? ''
  useEffect(() => {
    if (!currentKey || revealedRef.current === currentKey) return
    const group = groups.find((g) => g.list.some((item) => isCurrentItem(item)))
    if (!group) return
    revealedRef.current = currentKey
    setCollapsedKeys((prev) => (prev.has(group.key) ? toggleKey(prev, group.key) : prev))
  }, [currentKey, groups, session?.sessionId, session?.sessionFile])

  /** 分区里这次要画的会话：默认前 5 条；当前会话即使在第 5 条之后，也保证它可见 */
  const visibleRows = (group: SidebarGroup): SessionSummary[] => {
    if (expandedKeys.has(group.key) || group.list.length <= GROUP_LIMIT) return group.list
    const head = group.list.slice(0, GROUP_LIMIT)
    const current = group.list.find((item) => isCurrentItem(item))
    return current && !head.includes(current) ? [...head, current] : head
  }

  /* 命令面板请求搜索；下一帧再聚焦，让外壳先展开侧栏并解除模态焦点圈定。 */
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
      /* 只有这次切换真的落地（peekedPath 指向它）才标记已读；失败或被更新的点击顶掉都不标 */
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
          <span className="v3-side-name">砚</span>
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
          <MenuTrigger>
            <Button variant="ghost" className="v3-entry v3-entry-more" data-testid="v3-entry-more">
              <MoreHorizontal size={16} aria-hidden />
              <span className="v3-entry-label">{own.moreEntries}</span>
            </Button>
            <Popover placement="bottom start" offset={4}>
              <Menu aria-label={own.moreEntries} onAction={(key) => { if (key === 'runs') onRuns() }} data-testid="v3-more-menu">
                <MenuItem id="runs" textValue={own.runRecords} data-testid="v3-more-runs">
                  <Activity size={14} aria-hidden />
                  {own.runRecords}
                </MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
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
                  /* 权威运行快照：最新一轮的 phase 决定状态点与等待词；没有就空点，不编造七态 */
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
}
