import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import type { SessionSummary } from '../../../shared/ipc'
import { shortProject } from './rail-utils'
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
  const openSettings = useStore((s) => s.openSettings)
  const conn = useStore((s) => s.conn)
  const cwd = useStore((s) => s.settings?.cwd)
  const railPinned = useStore((s) => s.railPinned)
  const titles = useStore((s) => s.titles)
  const setRailPinned = useStore((s) => s.setRailPinned)

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
        list: list.sort((a, b) => b.updatedAt - a.updatedAt),
        isCurrent: cwdKey === cur
      }))
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
        return (b.list[0]?.updatedAt ?? 0) - (a.list[0]?.updatedAt ?? 0)
      })
  }, [sessions, query, session, t, titles])

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
  menuOpen,
  onToggleMenu,
  onSelect
}: {
  s: SessionSummary
  selected: boolean
  menuOpen: boolean
  onToggleMenu: () => void
  onSelect: () => void
}) {
  const t = useT()

  return (
    <div className={`srow-wrap ${menuOpen ? 'menu-open' : ''}`}>
      <button className={`srow ${selected ? 'sel' : ''}`} onClick={onSelect} title={s.path}>
        <span className="srow-name">{s.title}</span>
        <span className="srow-time">{relTime(s.updatedAt)}</span>
      </button>

      {selected ? (
        <span className="srow-acts">
          <button className="rail-icon sm" title={t('rail.more')} onClick={(e) => {
            e.stopPropagation()
            onToggleMenu()
          }}>
            <Icon name="menu" size={12} />
          </button>
        </span>
      ) : null}

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
              void window.yan.revealPath(s.path)
              onToggleMenu()
            }}
          >
            <Icon name="folder" size={12} />
            {t('rail.reveal')}
          </button>
          <button
            className="srow-menu-btn danger"
            style={{ '--i': 3 } as React.CSSProperties}
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

/**
 * 从最后一条用户消息分叉。
 * entryId 必须由 pi 给（get_messages 不带 entry id），
 * 所以走 get_fork_messages 取最后一项 —— 而不是从 DOM 猜。
 */
async function forkLatest(): Promise<void> {
  const points = await window.yan.forkPoints()
  const last = points[points.length - 1]
  if (!last) return
  await useStore.getState().fork(last.entryId)
}

/** 供消息上的「从这里分叉」按钮使用 */
export async function forkFromText(text: string): Promise<void> {
  const points = await window.yan.forkPoints()
  const hit = [...points].reverse().find((p) => p.text.trim() === text.trim())
  if (!hit) return
  await useStore.getState().fork(hit.entryId)
}

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
