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
      {/* ---- 顶部：品牌 + 动作 ---- */}
      <div className="rail-top">
        {/*
         * 左栏开关 = 品牌按钮，**同一个元素在两种状态下几何完全相同**。
         *
         * 为什么这么做（用户报的「展开前后按钮大小位置不对称」）：
         *   上一版收起后渲染的是另一个元素（.rail-stub），它在 24px 的列里
         *   居中、图标 12px、padding-top 8px；而展开时是「砚 + 图标」的按钮、
         *   在 .rail-top 的 12px 内边距处。两个东西对不上。
         *   现在收起宽度 50px（= 12 + 26 + 12），按钮仍在 (12,12) 处 26×26 ——
         *   位置与尺寸一模一样，只是内容从「砚」换成展开图标。
         */}
        <button
          className="rail-brand-btn"
          title={railPinned ? t('rail.collapse') : t('rail.expand')}
          onClick={() => setRailPinned(!railPinned)}
          data-testid="rail-toggle"
          data-open={railPinned ? '1' : '0'}
          aria-expanded={railPinned}
        >
          {railPinned ? (
            <span className="rail-brand">砚</span>
          ) : (
            <Icon name="sidebar-left" size={14} />
          )}
        </button>
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
