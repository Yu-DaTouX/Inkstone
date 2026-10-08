import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { ContextMenu } from '../common/ContextMenu'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { SessionSummary } from '../../../../shared/ipc'
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
 * 左栏的两档工作区入口只改变导航语境，不改变当前会话 AgentMode。
 * 编码 / 日常与标准 / 计划 / 自主是两个正交维度；AgentMode 仍由输入框
 * 的模式控件和 Tab 快捷键负责。
 */
/**
 * 左栏默认展开多少个项目（N17）。
 * 超出的收在「更多项目（N）」后面；这只是**显示层**的限制，
 * 分组与项目归属不受影响。
 */
const PROJECT_PREVIEW = 5
/**
 * 项目下默认展开几个会话（用户 2026-09-18：「项目文件夹应该默认显示前五个会话，
 * 其余进行折叠」）。
 *
 * 与 `PROJECT_PREVIEW` 同一个理由：左栏是导航而不是列表 —— 一个项目攒到几十条
 * 会话之后，展开态会把下面的项目全挤出视野。
 * 当前会话落在折叠段里时会自动多展开到它那一行为止，否则用户看不到自己
 * 正待着的会话。
 */
const SESSION_PREVIEW = 5
/**
 * 左栏顶部「最近」区展示多少条最近打开过的会话。
 *
 * 与置顶区同一个定位：它是「快速回到刚才在看的会话」的导航捷径，
 * 不是第二个完整会话列表 —— 取太多会把下面的项目区整个挤出视野。
 * 已被置顶的会话不在这里重复出现（置顶区就在它上面）。
 */
const RECENT_PREVIEW = 5
/** Zustand selector 的稳定空值，禁止在 selector 内创建 `{}`。 */
const EMPTY_PROJECT_NAMES: Record<string, string> = {}

export function Rail() {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const session = useStore((s) => s.session)
  /* 只读打开的会话没有接管运行实例，`session` 仍是那个在跑的会话；高亮要跟着正在看的那条 */
  const viewingPath = useStore((s) => s.peekedPath ?? s.session?.sessionFile)
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

  /*
   * 收件箱入口（实施-28 T2/T5）。
   *
   * 计数放在组件本地而不是 store：这是一个“顺手看一眼”的角标，
   * 放 store 会让每个订阅者都跟着它重渲染。
   * 只算**真需要人**的三档（待确认 / 等你回答 / 出错）——
   * 把“进行中”也算进去，角标就会永远亮着，很快就没人看了。
   */
  const inboxOpen = useStore((s) => s.inboxOpen)
  const setInboxOpen = useStore((s) => s.setInboxOpen)
  const [inboxCount, setInboxCount] = useState(0)
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const res = await window.yan.taskInbox.page({ limit: 1, offset: 0 })
        if (!alive) return
        setInboxCount((res.counts.needs_review ?? 0) + (res.counts.waiting_user ?? 0) + (res.counts.failed ?? 0))
      } catch {
        /* 读不到就不显示角标（不要用 0 冒充“没有事”） */
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [inboxOpen])

  /*
   * 空间列表不依赖 pi（只读 Yan 自己的 spaces.json）。
   *
   * 左栏的空间分区已移除（实施-27 B3），但会话行的「归入空间」菜单
   * 仍要看到空间名 —— 所以这里保留一次拉取，渲染交给订阅 store 的会话行。
   */
  const refreshSpaces = useStore((s) => s.refreshSpaces)

  const [query, setQuery] = useState('')
  /* 搜索框常驻；点清空（✕）后焦点留在输入框，方便继续搜 */
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [projectsOpen, setProjectsOpen] = useSidebarValue('projects-open', true)
  const [collapsed, setCollapsed] = useSidebarValue<string[]>('collapsed-projects', [])
  /** 哪些项目已点开「更多会话」（按项目 id 记；默认只显示前 SESSION_PREVIEW 条） */
  const [shownAllSessions, setShownAllSessions] = useSidebarValue<string[]>('expanded-sessions', [])
  /*
   * 左栏收起（`railPinned` true → false）时只收回「更多会话」（实施-12 U-1）。
   *
   * 为什么必须显式监听而不是靠组件卸载：收起只是布局上的折叠，Rail 一直挂着
   *（hover 展开时还要用），卸载根本不会发生 —— 那样用户收起再打开会看到
   * 上次展开的几十条会话，与「收起 = 复位到预览」的用户口径不一致。
   *
   * 用 ref 记上一次的值：只在**真的发生 true→false 那一次**复位，
   * 而不是每次渲染都写状态（在 render 中写状态会多出一轮渲染）。
   * `setShownAllSessions` 来自 useSidebarValue（就是 setState），引用稳定。
   */
  const railPinned = useStore((s) => s.railPinned)
  const railWasPinned = useRef(railPinned)
  useEffect(() => {
    if (railWasPinned.current && !railPinned) {
      setShownAllSessions([])
      /* 临时菜单不能留在折叠起来的栏里（下次展开时它会磍在一个看不见的位置） */
      setMenuFor(null)
      setProjectMenu(null)
      setGroupMenu(null)
    }
    railWasPinned.current = railPinned
  }, [railPinned, setShownAllSessions])
  const [expanded, setExpanded] = useSidebarValue<string[]>('expanded-branches', [])
  /** 置顶存在宿主（会话索引），这里只取路径用于比对 */
  const pinned = useMemo(() => sessions.filter((s) => s.pinned).map((s) => s.path), [sessions])
  /** 视图：分组方式与排序。只改整理方式；「按项目」是原有的项目树。 */
  const [viewRaw, setViewRaw] = useSidebarJson('view', DEFAULT_RAIL_VIEW)
  const view = useMemo(() => normalizeRailView(viewRaw), [viewRaw])
  const projectMode = view.group === 'project'
  /** 归档视图只列已归档的会话，默认视图只列没归档的 */
  const showArchivedSessions = view.show === 'archived'
  const visibleSessions = useMemo(() => sessions.filter((s) => showArchivedSessions === !!s.archivedAt), [sessions, showArchivedSessions])

  /*
   * 旧版本把置顶存在本机 localStorage：第一次拿到会话列表时一次性搬进宿主，
   * 搬完删掉旧键。找不到对应会话的旧路径（已删除的会话）直接丢弃。
   */
  const pinMigrated = useRef(false)
  useEffect(() => {
    if (pinMigrated.current || sessions.length === 0) return
    pinMigrated.current = true
    let legacy: string[] = []
    try {
      const parsed = JSON.parse(localStorage.getItem('yan.sidebar.pinned') ?? 'null')
      legacy = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch { /* 读不出来就当没有 */ }
    if (!legacy.length) return
    const todo = sessions.filter((s) => legacy.includes(s.path) && !s.pinned)
    void (async () => {
      let failed = false
      for (const s of todo) {
        const res = await window.yan.setSessionPinned(s.id, true).catch(() => ({ ok: false }))
        if (!res.ok) failed = true
      }
      /* 有一条没写成功就保留旧键，下次启动再试；全成功才清 */
      if (!failed) { try { localStorage.removeItem('yan.sidebar.pinned') } catch { /* 存储不可用 */ } }
      await refreshSessions()
    })()
  }, [sessions, refreshSessions])
  const archived = useMemo(() => projectRecords.filter((p) => p.archived).map((p) => p.cwd), [projectRecords])
  const [showArchived, setShowArchived] = useState(false)
  const [unread, setUnread] = useSidebarValue<string[]>('unread', [])
  /** 运行实例状态（N12）：左栏每行/每项目/每分组的状态汇总都来自它 */
  const runners = useStore((s) => s.runners)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  /**
   * 某个会话列表里有几个正在跑。
   * 做成闭包是为了在渲染时按项目/分组直接算，不用再建索引。
   */
  const runningIn = useMemo(() => {
    const files = new Set(runners.filter((r) => r.running && r.sessionFile).map((r) => r.sessionFile!))
    return (list: SessionSummary[]): number => list.filter((s) => files.has(s.path)).length
  }, [runners])

  /**
   * 「最近」区：用户真的在砚里打开过的会话，跨项目按打开时间倒序。
   *
   * 入选判据用 `lastOpenedAt`（宿主在打开时记的）：后台续行、子代理写回会刷新
   * `lastActivityAt`，那会把「从没被打开过」的会话顶上来。
   * 但**排序**用 `lastActivityAt`（最后一条消息的时间）：只是查看一条会话不该让它跳到最上面，
   * 只有它真的有新消息（用户发送或回复）才上移，与项目内的会话排序一致。
   */
  const recentSessions = useMemo(
    () => visibleSessions
      .filter((s) => (s.lastOpenedAt ?? 0) > 0 && !pinned.includes(s.path) && !archived.includes(s.cwd))
      .sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt))
      .slice(0, RECENT_PREVIEW),
    [visibleSessions, pinned, archived]
  )

  /**
   * 非项目视图（按状态 / 日期 / 不分组）的分区。
   * 置顶会话留在置顶区，已归档项目的会话不出现；搜索按标题与目录过滤。
   */
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

  /**
   * 打开菜单的会话。
   *
   * ⚠️ 用 `key`（渲染实例）而不是只用 `path` 标识：同一条会话会同时出现在
   *    「最近 / 置顶」区和项目树里，两处是两个 SessionRow 实例。只按 path
   *    判断 `menuOpen` 会让**两个菜单同时打开、位置重叠**；用户点到的是另一个
   *    实例的菜单项，于是动作作用在没看到的那一行上 —— 表现为「点重命名/
   *    删除，菜单关了，但这一行没变」。`key` 由 `renderSession` 用
   *    「容器 + 会话路径」拼出，锚点与触发元素另外存。
   */
  const [menuFor, setMenuFor] = useState<{ key: string; path: string; x: number; y: number; trigger: HTMLElement | null } | null>(null)
  /** 正在重命名哪个项目（cwd）；null = 没有 */
  const [projRename, setProjRename] = useState<string | null>(null)
  const [projDraft, setProjDraft] = useState('')
  const [projectMenu, setProjectMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement | null } | null>(null)
  const [projectError, setProjectError] = useState('')
  const [groupingProject, setGroupingProject] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  /** 正在重命名哪个分组（groupId）；null = 没有（N01） */
  const [groupRename, setGroupRename] = useState<string | null>(null)
  /** 打开操作菜单的分组（N01；id 与浮层位置分开存） */
  const [groupMenu, setGroupMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement | null } | null>(null)
  /** 分组操作的错误提示：空白名 / 重名 / 保存失败（N01） */
  const [groupError, setGroupError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)
  /**
   * 待确认「移除项目」的记录（null = 没有）。
   * 只存 id 与显示名：真正的归属数据在设置里，弹窗不该拿着一份会过期的副本。
   */
  const [projectToRemove, setProjectToRemove] = useState<{ id: string; name: string } | null>(null)
  /*
   * 删除成功后的**轻量通知**（方案 15.2）。
   * 为什么不再用模态框报成功：已经执行完的可逆操作不该继续遮挡界面、
   * 再要求点一次「确定」。撤销记录留在本次运行的通知里，
   * 用户不点也随时能看到自己刚删了什么。
   */
  const [trashNotice, setTrashNotice] = useState<TrashNotice | null>(null)

  /** 撤销删除：通知条上的动作，非模态，不圈定焦点 */
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

  /*
   * 通知自动收走（方案 15）：
   *   · 删除成功 → 30 秒（给用户足够时间决定要不要恢复）
   *   · 恢复成功 → 2.6 秒（已经完成的操作不需要一直占着位置）
   *
   * 两种都要**重置并清理旧计时器**：新通知替换旧通知时用同一个 state 槽位，
   * 若不清理，旧的 30 秒计时会把新通知提前收走（连续删除时最容易复现）。
   * 恢复请求进行中（busy）不收走 —— 否则反馈会在请求完成前消失。
   */
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

  /**
   * 「完成未读」（N12）：后台会话跑完也要算未读。
   *
   * 旧实现只看**当前会话**（订阅 store 里的 session 槽位），所以切走之后
   * 别的会话跑完完全不会提示。现在比较两次 `runners` 快照：
   * 某个实例从 running 变 not running，且窗口不在前台 → 把那行标未读。
   */
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

  // 会话列表在有新消息后会变（标题、时间），settled 时刷一次
  const msgCount = useStore((s) => s.messages.length)
  useEffect(() => {
    if (msgCount === 0) return
    const id = setTimeout(() => void refreshSessions(), 800)
    return () => clearTimeout(id)
  }, [msgCount, refreshSessions])

  useEffect(() => {
    if (!menuFor && !projectMenu && !groupMenu) return
    /*
     * 点菜单以外的地方（含别的会话行、项目行）也要收菜单。
     * 菜单里的点击走 React 合成事件，不会冒到这里。
     */
    const close = (): void => { setMenuFor(null); setProjectMenu(null); setGroupMenu(null) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuFor, projectMenu, groupMenu])

  const { projects, displayProjects } = useRailProjects({ query, showArchived, sortBy: view.sort, showArchivedSessions })

  /**
   * 项目列表默认只展开前 N 个（N17）。
   *
   * 为什么是「项目」而不是「每个分组各 N 个」：项目多了以后左栏被拉得很长，
   * 用户要的是一次能看到最常用的几个；分组结构和归属一个都不动，
   * 只是**显示层**截断。搜索时临时全部展开。
   */
  const [projectsExpanded, setProjectsExpanded] = useState<boolean | null>(null)

  /** 当前项目在默认前 N 之外 → 自动展开（否则用户看不到自己在哪个项目里） */
  const currentOutOfPreview = useMemo(() => {
    const i = displayProjects.findIndex((p) => p.isCurrent)
    return i >= PROJECT_PREVIEW
  }, [displayProjects])

  /** 手工展开/收起优先（null = 还没点过，按「当前项目是否可见」自动决定） */
  const showAllProjects = !!query || (projectsExpanded ?? currentOutOfPreview)
  const shownProjects = showAllProjects ? displayProjects : displayProjects.slice(0, PROJECT_PREVIEW)
  const hiddenProjects = Math.max(0, displayProjects.length - PROJECT_PREVIEW)

  const { dragItem, dropHint, dropInto, beginDrag, consumeDragClick } = useRailDrag({
    query, projectsOpen, displayProjects, projectRecords, projectGroups, patchSettings,
    expandAllProjects: () => setProjectsExpanded(true)
  })

  /*
   * 切换项目时把「手工展开/收起」重置（N17）。
   *
   * 为什么：手工状态是相对于「当时看到的那批项目」的，换了项目/工作目录
   * 还沿用旧选择，就会出现「切到一个排在第 8 位的项目，左栏却看不到它」。
   * 重置后回到自动规则 —— 当前项目在前五之外就自动展开到它。
   */
  useEffect(() => {
    setProjectsExpanded(null)
  }, [session?.cwd])

  /** 每个分组的运行汇总（N12）：分组标题上显示「N 个在跑」 */
  const groupRunning = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of displayProjects) {
      const gid = projectRecords.find((r) => r.cwd === p.cwd)?.groupId
      if (!gid) continue
      m.set(gid, (m.get(gid) ?? 0) + runningIn(p.list))
    }
    return m
  }, [displayProjects, projectRecords, runningIn])

  /**
   * 会话分支关系（用户要求：左栏显示分支数 / 分支编号）。
   *
   * 数据来自 pi 的 session 头：`parentSession` 指向分叉来源的会话文件。
   * 从这里算出：
   *   · branchCount：这个会话被分叉出去几次（父会话行上显示）
   *   · branchIndex：这个会话是父会话的第几个分支（子会话行上显示 #N）
   * 编号按 createdAt 升序 —— 与分支创建的先后一致。
   */
  /*
   * 分支编号（实施-18 S1 下沉到 shared/session-map）：同一份纯逻辑
   * 供左栏与工作区会话地图共用 —— 两边编号必须一致。
   */
  const { branchIndex } = useMemo(() => buildBranchIndex(sessions), [sessions])

  const toggleProject = (key: string): void =>
    setCollapsed((prev) => prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key])
  /**
   * 保存项目显示名（N06）。
   *
   * 双击改名入口已移除，重命名只从项目菜单进入 —— 单击始终是
   * 「切换/折叠项目」，不会因为手快点两下就掉进输入框。
   * 保存失败时**保留输入**并把错误显示在项目区顶部：直接关掉输入框
   * 会让用户以为改名成功，而磁盘上什么都没写。
   */
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
  /**
   * 重命名分组（N01）。
   *
   * 只改分组名：`groupId` 与项目归属一个字节都不动，所以重启后
   * 分组关系照旧。空白名和重名（忽略大小写，排除自己）都**保留输入**
   * 并就地给提示 —— 关掉输入框会让人以为改好了。
   */
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

  /**
   * 解散分组（N01）：只去掉分组和归属，**不删**任何项目、会话或目录。
   * 项目回到未分组区域（仍然可用、仍能重新分组）。
   */
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

  /**
   * 切到某个项目（N05）。
   *
   * 与旧实现的区别：旧的是「停掉当前 pi 再在新 cwd 起一个」，所以点一下
   * 别的项目 = 后台任务全没。现在 `yan:setCwd` 只更新设置里的当前项目，
   * 视图切到该项目**最近访问的会话**（没有就新建一个空会话），
   * 其它项目里正在跑的会话一个都不动。
   */
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
    /*
     * 选「该项目最近访问的会话」交给 store 的纯逻辑（运行实例优先，其次会话
     * 列表）—— 只看 `sessions` 会漏掉「刚建、还没落盘就切走」的会话，那种情况
     * 下会新建一个空会话，用户之前敲的草稿（按 sessionId 存在运行时缓存里）就丢了。
     */
    /*
     * 先把会话列表拉新（实施-09 S3）。
     *
     * `pickProjectSession` 的判据 `lastOpenedAt` 是主进程记在布局索引里的，
     * 而这里的 `sessions` 是**切会话之前**的快照 —— 不刷新的话，「刚才打开的是哪个」
     * 这层信息根本不在输入里（S3 的反向验证就是这么暴露的：换回旧排序也照样绿，
     * 因为两条会话都读不到 `lastOpenedAt`）。
     * 一次目录扫描与解析，切项目本来就慢，这点开销换的是“恢复对的那一个”。
     */
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
  /**
   * 会话行菜单：按**渲染实例**（`key`）而非会话路径开菜单，位置与触发元素另外存。
   * 菜单由 `ContextMenuSurface` Portal 到 body —— 行内渲染会被 `.rail-body`
   * 的 `overflow` 裁掉（列表最后几行最明显），也会顶大行的 scrollHeight。
   */
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

  /*
   * 空间列表不依赖 pi（只读 Yan 自己的 `spaces.json`），挂载就拉一次；
   * pi 就绪后 `startConnWatch` 会再拉一次（那时新会话的归属才可能已存在）。
   */
  useEffect(() => {
    void refreshSpaces()
  }, [refreshSpaces])

  const renderSession = (s: SessionSummary, list: SessionSummary[], depth = 0, lineage = new Set<string>(), containerKey = ''): React.ReactNode => {
    if (lineage.has(s.path)) return null
    const next = new Set(lineage).add(s.path)
    const children = list.filter((c) => c.parentSession === s.path && !next.has(c.path))
    const isOpen = !!query || expanded.includes(s.path)
    /* 渲染实例的标识：同一条会话在「最近/置顶」区与项目树里是两个实例 */
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
      {/*
       * 顶部：新对话 + 常驻搜索框。品牌只在标题栏出现一次；
       * 「编码 / 日常」工作区形态在设置 · 工作区里切换。
       */}
      <div className="rail-top">
        <button className="rail-action" onClick={() => void newSession({ scope: 'global' })} data-testid="rail-new">
          <Icon name="plus" size={14} />
          <span>{t('rail.new')}</span>
          <kbd className="ui-kbd plain">Ctrl N</kbd>
        </button>
        <div className="rail-search-row">
        <label className="rail-search">
          <Icon name="search" size={12} />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            /* Esc：先清空查询，再按一次离开输入框 */
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
                /* 清空之后大概率还要继续搜 —— 焦点留在输入框 */
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

      {/* ---- 项目分组 ---- */}
      <div className="rail-section">
        <div className="rail-body">
          {projectError ? <div className="rail-empty" role="alert">{projectError}</div> : null}
          {!query && !showArchived && !showArchivedSessions && pinned.some((p) => sessions.some((s) => s.path === p && !s.archivedAt && !archived.includes(s.cwd))) ? <div className="rail-pins">
            <div className="rail-section-head"><span className="rail-label">{t('rail.pinned')}</span><span className="rail-label-line" aria-hidden /></div>
            {sessions.filter((s) => pinned.includes(s.path) && !s.archivedAt && !archived.includes(s.cwd)).map((s) => renderSession({ ...s, title: manualTitles[s.id] || titles[s.id] || s.title }, []))}
          </div> : null}
          {/*
            * 最近打开过的会话（跨项目）。
            * 只在未搜索、未看归档时显示：搜索是另一套筛选语境，
            * 归档视图里项目区本身就在展示被移除的项目。
            */}
          {projectMode && !query && !showArchived && !showArchivedSessions && recentSessions.length > 0 ? <div className="rail-recent" data-testid="rail-recent">
            <div className="rail-section-head"><span className="rail-label">{t('rail.recent')}</span><span className="rail-label-line" aria-hidden /></div>
            {recentSessions.map((s) => renderSession({ ...s, title: manualTitles[s.id] || titles[s.id] || s.title }, []))}
          </div> : null}
          {/* 没有归档项目时不摆「已归档项目 · 0」：一个永远指向空列表的入口只是噪音 */}
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
                      /* 拖完松手会紧跟一个 click；标题本身没有点击行为，但里面的菜单按钮有 */
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
                              /* 直接保存，不绕 blur：无焦点环境下 blur 不可靠，
                                 而且 Enter 的语义就是「提交」。 */
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
                    /* 项目行内重命名：Enter 提交 / Esc 取消 / 失焦提交 */
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
                            /* 直接保存（理由同分组重命名：Enter 的语义就是提交） */
                            void saveRename(p.cwd)
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setProjRename(null)
                          }
                        }}
                      />
                    </div>
                  ) : (
                  /*
                   * 项目行拆成两个独立动作（N05）：
                   *   · 名称/图标 → **切到这个项目**（切视图，不停任何会话）
                   *   · 右侧箭头 → 只折叠/展开会话树
                   * 以前整行都是折叠按钮，想切项目只能从菜单里点「新对话」。
                   */
                  <div
                    className={`proj-head ${pOpen ? '' : 'collapsed'}${dragItem?.kind === 'project' && dragItem.id === p.projectId ? ' is-dragging' : ''}${dropHint?.kind === 'project' && dropHint.id === p.projectId ? (dropHint.after ? ' drop-after' : ' drop-before') : ''}${dropInto?.key === (p.projectId ? `project:${p.projectId}` : `global:${p.cwd}`) ? ' drop-into' : ''}`}
                    onContextMenu={(e) => { e.preventDefault(); if (p.projectId) setProjectMenu({ id: p.id, x: e.clientX, y: e.clientY, trigger: e.currentTarget }) }}
                    title={p.cwd}
                    data-testid="rail-project-row"
                    data-current={p.isCurrent ? '1' : '0'}
                    /* 拖进来的落点（会话拖拽用）；同名属性在项目行与全局行上都有 */
                    data-drop-into={p.projectId ? `project:${p.projectId}` : `global:${p.cwd}`}
                    /* 只有持久化的项目能排序：`global:` 行没有记录，排了也无处存 */
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
                      {/* 没登记成项目的目录（全局会话）用地球图标区分，名字只写目录名 */}
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
                          // ⚠️ Electron 不支持 window.prompt（返回 null，什么都发生不了）
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
                      { id: 'rail-project-reveal', label: t('rail.reveal'), icon: 'folder-open', onSelect: () => { void window.yan.revealPath(p.cwd) } },
                      { id: 'rail-project-copy', label: t('rail.copyPath'), onSelect: () => { void navigator.clipboard.writeText(p.cwd) } },
                      {
                        id: 'rail-project-remove',
                        label: showArchived ? t('rail.restoreProject') : t('rail.removeProject'),
                        icon: showArchived ? 'refresh' : 'alert-circle',
                        danger: !showArchived,
                        onSelect: () => {
                          /*
                           * 归档视图里这个位置是「恢复」（直接生效，不弹框）；
                           * 正常视图里是「移除」—— 先弹确认框再说，因为
                           * 项目会从列表里消失，用户需要先知道会话去哪了。
                           */
                          if (showArchived) {
                            void patchSettings({ projects: projectRecords.map((project) => project.id === p.projectId ? { ...project, archived: false, updatedAt: Date.now() } : project) })
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
                      void patchSettings({ projectGroups: existing ? projectGroups : [...projectGroups, group], projects: projectRecords.map((project) => project.id === p.projectId ? { ...project, groupId: group.id, updatedAt: Date.now() } : project) })
                      setGroupingProject(null)
                    }}>{t('rail.saveGroup')}</button>
                    {projectGroups.map((group) => <button key={group.id} onClick={() => { void patchSettings({ projects: projectRecords.map((project) => project.id === p.projectId ? { ...project, groupId: group.id, updatedAt: Date.now() } : project) }); setGroupingProject(null) }}>{group.name}</button>)}
                    <button onClick={() => { void patchSettings({ projects: projectRecords.map((project) => project.id === p.projectId ? { ...project, groupId: undefined, updatedAt: Date.now() } : project) }); setGroupingProject(null) }}>{t('rail.noGroup')}</button>
                  </div> : null}
                  {pOpen ? (() => {
                    /*
                     * 只渲染「根会话」（分叉出来的子会话走 SessionRow 的子树），
                     * 并按 SESSION_PREVIEW 折叠 —— 一个项目几十条会话时，
                     * 展开态会把下面的项目全部挤出视野。
                     */
                    const roots = p.list.filter((s) => !s.parentSession || !p.list.some((x) => x.path === s.parentSession))
                    /* 当前会话若落在折叠段里，至少展开到它那一行（不能把自己藏起来） */
                    const currentIndex = roots.findIndex((s) => s.path === viewingPath)
                    const floor = Math.max(SESSION_PREVIEW, currentIndex + 1)
                    const all = shownAllSessions.includes(p.id)
                    const limit = all ? roots.length : floor
                    const hidden = roots.length - limit
                    /* 容器 key：拖会话进来时靠它认出「落到了哪个项目」 */
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
                      {/* 只有真能收起来时才给这个出口：当前会话在深处时，
                          “收起”会立刻又展开到它那一行，看着像没反应 */}
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
          {/* ---- 更多项目（N17）：默认只展开前 5 个 ---- */}
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

      {/* ---- 底部：收件箱入口 + 用户块（名字 / 自定义头像 / 登录预留）---- */}
      <button
        className={`rail-inbox${inboxOpen ? ' on' : ''}`}
        data-testid="rail-inbox"
        data-count={inboxCount}
        title={t('inbox.title')}
        onClick={() => setInboxOpen(!inboxOpen)}
      >
        <Icon name="checklist" size={14} />
        <span>{t('inbox.title')}</span>
        {inboxCount > 0 ? <span className="ui-badge warn rail-inbox-badge">{inboxCount}</span> : null}
      </button>
      <RailUser />
      {trashNotice ? (
        <TrashNoticeBar
          notice={trashNotice}
          onUndo={() => void undoTrash()}
          onClose={() => setTrashNotice(null)}
        />
      ) : null}

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
