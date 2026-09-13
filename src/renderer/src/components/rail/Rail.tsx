import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import type { SessionSummary } from '../../../../shared/ipc'
import { shortProject } from './rail-utils'
import { forkLatest } from '../../lib/fork'
import { RailUser } from './RailUser'

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
  { id: 'agent', labelKey: 'mode.agent' },
  { id: 'coding', labelKey: 'mode.coding' },
  { id: 'ask', labelKey: 'mode.ask' }
] as const

/** 当前模式（暂时只有一个） */
const MODE_ID = 'agent'

export function Rail() {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const session = useStore((s) => s.session)
  const switchSession = useStore((s) => s.switchSession)
  const newSession = useStore((s) => s.newSession)
  const refreshSessions = useStore((s) => s.refreshSessions)
  const titles = useStore((s) => s.titles)

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** 模式菜单（用户要求：软件名加一个菜单用来切换模式，先只做入口） */
  const [modeMenu, setModeMenu] = useState(false)

  // 会话列表在有新消息后会变（标题、时间），settled 时刷一次
  const msgCount = useStore((s) => s.messages.length)
  useEffect(() => {
    if (msgCount === 0) return
    const id = setTimeout(() => void refreshSessions(), 800)
    return () => clearTimeout(id)
  }, [msgCount, refreshSessions])

  useEffect(() => {
    if (!menuFor) return
    const close = (): void => setMenuFor(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuFor])

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

    // 用模型生成的短标题覆盖列表标题（如果有）
    const all = [...synthetic, ...sessions].map((x) => {
      const t = titles[x.id]
      return t ? { ...x, title: t } : x
    })
    const filtered = q
      ? all.filter(
          (s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)
        )
      : all

    const byCwd = new Map<string, SessionSummary[]>()
    for (const s of filtered) {
      const key = s.cwd || '—'
      const list = byCwd.get(key) ?? []
      list.push(s)
      byCwd.set(key, list)
    }

    const cur = session?.cwd
    return [...byCwd.entries()]
      .map(([cwdKey, list]) => ({
        cwd: cwdKey,
        label: shortProject(cwdKey),
        list: orderFamily(list),
        isCurrent: cwdKey === cur
      }))
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
        const at = (p: { list: SessionSummary[] }) =>
          p.list[0] ? (p.list[0].lastActivityAt ?? p.list[0].updatedAt) : 0
        return at(b) - at(a)
      })
  }, [sessions, query, session, t, titles])

  /**
   * 会话分支关系（用户要求：左栏显示分支数 / 分支编号）。
   *
   * 数据来自 pi 的 session 头：`parentSession` 指向分叉来源的会话文件。
   * 从这里算出：
   *   · branchCount：这个会话被分叉出去几次（父会话行上显示）
   *   · branchIndex：这个会话是父会话的第几个分支（子会话行上显示 #N）
   * 编号按 createdAt 升序 —— 与分支创建的先后一致。
   */
  const { branchCount, branchIndex, branchesOf } = useMemo(() => {
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
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const total = sessions.length
  const shown = projects.reduce((n, p) => n + p.list.length, 0)

  return (
    <aside className="rail">
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
            title={t('rail.new')}
            onClick={() => void newSession()}
          >
            <Icon name="plus" size={12} />
          </button>
        </div>

        <div className="rail-body">
          {total === 0 ? (
            <div className="rail-empty">{t('rail.empty')}</div>
          ) : shown === 0 ? (
            <div className="rail-empty">{t('rail.noMatch')}</div>
          ) : projectsOpen ? (
            projects.map((p) => {
              const pOpen = !collapsed.has(p.cwd)
              return (
                <div key={p.cwd} className="proj">
                  <button
                    className={`proj-head ${pOpen ? '' : 'collapsed'}`}
                    onClick={() => toggleProject(p.cwd)}
                    title={p.cwd}
                    data-testid="rail-project"
                    data-current={p.isCurrent ? '1' : '0'}
                  >
                    <Icon name={pOpen ? 'folder-open' : 'folder'} size={12} />
                    <span className="proj-name">{p.label}</span>
                    <span className="proj-count">{p.list.length}</span>
                  </button>

                  {pOpen
                    ? p.list.map((s) => (
                        <SessionRow
                          key={s.path}
                          s={s}
                          selected={!!session?.sessionFile && session.sessionFile === s.path}
                          branchCount={branchCount.get(s.path) ?? 0}
                          branchIndex={branchIndex.get(s.path)}
                          branches={branchesOf.get(s.path) ?? []}
                          onOpenBranch={(path) => void switchSession(path)}
                          menuOpen={menuFor === s.path}
                          onToggleMenu={() => setMenuFor(menuFor === s.path ? null : s.path)}
                          onSelect={() => void switchSession(s.path)}
                        />
                      ))
                    : null}
                </div>
              )
            })
          ) : null}
        </div>
      </div>

      {/* ---- 底部：用户块（名字 / 自定义头像 / 登录预留）---- */}
      <RailUser />
    </aside>
  )
}

/* ---------------------------------------------------------------- 会话行 */

function SessionRow({
  s,
  selected,
  branchCount,
  branchIndex,
  branches,
  onOpenBranch,
  menuOpen,
  onToggleMenu,
  onSelect
}: {
  s: SessionSummary
  selected: boolean
  /** 这个会话被分叉出去几次 */
  branchCount: number
  /** 这个会话自己是第几个分支（undefined = 不是分支） */
  branchIndex?: number
  /** 这个会话分出去的分支会话（按创建时间排序），用于「分叉树」 */
  branches: SessionSummary[]
  onOpenBranch: (path: string) => void
  menuOpen: boolean
  onToggleMenu: () => void
  onSelect: () => void
}) {
  const t = useT()
  /** 分叉树是否展开（用户要求：**默认折叠**，开关在会话标题旁） */
  const [branchesOpen, setBranchesOpen] = useState(false)

  return (
    <div className={`srow-wrap has-acts ${menuOpen ? 'menu-open' : ''}`}>
      {/* 行主体：会话按钮（占满，可省略号） + 分叉开关 + 相对时间 */}
      <div className="srow-row">
        <button className={`srow ${selected ? 'sel' : ''}`} onClick={onSelect} title={s.path}>
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

        {branchCount > 0 ? (
          <button
            className={`srow-btoggle ${branchesOpen ? 'open' : ''}`}
            data-testid="rail-branch-toggle"
            data-open={branchesOpen ? '1' : '0'}
            aria-expanded={branchesOpen}
            title={t('rail.branchCount', { n: branchCount })}
            onClick={() => setBranchesOpen((v) => !v)}
          >
            <Icon name="layers" size={12} />
            <span className="srow-btoggle-n">{branchCount}</span>
            <Icon name="chevron-right" size={12} className="chev" />
          </button>
        ) : null}

        {/* 显示的时间必须与排序键一致，否则看起来“没排序” */}
        <span className="srow-time">{relTime(s.lastActivityAt ?? s.updatedAt)}</span>
      </div>

      {/* 分叉树（默认折叠）：列出这个会话分出去的每条分支，点击即跳过去 */}
      {branchesOpen && branches.length ? (
        <div className="srow-branches" data-testid="rail-branch-tree">
          {branches.map((b, i) => (
            <button
              key={b.path}
              className="sbr"
              data-testid="rail-branch-item"
              onClick={() => onOpenBranch(b.path)}
              title={b.path}
            >
              <span className="sbr-no">#{i + 1}</span>
              <span className="sbr-main">
                <span className="sbr-name">{b.title}</span>
                {b.branchOrigin ? (
                  <span className="sbr-origin">{t('rail.fromMessage', { text: b.branchOrigin })}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}

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
          <button
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
            onClick={() => {
              /*
               * 重命名。
               *
               * ⚠️ 这里曾经**没有入口** —— store 里 renameSession / 主进程 IPC /
               *    pi 的 set_session_name 三层都通，但界面上没有任何地方调它，
               *    于是「重命名」这个功能实际上不可达（而 README 里写着左栏菜单有它）。
               *    整理时发现的：扫 i18n 孤儿键时看到 rail.rename 没人用，
               *    顺着往下查才确认是**功能缺口**而不是多余的文案。
               *
               * 用 prompt 与相邻的删除按钮（confirm）保持同一量级 ——
               * 重命名不值得为它开一个模态框。
               */
              const name = window.prompt(t('rail.renamePrompt'), s.title)
              if (name === null) return
              const trimmed = name.trim()
              if (!trimmed) return
              void useStore.getState().renameSession(trimmed)
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
            onClick={() => {
              if (!confirm(t('rail.confirmDelete', { name: s.title }))) return
              void useStore.getState().deleteSession(s.path)
              onToggleMenu()
            }}
          >
            <Icon name="alert-circle" size={12} />
            {t('rail.delete')}
          </button>
        </div>
      ) : null}
    </div>
  )
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
