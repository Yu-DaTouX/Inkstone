/**
 * 会话切换器（Ctrl+K）：任何时候都能搜会话并直接跳过去，不依赖左栏是否展开。
 *
 * 两路结果合并显示：
 *   · 标题 / 项目名：在界面里即时过滤（不等主进程）；
 *   · 正文：主进程的会话检索（所有词都出现才算命中），带命中处的片段。
 * 没输入时列出最近的会话，直接回车就回到上一个会话。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSearchHit, SessionSummary } from '../../../../shared/ipc'
import { useT, type TFunc } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { useStore } from '../../state/store'
import { shortProject } from '../rail/rail-utils'

interface Row {
  session: SessionSummary
  title: string
  project: string
  snippet?: string
}

const RECENT_LIMIT = 12
const RESULT_LIMIT = 30

function ago(t: TFunc, at: number | undefined): string {
  if (!at || !Number.isFinite(at)) return ''
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return t('time.justNow')
  if (s < 3600) return t('time.minutesAgo', { n: Math.floor(s / 60) })
  if (s < 86400) return t('time.hoursAgo', { n: Math.floor(s / 3600) })
  if (s < 86400 * 30) return t('time.daysAgo', { n: Math.floor(s / 86400) })
  const d = new Date(at)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 把查询拆成词；全部出现才算命中 */
function tokensOf(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 6)
}

export function SessionSwitcher({ onClose }: { onClose: () => void }) {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const settings = useStore((s) => s.settings)
  const currentFile = useStore((s) => s.session?.conversationFile ?? s.session?.sessionFile)
  const switchSession = useStore((s) => s.switchSession)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const projectNames = settings?.projectNames ?? {}
  const projects = settings?.projects ?? []

  useEffect(() => {
    const release = acquireOverlayBlocker('session-switcher')
    input.current?.focus()
    return release
  }, [acquireOverlayBlocker])

  /* Esc 在窗口层接：焦点不在输入框里（比如点过结果行）也能关 */
  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [onClose])

  /* 正文检索：停手 140ms 后再问主进程，只采纳最后一次的答复 */
  useEffect(() => {
    const tokens = tokensOf(query)
    if (!tokens.length) {
      setHits([])
      setBusy(false)
      return undefined
    }
    let alive = true
    setBusy(true)
    const timer = window.setTimeout(() => {
      void window.yan.searchSessions(query, RESULT_LIMIT)
        .then((result) => { if (alive) setHits(result.hits) })
        .catch(() => { if (alive) setHits([]) })
        .finally(() => { if (alive) setBusy(false) })
    }, 140)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query])

  const rows = useMemo<Row[]>(() => {
    const projectOf = (s: SessionSummary): string => {
      const record = projects.find((p) => p.cwd === s.cwd)
      return record?.name || projectNames[s.cwd] || shortProject(s.cwd)
    }
    const titleOf = (s: SessionSummary): string => manualTitles[s.id] || titles[s.id] || s.title
    const activityOf = (s: SessionSummary): number => s.lastActivityAt ?? s.updatedAt
    const decorated = sessions.map((session) => ({ session, title: titleOf(session), project: projectOf(session) }))
    const tokens = tokensOf(query)
    if (!tokens.length) {
      return decorated
        .filter((r) => r.session.path !== currentFile)
        .sort((a, b) => activityOf(b.session) - activityOf(a.session))
        .slice(0, RECENT_LIMIT)
    }
    const titleMatches = decorated
      .filter((r) => {
        const hay = `${r.title} ${r.project} ${r.session.cwd}`.toLowerCase()
        return tokens.every((token) => hay.includes(token))
      })
      .sort((a, b) => activityOf(b.session) - activityOf(a.session))
    const seen = new Set(titleMatches.map((r) => r.session.path))
    const byPath = new Map(decorated.map((r) => [r.session.path, r]))
    const bodyMatches: Row[] = []
    for (const hit of hits) {
      const base = byPath.get(hit.path)
      if (!base || seen.has(hit.path)) continue
      bodyMatches.push({ ...base, snippet: hit.snippet })
    }
    return [...titleMatches, ...bodyMatches].slice(0, RESULT_LIMIT)
  }, [sessions, titles, manualTitles, projects, projectNames, query, hits, currentFile])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, rows.length])

  const open = (row: Row | undefined): void => {
    if (!row) return
    onClose()
    void switchSession(row.session.path)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (rows.length ? (i + 1) % rows.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      open(rows[active])
    }
  }

  const hasQuery = tokensOf(query).length > 0
  return (
    <div className="modal-scrim switcher-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }} role="dialog" aria-modal="true" aria-label={t('switcher.title')} data-testid="session-switcher">
      <div className="switcher" onKeyDown={onKeyDown}>
        <div className="switcher-input">
          <Icon name="search" size={14} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('switcher.placeholder')}
            spellCheck={false}
            aria-label={t('switcher.title')}
            data-testid="switcher-input"
          />
          {busy ? <span className="switcher-busy" aria-hidden>…</span> : null}
        </div>
        <div className="switcher-list" ref={listRef} role="listbox">
          {!hasQuery ? <div className="switcher-label">{t('switcher.recent')}</div> : null}
          {rows.map((row, i) => (
            <button
              key={row.session.path}
              type="button"
              role="option"
              aria-selected={i === active}
              data-active={i === active}
              className={`switcher-row${i === active ? ' on' : ''}`}
              onMouseMove={() => { if (i !== active) setActive(i) }}
              onClick={() => open(row)}
              data-testid="switcher-row"
            >
              <span className="switcher-title">{row.title}</span>
              <span className="switcher-meta">{row.project} · {ago(t, row.session.lastActivityAt ?? row.session.updatedAt)}</span>
              {row.snippet ? <span className="switcher-snippet">{row.snippet}</span> : null}
            </button>
          ))}
          {rows.length === 0 ? <div className="switcher-empty">{busy ? t('switcher.searching') : hasQuery ? t('switcher.none') : t('switcher.noSessions')}</div> : null}
        </div>
        <div className="switcher-foot">{t('switcher.hint')}</div>
      </div>
    </div>
  )
}
