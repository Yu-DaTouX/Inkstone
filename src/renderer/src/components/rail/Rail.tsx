import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
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
/**
 * 左栏默认展开多少个项目（N17）。
 * 超出的收在「更多项目（N）」后面；这只是**显示层**的限制，
 * 分组与项目归属不受影响。
 */
const PROJECT_PREVIEW = 5
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
  const [expanded, setExpanded] = useSidebarValue<string[]>('expanded-branches', [])
  const [pinned, setPinned] = useSidebarValue<string[]>('pinned', [])
  const archived = useMemo(() => projectRecords.filter((p) => p.archived).map((p) => p.cwd), [projectRecords])
  const [showArchived, setShowArchived] = useState(false)
  const [unread, setUnread] = useSidebarValue<string[]>('unread', [])
  /** 运行实例状态（N12）：左栏每行/每项目/每分组的状态汇总都来自它 */
  const runners = useStore((s) => s.runners)
  /**
   * 某个会话列表里有几个正在跑。
   * 做成闭包是为了在渲染时按项目/分组直接算，不用再建索引。
   */
  const runningIn = useMemo(() => {
    const files = new Set(runners.filter((r) => r.running && r.sessionFile).map((r) => r.sessionFile!))
    return (list: SessionSummary[]): number => list.filter((s) => files.has(s.path)).length
  }, [runners])

  const railPinned = useStore((s) => s.railPinned)
  const setRailPinned = useStore((s) => s.setRailPinned)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** 正在重命名哪个项目（cwd）；null = 没有 */
  const [projRename, setProjRename] = useState<string | null>(null)
  const [projDraft, setProjDraft] = useState('')
  /** 模式菜单（用户要求：软件名加一个菜单用来切换模式，先只做入口） */
  const [modeMenu, setModeMenu] = useState(false)
  /** mini 栏（收起态）的「全部项目」浮层（N14） */
  const [miniMenu, setMiniMenu] = useState(false)
  /**
   * mini 栏里正在悬停/聚焦的项目（N14）。
   *
   * 为什么用 React 状态而不是纯 CSS `:hover`：
   *   · 触摸设备没有 hover；
   *   · 键盘用户需要 focus 也能看到名称；
   *   · 纯 CSS 悬停无法在自动化里验证（合成事件改不了 :hover）。
   * CSS 里的 `:hover` / `:focus-visible` 仍作为兜底保留。
   */
  const [miniHover, setMiniHover] = useState<string | null>(null)
  const [projectMenu, setProjectMenu] = useState<string | null>(null)
  const [projectError, setProjectError] = useState('')
  const [groupingProject, setGroupingProject] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  /** 正在重命名哪个分组（groupId）；null = 没有（N01） */
  const [groupRename, setGroupRename] = useState<string | null>(null)
  /** 打开操作菜单的分组 id（N01） */
  const [groupMenu, setGroupMenu] = useState<string | null>(null)
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
    const close = (): void => { setMenuFor(null); setProjectMenu(null); setGroupMenu(null) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuFor, projectMenu, groupMenu])

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

  /* mini 栏的项目浮层：同样点外面关掉（N14） */
  useEffect(() => {
    if (!miniMenu) return
    const close = (): void => setMiniMenu(false)
    const id = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', close)
    }
  }, [miniMenu])

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
   * mini 栏（收起态）只放前 N 个项目的文件夹图标（N14），
   * 排序与展开态完全一致（同一个 `projects` 派生值）。
   */
  const miniProjects = projects.slice(0, PROJECT_PREVIEW)

  /**
   * 切到某个项目（N05）。
   *
   * 与旧实现的区别：旧的是「停掉当前 pi 再在新 cwd 起一个」，所以点一下
   * 别的项目 = 后台任务全没。现在 `yan:setCwd` 只更新设置里的当前项目，
   * 视图切到该项目**最近访问的会话**（没有就新建一个空会话），
   * 其它项目里正在跑的会话一个都不动。
   */
  const switchProject = async (cwd: string): Promise<void> => {
    if (cwd === session?.cwd) return
    const res = await window.yan.setCwd(cwd)
    if (!res.ok) {
      setProjectError(res.error || t('rail.projectError'))
      return
    }
    setProjectError('')
    const store = useStore.getState()
    const recent = sessions
      .filter((x) => x.cwd === cwd)
      .sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt))[0]
    if (recent) await store.switchSession(recent.path)
    else await store.newSession()
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
        {/*
         * 项目文件夹（N14）：收起侧栏仍然能看见/切到项目。
         *
         * 与展开态**同一排序、同一前五项规则**（N17）：先按当前项目，
         * 再按最近活动；超过五个的项目从「全部项目」浮层里进。
         * 名称不常驻（mini 栏只有 48px）—— 悬停 / 键盘聚焦时在右侧浮出。
         */}
        <span className="rail-compact-sep" aria-hidden />
        {miniProjects.map((p) => (
          <button
            key={p.cwd}
            className={`rail-compact-proj ${p.isCurrent ? 'cur' : ''}`}
            title={p.label}
            aria-label={p.label}
            aria-current={p.isCurrent ? 'true' : undefined}
            data-testid="rail-compact-project"
            data-current={p.isCurrent ? '1' : '0'}
            data-hover={miniHover === p.cwd ? '1' : '0'}
            data-running={runningIn(p.list) > 0 ? '1' : '0'}
            data-cwd={p.cwd}
            onMouseEnter={() => setMiniHover(p.cwd)}
            onMouseLeave={() => setMiniHover((v) => (v === p.cwd ? null : v))}
            onFocus={() => setMiniHover(p.cwd)}
            onBlur={() => setMiniHover((v) => (v === p.cwd ? null : v))}
            onClick={() => void switchProject(p.cwd)}
          >
            <Icon name={p.isCurrent ? 'folder-open' : 'folder'} size={16} />
            <span className="rail-compact-name">{p.label}</span>
          </button>
        ))}
        {projects.length > PROJECT_PREVIEW ? (
          <button
            className="rail-compact-proj rail-compact-more"
            title={t('rail.allProjects', { n: projects.length })}
            aria-label={t('rail.allProjects', { n: projects.length })}
            aria-expanded={miniMenu}
            aria-haspopup="menu"
            data-testid="rail-compact-more"
            onClick={() => setMiniMenu((v) => !v)}
          >
            <Icon name="menu" size={16} />
            <span className="rail-compact-name">{t('rail.allProjects', { n: projects.length })}</span>
          </button>
        ) : null}
        <span className="spacer" />
        <button title={t('rail.settings')} onClick={() => useStore.getState().openSettings()}><Icon name="settings" size={16} /></button>
        {miniMenu ? (
          <div className="rail-compact-menu" role="menu" data-testid="rail-compact-menu">
            <div className="rcm-head">{t('rail.projects')}</div>
            {projects.map((p) => (
              <button
                key={p.cwd}
                role="menuitem"
                className={`rcm-item ${p.isCurrent ? 'cur' : ''}`}
                data-current={p.isCurrent ? '1' : '0'}
                data-cwd={p.cwd}
                onClick={() => { setMiniMenu(false); void switchProject(p.cwd) }}
              >
                <Icon name={p.isCurrent ? 'folder-open' : 'folder'} size={12} />
                <span className="rcm-name" title={p.cwd}>{p.label}</span>
                <span className="rcm-count">{p.list.length}</span>
              </button>
            ))}
          </div>
        ) : null}
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
            shownProjects.map((p, projectIndex) => {
              const pOpen = !!query || !collapsed.includes(p.cwd)
              const groupId = projectRecords.find((record) => record.cwd === p.cwd)?.groupId
              const group = groupId ? projectGroups.find((candidate) => candidate.id === groupId) : undefined
              const previous = shownProjects[projectIndex - 1]
              const previousGroupId = previous ? projectRecords.find((record) => record.cwd === previous.cwd)?.groupId : undefined
              return (
                <div key={p.cwd} className="proj">
                  {group && groupId !== previousGroupId ? (
                    <div className="proj-group-heading" data-testid="rail-project-group" data-group-id={group.id}>
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
                              setGroupMenu(groupMenu === group.id ? null : group.id)
                            }}
                          ><Icon name="menu" size={12} /></button>
                        </>
                      )}
                    </div>
                  ) : null}
                  {group && groupId !== previousGroupId && groupMenu === group.id ? (
                    <div className="project-menu group-menu" data-testid="rail-group-menu-panel" onClick={(e) => e.stopPropagation()}>
                      <button
                        data-testid="rail-group-rename-action"
                        onClick={() => {
                          setGroupMenu(null)
                          setGroupDraft(group.name)
                          setGroupError('')
                          setGroupRename(group.id)
                        }}
                      >{t('rail.renameGroup')}</button>
                      <button data-testid="rail-group-dissolve" onClick={() => void dissolveGroup(group.id)}>
                        {t('rail.dissolveGroup')}
                      </button>
                    </div>
                  ) : null}
                  {group && groupId !== previousGroupId && groupError && (groupRename === group.id || groupMenu === group.id) ? (
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
                    className={`proj-head ${pOpen ? '' : 'collapsed'}`}
                    onContextMenu={(e) => { e.preventDefault(); setProjectMenu(p.cwd) }}
                    title={p.cwd}
                    data-testid="rail-project-row"
                    data-current={p.isCurrent ? '1' : '0'}
                  >
                    <button
                      className="proj-pick"
                      data-testid="rail-project"
                      title={`${p.label}\n${p.cwd}`}
                      aria-current={p.isCurrent ? 'true' : undefined}
                      onClick={() => void switchProject(p.cwd)}
                    >
                      <Icon name={pOpen ? 'folder-open' : 'folder'} size={12} />
                      <span className="proj-labels">
                        <span className="proj-name">{p.label}</span>
                        {projectRecords.find((record) => record.cwd === p.cwd)?.groupId ? <span className="proj-group">{projectGroups.find((g) => g.id === projectRecords.find((record) => record.cwd === p.cwd)?.groupId)?.name}</span> : null}
                      </span>
                    </button>
                    <button
                      className="proj-fold"
                      data-testid="rail-project-fold"
                      aria-expanded={pOpen}
                      title={pOpen ? t('rail.foldProject') : t('rail.unfoldProject')}
                      onClick={() => toggleProject(p.cwd)}
                    >
                      <Icon name="chevron-right" size={12} className={`chev ${pOpen ? 'open' : ''}`} />
                    </button>
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

                  {projectMenu === p.cwd ? <div className="project-menu" onClick={(e) => e.stopPropagation()}>
                    <button onClick={async () => { setProjectMenu(null); const r = await window.yan.setCwd(p.cwd); if (!r.ok) setProjectError(r.error || t('rail.projectError')); else { await newSession(); await useStore.getState().refreshSessions() } }}>{t('rail.new')}</button>
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
  children, depth, menuOpen, onToggleMenu, onSelect, pinned, onPin, unread, onRequestDelete
}: {
  s: SessionSummary; selected: boolean; branchCount: number; branchIndex?: number;
  branchesOpen: boolean; onToggleBranches: () => void; children: React.ReactNode; depth: number;
  menuOpen: boolean; onToggleMenu: () => void; onSelect: () => void; pinned: boolean; onPin: () => void; unread: boolean;
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
            <Icon name="layers" size={12} className="srow-btoggle-ico" />
            <span className="srow-btoggle-n">{branchCount}</span>
            <Icon name="chevron-right" size={12} className="chev" />
          </button>
        ) : null}

        {waiting ? <span className="session-status waiting" title={t('rail.waiting')}>?</span> : failure ? <span className="session-status failed" title={failure}><Icon name="alert-circle" size={12} /></span> : running ? <span className="session-status running" title={t('rail.running')}><Icon name="activity" size={12} /></span> : unread ? <span className="session-status" title={t('rail.unread')}>●</span> : null}
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
          <div className="srow-menu-time" data-testid="rail-menu-time">
            {t('rail.lastActive')} {relTime(s.lastActivityAt ?? s.updatedAt)}
          </div>
          {/* 停止**这一个**运行实例（N12）：后台会话也能单独停，不影响别的会话 */}
          {runner && (runner.running || runner.waiting) ? (
            <button
              className="srow-menu-btn"
              data-testid="rail-stop-runner"
              onClick={() => {
                onToggleMenu()
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
