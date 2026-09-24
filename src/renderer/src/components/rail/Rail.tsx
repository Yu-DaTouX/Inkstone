import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../../icons/Icon'
import { BrandMark } from '../shell/BrandMark'
import { ContextMenu, ContextMenuSurface, type ContextMenuAnchor } from '../common/ContextMenu'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import { beforeFromDrop, orderAfterDrag, rankOf } from '../../../../shared/rail-order'
import { shortProject } from './rail-utils'
import { forkLatest } from '../../lib/fork'
import { RailUser } from './RailUser'
import { ancestorPaths, useSidebarValue } from './sidebar-state'
import { nextWorkspaceMode, type WorkspaceMode } from '../../../../shared/workspace-mode'

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
const RAIL_MODES = [
  { id: 'coding', labelKey: 'mode.coding' },
  { id: 'daily', labelKey: 'mode.daily' }
] as const

type RailModeId = (typeof RAIL_MODES)[number]['id']
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
/** Zustand selector 的稳定空值，禁止在 selector 内创建 `{}`。 */
const EMPTY_PROJECT_NAMES: Record<string, string> = {}
/** 同上：项目顺序的稳定空值 */
const EMPTY_IDS: string[] = []

/**
 * 拖拽排序（N01）的距离阈值（px）。
 *
 * 为什么要阈值：项目行同时是「切项目」按钮、分组标题里的名字也能被点 ——
 * 按下就进入拖拽会让单击全部失效。超过这个距离才当拖拽，没超过一律当点击。
 */
const DRAG_THRESHOLD = 4

type DragKind = 'project' | 'group'
/** 插入线落点：插在 `id` 这一行的**前**（after=false）或**后**（after=true） */
interface DropHint {
  kind: DragKind
  id: string
  after: boolean
}
/** 一次拖拽会话（存在 ref 里，pointermove 高频且回调要读最新值） */
interface DragSession {
  kind: DragKind
  id: string
  /** 项目所属分组；落点必须同组（跨组是归属变更，走右键菜单） */
  groupId: string
  startX: number
  startY: number
  /** 是否已越过阈值、真正进入拖拽态 */
  active: boolean
}

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
  /** 用户拖拽定下的项目顺序（N01）；空 = 未拖过，按原活动序 */
  const projectOrder = settings?.projectOrder ?? EMPTY_IDS
  const patchSettings = useStore((s) => s.patchSettings)

  const [query, setQuery] = useState('')
  /*
   * 搜索的两个焦点锚点。
   *
   * 为什么要它们：打开搜索时输入框是 `autoFocus`（焦点自然在那儿），
   * 但**清空/关掉之后焦点就没人管了** —— 输入框一卸载，焦点掉回 body，
   * 键盘用户得从头 Tab 一遍才能回到左栏。
   *   · 清空（✕）后仍想继续搜 → 焦点回输入框
   *   · 关掉搜索（Esc）后 → 焦点还给那个开关按钮
   */
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchBtnRef = useRef<HTMLButtonElement>(null)
  const [searching, setSearching] = useState(false)
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
  const [pinned, setPinned] = useSidebarValue<string[]>('pinned', [])
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

  /** 打开菜单的会话（path / 位置 / 触发元素分开存，位置只用来定位浮层） */
  const [menuFor, setMenuFor] = useState<{ path: string; x: number; y: number; trigger: HTMLElement | null } | null>(null)
  /** 正在重命名哪个项目（cwd）；null = 没有 */
  const [projRename, setProjRename] = useState<string | null>(null)
  const [projDraft, setProjDraft] = useState('')
  /** 左栏工作区入口；不读取也不改当前会话的 AgentMode。 */
  const workspaceMode = useStore((s) => s.workspaceMode)
  const setWorkspaceMode = useStore((s) => s.setWorkspaceMode)
  const activeRailMode: RailModeId = workspaceMode
  const activeRailModeConfig = RAIL_MODES.find((m) => m.id === activeRailMode)!
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
      const path = useStore.getState().session?.sessionFile
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

  /** 按项目（cwd）分组；当前项目永远排最前，其余按最近活动排 */
  const projects = useMemo(() => {
    const q = query.trim().toLowerCase()
    const activity = (s: SessionSummary): number => s.lastActivityAt ?? s.updatedAt
    const recordsById = new Map(projectRecords.map((project) => [project.id, project]))
    const activeProjectId = runners.find((runner) => runner.id === activeRunnerId)?.projectId
    const currentSummary = sessions.find((item) => item.id === session?.sessionId || item.path === session?.sessionFile)
    const currentProjectId = activeProjectId ?? currentSummary?.projectId

    /** 同一项目里的分支仍然按“根会话 + 子会话”连续展示。 */
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
      for (const s of list) push(s)
      return out
    }

    const currentPath = session?.sessionFile
    const synthetic: SessionSummary[] = currentPath && !sessions.some((x) => x.path === currentPath)
      ? [{
          id: session?.sessionId ?? 'current',
          path: currentPath,
          cwd: session?.cwd ?? '',
          title: session?.sessionName ?? t('rail.untitled'),
          named: !!session?.sessionName,
          ...(currentProjectId ? { projectId: currentProjectId, scope: 'project' as const } : { scope: 'global' as const }),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 0
        }]
      : []

    // 用模型生成的短标题覆盖列表标题（如果有）；用户手动名优先。
    const all = [...synthetic, ...sessions].map((x) => {
      const manual = manualTitles[x.id]
      if (manual) return { ...x, title: manual, named: true }
      const generated = titles[x.id]
      return generated ? { ...x, title: generated } : x
    })
    const parents = new Map(all.filter((s) => s.parentSession).map((s) => [s.path, s.parentSession!]))
    const projectFor = (s: SessionSummary): {
      id: string
      cwd: string
      label: string
      projectId?: string
    } => {
      const record = s.projectId ? recordsById.get(s.projectId) : undefined
      if (record) {
        return {
          id: `project:${record.id}`,
          projectId: record.id,
          cwd: record.cwd,
          label: record.name || projectNames[record.cwd] || shortProject(record.cwd)
        }
      }
      const cwd = s.cwd || '—'
      return {
        id: `global:${cwd}`,
        cwd,
        label: cwd === '—' ? t('rail.local') : `${t('rail.global')} · ${shortProject(cwd)}`
      }
    }

    const matches = new Set<string>()
    for (const s of all) {
      const project = projectFor(s)
      if (!q || [s.title, s.cwd, project.label, projectNames[s.cwd] ?? ''].some((v) => v.toLowerCase().includes(q))) {
        matches.add(s.path)
        for (const p of ancestorPaths(s.path, parents)) matches.add(p)
      }
    }
    const filtered = all.filter((s) => matches.has(s.path))
    const byProject = new Map<string, { id: string; cwd: string; label: string; projectId?: string; list: SessionSummary[] }>()
    const addProject = (project: ReturnType<typeof projectFor>, list: SessionSummary[] = []): void => {
      const previous = byProject.get(project.id)
      if (previous) previous.list.push(...list)
      else byProject.set(project.id, { ...project, list: [...list] })
    }

    // 先把设置里的项目放入列表，即使它暂时没有会话，项目入口仍然稳定。
    for (const record of projectRecords) {
      const label = record.name || projectNames[record.cwd] || shortProject(record.cwd)
      if (!q || label.toLowerCase().includes(q) || record.cwd.toLowerCase().includes(q)) {
        addProject({ id: `project:${record.id}`, projectId: record.id, cwd: record.cwd, label })
      }
    }
    for (const s of filtered) addProject(projectFor(s), [s])

    // 没有 ProjectRecord 的旧 cwd 仍要作为一个可访问的全局位置保留。
    for (const cwd of settings?.recentCwds ?? []) {
      const alreadyShown = [...byProject.values()].some((project) => project.cwd.toLowerCase() === cwd.toLowerCase())
      if (!alreadyShown && (!q || (projectNames[cwd] || cwd).toLowerCase().includes(q))) {
        addProject({ id: `global:${cwd}`, cwd, label: `${t('rail.global')} · ${shortProject(cwd)}` })
      }
    }

    const cur = session?.cwd
    /*
     * 项目顺序（N01）：用户拖过的按 `projectOrder`；没拖过的仍按最近活动排。
     * 「当前项目置顶」保留 —— 它是切项目后的定位手段，与用户排的顺序不冲突
     * （两者只能有一个在最上面，置顶优先）。
     */
    const rank = rankOf(projectOrder)
    return [...byProject.values()]
      .map((project) => ({
        ...project,
        list: orderFamily(project.list),
        isCurrent: project.projectId ? project.projectId === currentProjectId : !currentProjectId && project.cwd === cur
      }))
      .filter((project) => showArchived === !!(project.projectId && recordsById.get(project.projectId)?.archived))
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
        const ar = a.projectId ? rank.get(a.projectId) : undefined
        const br = b.projectId ? rank.get(b.projectId) : undefined
        if (ar !== undefined || br !== undefined) {
          if (ar === undefined) return 1
          if (br === undefined) return -1
          if (ar !== br) return ar - br
        }
        const at = (p: { list: SessionSummary[] }) => p.list[0] ? activity(p.list[0]) : 0
        return at(b) - at(a)
      })
  }, [sessions, query, session, t, titles, manualTitles, projectNames, projectRecords, projectOrder, settings?.recentCwds, archived, showArchived, runners, activeRunnerId])

  // 将项目实体按持久化分组重新排列；分组标题会在项目列表中作为一级标题显示。
  // 组内仍保留项目原本的活动排序，未分组项目统一放在最后。
  const displayProjects = useMemo(() => {
    const groupIdFor = (project: (typeof projects)[number]): string | undefined =>
      project.projectId ? projectRecords.find((record) => record.id === project.projectId)?.groupId : undefined
    const byGroup = new Map<string, typeof projects>()
    for (const project of projects) {
      const key = groupIdFor(project) ?? ''
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

  /*
   * ------------------------------------------------------------------
   * 拖拽排序（N01）
   *
   * 为什么自己写指针拖拽而不用 HTML5 的 `draggable`：
   *   · 原生 dragstart/dragover 在自动化里只能靠底层接口合成，
   *     而本项目的验收铁律是「在真实窗口里跑出来」；
   *   · 原生拖拽的拖影 / dropEffect 跳平台不一致。
   * 用 pointerdown / move / up + elementFromPoint，行为全由这里的代码决定，
   * 探针合成 PointerEvent 就能走同一条路径。
   *
   * 与「搜索」「前五项折叠」的关系（互斥）：
   *   · 搜索态下列表是筛过的，拖出来的顺序不代表真实排列 → 不允许拖；
   *   · 折叠态下看不到第 6 个以后的项目 → 真正开始拖就自动展开，
   *     否则会出现「拖不到看不见的行」。
   * ------------------------------------------------------------------
   */
  /** 拖拽中的行（用于 `.is-dragging` 视觉态）；null = 没在拖 */
  const [dragItem, setDragItem] = useState<{ kind: DragKind; id: string } | null>(null)
  /** 插入线落点 */
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  /** 拖拽会话（事件回调是 pointerdown 那一刻的闭包，必须经 ref 读最新值） */
  const dragRef = useRef<DragSession | null>(null)
  const dropHintRef = useRef<DropHint | null>(null)
  /**
   * 屏幕上真实渲染出来的分组顺序。
   * **不等于** `projectGroups`：没有项目的分组根本不渲染标题（标题是跟着
   * 第一个项目行出来的），拿 `projectGroups` 排会出现「拖了没反应」。
   */
  const renderedGroupIds = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const project of displayProjects) {
      const gid = project.projectId ? projectRecords.find((record) => record.id === project.projectId)?.groupId : undefined
      if (gid && !seen.has(gid)) {
        seen.add(gid)
        out.push(gid)
      }
    }
    return out
  }, [displayProjects, projectRecords])
  /** 落盘时要用的「当前排列」快照（pointerup 读它，保证不是旧渲染的数组） */
  const orderRef = useRef({ projects: displayProjects, groups: renderedGroupIds })
  useEffect(() => {
    orderRef.current = { projects: displayProjects, groups: renderedGroupIds }
  }, [displayProjects, renderedGroupIds])
  /* 组件卸载（拖拽中切走）时别把类名留在 body 上 */
  useEffect(() => () => document.body.classList.remove('rail-dragging'), [])

  /** 同步落点：state 给渲染用，ref 给 pointerup 用 */
  const setHint = (hint: DropHint | null): void => {
    dropHintRef.current = hint
    setDropHint(hint)
  }

  /** 拆掉监听与视觉态；`keepSession` = 把会话留给随后的 click 消费（见 consumeDragClick） */
  function cleanupDrag(keepSession: boolean): void {
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragUp)
    window.removeEventListener('pointercancel', onDragCancel)
    window.removeEventListener('keydown', onDragKey)
    document.body.classList.remove('rail-dragging')
    setDragItem(null)
    setHint(null)
    if (!keepSession) dragRef.current = null
  }

  /** 指针落在哪一行上：上半 → 插到它之前；下半 → 插到它之后 */
  function hintAt(x: number, y: number, session: DragSession): DropHint | null {
    const under = document.elementFromPoint(x, y) as HTMLElement | null
    const row = under?.closest<HTMLElement>(`[data-drag-kind="${session.kind}"]`)
    const id = row?.dataset.dragId
    if (!row || !id || id === session.id) return null
    /*
     * 项目只在**同一个分组内**换位，跨组的落点一律不接受。
     * 「把项目移到另一个分组」是归属变更（右键菜单里已有明确入口），
     * 让拖拽同时表示「换组」和「换序」会让一次误拖悄悄改掉归属。
     */
    if (session.kind === 'project' && (row.dataset.dragGroup ?? '') !== session.groupId) return null
    const rect = row.getBoundingClientRect()
    return { kind: session.kind, id, after: y > rect.top + rect.height / 2 }
  }

  function onDragMove(e: PointerEvent): void {
    const session = dragRef.current
    if (!session) return
    if (!session.active) {
      if (Math.hypot(e.clientX - session.startX, e.clientY - session.startY) < DRAG_THRESHOLD) return
      session.active = true
      /* 折叠态下后面的行不可见 —— 进入拖拽就展开，否则拖不过去 */
      setProjectsExpanded(true)
      setDragItem({ kind: session.kind, id: session.id })
      document.body.classList.add('rail-dragging')
    }
    e.preventDefault()
    setHint(hintAt(e.clientX, e.clientY, session))
  }

  function onDragUp(): void {
    const session = dragRef.current
    const hint = dropHintRef.current
    cleanupDrag(true)
    if (!session?.active || !hint) return
    const { projects: list, groups } = orderRef.current
    if (session.kind === 'group') {
      const nextIds = orderAfterDrag(groups, session.id, beforeFromDrop(groups, hint.id, hint.after))
      if (nextIds.join('\u0000') === groups.join('\u0000')) return
      const byId = new Map(projectGroups.map((group) => [group.id, group]))
      const ordered = nextIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      /* 没渲染的分组（暂时没项目）保持相对位置跟在后面，不能丢 */
      const rest = projectGroups.filter((group) => !nextIds.includes(group.id))
      void patchSettings({ projectGroups: [...ordered, ...rest] })
      return
    }
    const ids = list.flatMap((project) => (project.projectId ? [project.projectId] : []))
    const nextIds = orderAfterDrag(ids, session.id, beforeFromDrop(ids, hint.id, hint.after))
    if (nextIds.join('\u0000') === ids.join('\u0000')) return
    void patchSettings({ projectOrder: nextIds })
  }

  function onDragCancel(): void {
    cleanupDrag(false)
  }

  function onDragKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    e.preventDefault()
    cleanupDrag(false)
  }

  /**
   * 开始一次可能的拖拽。
   *
   * 不在这里 preventDefault：项目行整行也是「切到该项目」的按钮，
   * 按下就拦掉会让单击失效 —— 只有越过阈值、真正进入拖拽后才接管。
   */
  function beginDrag(e: ReactPointerEvent, kind: DragKind, id: string, groupId = ''): void {
    if (e.button !== 0) return
    if (query) return
    if (!projectsOpen) return
    /* 行内的按钮 / 输入框有自己的语义，不要让拖拽把它们吃掉（项目名按钮除外，它就是把手） */
    if ((e.target as HTMLElement).closest('button:not(.proj-pick), input, [role="button"]')) return
    dragRef.current = { kind, id, groupId, startX: e.clientX, startY: e.clientY, active: false }
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragUp)
    window.addEventListener('pointercancel', onDragCancel)
    window.addEventListener('keydown', onDragKey)
  }

  /**
   * 拖拽结束后紧跟而来的 click 不该再当成「点这一行」。
   *
   * click 一定在 pointerup 之后、下一次 pointerdown 之前派发，所以在 click
   * 处理器里读到「上一次拖拽仍活着」就吞掉它，然后清掉标记。
   * 用时间戳不行 —— 拖完立刻点同一行会被误吞。
   */
  function consumeDragClick(): boolean {
    if (!dragRef.current?.active) return false
    dragRef.current = null
    return true
  }

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
   * 会话行菜单：位置与触发元素和会话身份分开存。
   * 菜单由 `ContextMenuSurface` Portal 到 body —— 行内渲染会被 `.rail-body`
   * 的 `overflow` 裁掉（列表最后几行最明显），也会顶大行的 scrollHeight。
   */
  const openSessionMenu = (path: string) => (trigger: HTMLElement | null, point?: { x: number; y: number }): void => {
    if (menuFor?.path === path) { setMenuFor(null); return }
    const rect = trigger?.getBoundingClientRect()
    setMenuFor({ path, x: point?.x ?? rect?.left ?? 0, y: point?.y ?? rect?.bottom ?? 0, trigger })
  }
  const closeSessionMenu = (): void => {
    const trigger = menuFor?.trigger
    setMenuFor(null)
    trigger?.focus?.()
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
      menuOpen={menuFor?.path === s.path} menuAnchor={menuFor?.path === s.path ? menuFor : null}
      onOpenMenu={openSessionMenu(s.path)} onCloseMenu={closeSessionMenu}
      onSelect={() => void select(s.path)} pinned={pinned.includes(s.path)} unread={unread.includes(s.path)}
      projectRecords={projectRecords}
      onPin={() => setPinned((prev) => prev.includes(s.path) ? prev.filter((p) => p !== s.path) : [...prev, s.path])}
      onRequestDelete={() => setDeleteTarget(s)} />
  }

  const total = sessions.length
  const shown = projects.reduce((n, p) => n + p.list.length, 0)

  return (
    <aside className="rail">
      {/* ---- 顶部：品牌模式开关 + 动作 ---- */}
      <div className="rail-top">
        {/* 品牌标记同时是二态工作模式开关；标题栏不再重复显示品牌图标。 */}
        <div className="rail-mode-wrap">
          <button
            className={`rail-mode-btn ${activeRailMode === 'coding' ? 'on' : ''}`}
            onClick={() => {
              void setWorkspaceMode(nextWorkspaceMode(workspaceMode as WorkspaceMode))
            }}
            data-testid="mode-switch"
            role="switch"
            aria-checked={activeRailMode === 'coding'}
            aria-label={`${t('mode.switch')}：${t(activeRailModeConfig.labelKey)}（工作区）`}
            title={`${t('mode.switch')}：${t(activeRailModeConfig.labelKey)}（工作区，不改变模型模式）`}
          >
            <span className="rail-mode-icon" aria-hidden="true"><BrandMark size={18} /></span>
            <span className="rail-mode-copy">
              <span className="rail-mode-brand">砚</span>
              <span className="rail-mode-value">{t(activeRailModeConfig.labelKey)}</span>
            </span>
            <span className="rail-switch-track" aria-hidden="true">
              <span className="rail-switch-thumb" />
            </span>
          </button>
        </div>
        <button
          ref={searchBtnRef}
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
            ref={searchInputRef}
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            /*
             * Esc：关掉搜索并把焦点还给开关。
             * 与设置面板一致 —— 弹层关掉后焦点回到打开它的那个东西。
             */
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              setQuery('')
              setSearching(false)
              searchBtnRef.current?.focus()
            }}
            placeholder={t('rail.search')}
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
              ✕
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ---- 操作行 ---- */}
      <button className="rail-action" onClick={() => void newSession({ scope: 'global' })} data-testid="rail-new">
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
                          <Icon name="layers" size={12} className="proj-group-ico" />
                          <span className="proj-group-name" title={group.name}>{group.name}</span>
                          {(groupRunning.get(group.id) ?? 0) > 0 ? (
                            <span
                              className="proj-group-running"
                              data-testid="rail-group-running"
                              title={t('rail.runningCount', { n: groupRunning.get(group.id) ?? 0 })}
                            >
                              <Icon name="activity" size={12} />
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
                          icon: 'tag',
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
                    className={`proj-head ${pOpen ? '' : 'collapsed'}${dragItem?.kind === 'project' && dragItem.id === p.projectId ? ' is-dragging' : ''}${dropHint?.kind === 'project' && dropHint.id === p.projectId ? (dropHint.after ? ' drop-after' : ' drop-before') : ''}`}
                    onContextMenu={(e) => { e.preventDefault(); if (p.projectId) setProjectMenu({ id: p.id, x: e.clientX, y: e.clientY, trigger: e.currentTarget }) }}
                    title={p.cwd}
                    data-testid="rail-project-row"
                    data-current={p.isCurrent ? '1' : '0'}
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
                      title={`${p.label}\n${p.cwd}`}
                      aria-current={p.isCurrent ? 'true' : undefined}
                      onClick={() => void switchProject(p.cwd, p.projectId)}
                    >
                      <Icon name={pOpen ? 'folder-open' : 'folder'} size={12} />
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
                        <Icon name="activity" size={12} />
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
                      { id: 'rail-project-rename', label: t('rail.renameProject'), icon: 'tag', onSelect: () => { setProjDraft(p.label); setProjRename(p.cwd) } },
                      { id: 'rail-project-reveal', label: t('rail.reveal'), icon: 'folder-open', onSelect: () => { void window.yan.revealPath(p.cwd) } },
                      { id: 'rail-project-copy', label: t('rail.copyPath'), onSelect: () => { void navigator.clipboard.writeText(p.cwd) } },
                      {
                        id: 'rail-project-archive',
                        label: showArchived ? t('rail.restoreProject') : t('rail.archiveProject'),
                        onSelect: () => { void patchSettings({ projects: projectRecords.map((project) => project.id === p.projectId ? { ...project, archived: !showArchived, updatedAt: Date.now() } : project) }) }
                      },
                      { id: 'rail-project-group', label: t('rail.moveGroup'), icon: 'layers', onSelect: () => { setGroupingProject(p.cwd); setGroupDraft('') } }
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
                    const currentIndex = roots.findIndex((s) => s.path === session?.sessionFile)
                    const floor = Math.max(SESSION_PREVIEW, currentIndex + 1)
                    const all = shownAllSessions.includes(p.id)
                    const limit = all ? roots.length : floor
                    const hidden = roots.length - limit
                    return <>
                      {roots.slice(0, limit).map((s) => renderSession(s, p.list))}
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
        </div>
      </div>

      {/* ---- 底部：用户块（名字 / 自定义头像 / 登录预留）---- */}
      {trashNotice ? (
        <TrashNoticeBar
          notice={trashNotice}
          onUndo={() => void undoTrash()}
          onClose={() => setTrashNotice(null)}
        />
      ) : null}
      <RailUser />
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

/** 删除成功后的轻量通知状态（非模态） */
interface TrashNotice {
  /** 主进程给的撤销 token；没有时只提示、不可撤销 */
  token: string | null
  title: string
  busy: boolean
  error: string
  restored: boolean
  /** 文件已移动但会话列表没刷新成功 —— 要如实告知，不能显示成完全成功 */
  refreshFailed: boolean
}

/**
 * 删除成功 / 恢复过程中的轻量通知条。
 *
 * 视觉规范（方案 15.3）：
 *   · 不圈定焦点、用 `role="status"` 播报，不打断用户输入；
 *   · 撤销是**普通主要动作**，不用危险红色；
 *   · 不用 `.send`（那是输入框发送按钮的圆形专用样式）。
 */
function TrashNoticeBar({ notice, onUndo, onClose }: {
  notice: TrashNotice
  onUndo: () => void
  onClose: () => void
}) {
  const t = useT()
  const label = notice.restored
    ? t('rail.restoredNotice')
    : notice.busy
      ? t('rail.restoring')
      : notice.refreshFailed
        ? t('rail.deletedRefreshFailed')
        : t('rail.deletedNotice')

  return (
    <div className="rail-trash" role="status" aria-live="polite" data-testid="trash-notice">
      <Icon name={notice.restored ? 'check' : 'history'} size={12} />
      <span className="rail-trash-text">
        <span>{label}</span>
        {!notice.restored ? (
          <span className="rail-trash-name" title={notice.title}>
            {notice.title}
          </span>
        ) : null}
        {notice.error ? (
          <span className="rail-trash-err" role="alert">
            {notice.error}
          </span>
        ) : null}
      </span>
      <span className="spacer" />
      {!notice.restored && notice.token ? (
        <button className="btn" disabled={notice.busy} onClick={onUndo} data-testid="trash-undo">
          {notice.busy ? t('rail.restoring') : t('rail.undoDelete')}
        </button>
      ) : null}
      <button
        className="btn icon"
        onClick={onClose}
        title={t('rail.noticeDismiss')}
        aria-label={t('rail.noticeDismiss')}
      >
        <Icon name="plus" size={12} className="rail-trash-x" />
      </button>
    </div>
  )
}

/* ---------------------------------------------------------------- 会话行 */

function SessionRow({ s, selected, branchCount, branchIndex, branchesOpen, onToggleBranches,
  children, depth, menuOpen, menuAnchor, onOpenMenu, onCloseMenu, onSelect, pinned, onPin, unread, projectRecords, onRequestDelete
}: {
  s: SessionSummary; selected: boolean; branchCount: number; branchIndex?: number;
  branchesOpen: boolean; onToggleBranches: () => void; children: React.ReactNode; depth: number;
  menuOpen: boolean; menuAnchor: ContextMenuAnchor | null;
  onOpenMenu: (trigger: HTMLElement | null, point?: { x: number; y: number }) => void;
  onCloseMenu: () => void;
  onSelect: () => void; pinned: boolean; onPin: () => void; unread: boolean;
  projectRecords: ProjectRecord[];
  onRequestDelete: () => void
}) {
  const t = useT()
  /*
   * 运行 / 等待 / 失败状态来自**运行实例注册表**（N12）。
   *
   * 旧实现判断的是 `state.session?.sessionFile === s.path` —— 那是「当前
   * 正在看的会话」，所以后台会话在跑也看不出来。现在每个会话的实例都在
   * 注册表里，左栏每一行都能显示自己的状态。
   */
  const runner = useStore((state) => state.runners.find((r) => !!r.sessionFile && r.sessionFile === s.path))
  const titleCandidate = useStore((state) => state.titleCandidates[s.id])
  const running = runner?.running === true
  const waiting = runner?.waiting === true
  const failure = runner?.failed ? t('rail.runnerFailed') : ''
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
  const moveTargets = projectRecords.filter((project) => !project.archived && project.id !== s.projectId)

  const commitRename = (): void => {
    const name = draft.trim()
    setRenaming(false)
    if (!name || name === s.title) return
    void useStore.getState().setManualTitle(s.id, name)
  }

  return (
    <div className={`srow-wrap has-acts ${menuOpen ? 'menu-open' : ''}`} data-session-path={s.path} data-depth={depth} style={{ '--branch-depth': Math.min(depth, 3) } as React.CSSProperties}>
      {/* 行主体：会话按钮（占满，可省略号） + 分叉开关 + 相对时间 */}
      <div className={`srow-row ${selected ? 'selected' : ''}`} onContextMenu={(e) => { e.preventDefault(); onOpenMenu(e.currentTarget, { x: e.clientX, y: e.clientY }) }}>
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
            <Icon name="layers" size={12} className="srow-btoggle-ico" />
            <span className="srow-btoggle-n">{branchCount}</span>
            <Icon name="chevron-right" size={12} className="chev" />
          </button>
        ) : null}

        {waiting ? <span className="session-status waiting" data-testid="rail-waiting" title={t('rail.waiting')}>?</span> : failure ? <span className="session-status failed" data-testid="rail-failed" title={failure}><Icon name="alert-circle" size={12} /></span> : running ? <span className="session-status running" title={t('rail.running')}><Icon name="activity" size={12} /></span> : unread ? <span className="session-status" data-testid="rail-unread" title={t('rail.unread')}>●</span> : null}
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
          const rect = e.currentTarget.getBoundingClientRect()
          onOpenMenu(e.currentTarget, { x: rect.left, y: rect.bottom })
        }}>
          <Icon name="menu" size={12} />
        </button>
      </span>

      <ContextMenuSurface
        open={menuOpen}
        anchor={menuAnchor}
        onClose={onCloseMenu}
        testid="rail-session-menu"
        data-session-path={s.path}
        className="ctx-menu row-menu-surface"
      >
          <div className="srow-menu-time" data-testid="rail-menu-time">
            {t('rail.lastActive')} {relTime(s.lastActivityAt ?? s.updatedAt)}
          </div>
          {/* 停止**这一个**运行实例（N12）：后台会话也能单独停，不影响别的会话 */}
          {runner && (runner.running || runner.waiting) ? (
            <button
              className="srow-menu-btn" role="menuitem"
              data-testid="rail-stop-runner"
              onClick={() => {
                onCloseMenu()
                void window.yan.stopRunner(runner.id).then(() => useStore.getState().syncRunners())
              }}
            >
              <Icon name="alert-circle" size={12} />
              {t('rail.stopRunner')}
            </button>
          ) : null}
          <div className="srow-menu-path" title={s.path}>
            {s.path}
          </div>
          {titleCandidate ? (
            <div className="srow-title-candidate" data-testid="rail-title-candidate">
              <div className="srow-title-candidate-label">{t('rail.titleCandidate')}</div>
              <div className="srow-title-candidate-name" title={titleCandidate}>{titleCandidate}</div>
              <div className="srow-title-candidate-actions">
                <button
                  className="srow-menu-btn" role="menuitem"
                  data-testid="rail-accept-title-candidate"
                  onClick={() => {
                    void useStore.getState().acceptTitleCandidate(s.id)
                    onCloseMenu()
                  }}
                >
                  <Icon name="check" size={12} />
                  {t('rail.acceptTitleCandidate')}
                </button>
                <button
                  className="srow-menu-btn" role="menuitem"
                  data-testid="rail-dismiss-title-candidate"
                  onClick={() => {
                    useStore.getState().dismissTitleCandidate(s.id)
                    onCloseMenu()
                  }}
                >
                  <Icon name="plus" size={12} className="rail-trash-x" />
                  {t('rail.dismissTitleCandidate')}
                </button>
              </div>
            </div>
          ) : null}
          <button className="srow-menu-btn" role="menuitem" onClick={() => { onPin(); onCloseMenu() }}><Icon name="pin" size={12} />{pinned ? t('rail.unpin') : t('rail.pin')}</button>
          <div className="srow-menu-section" data-testid="rail-move-session">
            <div className="srow-menu-section-title">{t('rail.moveSession')}</div>
            {s.scope !== 'global' ? (
              <button
                className="srow-menu-btn" role="menuitem"
                data-testid="rail-move-global"
                onClick={() => {
                  void useStore.getState().moveSession(s.id, null).then((done) => { if (done) onCloseMenu() })
                }}
              >
                <Icon name="globe" size={12} />
                {t('rail.defaultLocation')}
              </button>
            ) : null}
            {moveTargets.map((project) => (
              <button
                key={project.id}
                className="srow-menu-btn" role="menuitem"
                data-testid={`rail-move-project-${project.id}`}
                onClick={() => {
                  void useStore.getState().moveSession(s.id, project.id).then((done) => { if (done) onCloseMenu() })
                }}
              >
                <Icon name="folder" size={12} />
                {project.name || shortProject(project.cwd)}
              </button>
            ))}
          </div>
          <button
            style={{ '--i': 1 } as React.CSSProperties}
            className="srow-menu-btn" role="menuitem"
            data-testid="rail-regenerate-title"
            onClick={() => {
              onCloseMenu()
              void useStore.getState().regenerateTitle(s.id)
            }}
          >
            <Icon name="sparkles" size={12} />
            {t('rail.regenerateTitle')}
          </button>
          <button
            disabled={!selected || running}
            title={!selected ? t('rail.openBeforeFork') : ''}
            style={{ '--i': 1 } as React.CSSProperties}
            className="srow-menu-btn" role="menuitem"
            onClick={() => {
              void forkLatest()
              onCloseMenu()
            }}
          >
            <Icon name="layers" size={12} />
            {t('rail.forkLast')}
          </button>
          <button
            style={{ '--i': 2 } as React.CSSProperties}
            className="srow-menu-btn" role="menuitem"
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
              onCloseMenu()
            }}
          >
            <Icon name="tag" size={12} />
            {t('rail.rename')}
          </button>
          <button
            style={{ '--i': 3 } as React.CSSProperties}
            className="srow-menu-btn" role="menuitem"
            onClick={() => {
              void window.yan.revealPath(s.path)
              onCloseMenu()
            }}
          >
            <Icon name="folder" size={12} />
            {t('rail.reveal')}
          </button>
          <button
            className="srow-menu-btn danger" role="menuitem"
            style={{ '--i': 4 } as React.CSSProperties}
            disabled={selected}
            title={selected ? t('rail.cantDeleteCurrent') : ''}
            onClick={() => { onRequestDelete(); onCloseMenu() }}
          >
            <Icon name="alert-circle" size={12} />
            {t('rail.delete')}
          </button>
      </ContextMenuSurface>
    </div>
  )
}

/**
 * 删除会话不能依赖浏览器原生 confirm：它没有明确告知“可撤销”，在某些
 * Electron 环境下也不能稳定地呈现。这里要求输入完整标题再启用动作。
 *
 * 交互分成四段（方案 15.2）：确认 → 进行 → 成功（关模态 + 轻量通知）
 * → 失败（框内给原因）。删除成功不再弹第二个模态框。
 */
function SessionDeleteDialog({ session, onClose, onDeleted }: {
  session: SessionSummary
  onClose: () => void
  /** 删除成功：把撤销 token 交给通知条（token 可能为 null） */
  onDeleted: (token: string | null, refreshFailed: boolean) => void
}) {
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
  const confirmed = typed.trim() === session.title.trim()

  /*
   * 这个弹窗是条件渲染的（deleteTarget 非空才挂载），所以 open 恒为 true。
   * Esc 以前写在 input 的 onKeyDown 上 —— 只在焦点在输入框时生效，
   * 且与「点取消」是两条不同的路径。现在统一到这里。
   */
  const panel = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(panel, true, isTop)

  const remove = async (): Promise<void> => {
    if (!confirmed || busy) return
    setBusy(true)
    setError('')
    const res = await window.yan.deleteSession(session.path)
    if (!res.ok) {
      /* 删除失败：留在确认框里说清原因，保留取消与重试 */
      setError(res.error ?? t('rail.deleteFailed'))
      setBusy(false)
      return
    }
    /*
     * 文件已移动，但**列表刷新可能失败**。
     * 刷新失败不能重跑删除（那会真删两次），只如实告诉用户，
     * 撤销 token 照常交给通知条。
     */
    let refreshFailed = false
    try {
      await useStore.getState().refreshSessions()
    } catch {
      refreshFailed = true
    }
    onDeleted(res.undoToken ?? null, refreshFailed)
  }

  return <div className="modal-scrim rail-delete-scrim" role="dialog" aria-modal="true" aria-labelledby="delete-session-title">
    <div className="modal rail-delete-dialog" ref={panel}>
      <div className="modal-head">
        <Icon name="alert-circle" size={14} />
        <span className="modal-title" id="delete-session-title">{t('rail.deleteTitle')}</span>
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
        onKeyDown={(e) => { if (e.key === 'Enter') void remove() }}
      />
      {error ? <div className="rail-delete-error" role="alert">{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={onClose} disabled={busy}>{t('ui.cancel')}</button>
        <span className="spacer" />
        <button className="btn danger" disabled={!confirmed || busy} onClick={() => void remove()}>
          {busy ? t('rail.deleting') : t('rail.deleteAction')}
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
