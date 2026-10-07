import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { useT } from '../../i18n'
import { Button, EmptyState } from '../ui'
import { loadTurnSnapshot, type TurnSnapshot } from '../../state/turn-cache'
import type { ConversationTurn } from '../../../../shared/conversation-turns'
import { forkAt } from '../../lib/fork'

interface Props { onOpen: (path: string) => void; onBackToChat: () => void }
const WIDTH = 300, COLUMN = 344, ROW = 188
const clip = (s: string, n = 110): string => s.length > n ? `${s.slice(0, n)}…` : s
/** One conversation family. Content and branch identities come from the session log. */
export function SessionMap({ onOpen, onBackToChat }: Props): React.JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const current = useStore((s) => s.session?.sessionFile)
  const running = useStore((s) => !!s.session?.isAgentRunning)
  const [data, setData] = useState<Record<string, TurnSnapshot>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<{ path: string; turn: ConversationTurn } | null>(null)
  const [query, setQuery] = useState(''), [quote, setQuote] = useState('')
  const [busy, setBusy] = useState(false), [limit, setLimit] = useState(8), [zoom, setZoom] = useState(1)
  const [folded, setFolded] = useState<Record<string, string>>({})
  const viewport = useRef<HTMLDivElement>(null)
  const camera = useRef<{ left: number; top: number }>({ left: 0, top: 0 })
  const index = useMemo(() => new Map(sessions.map((s) => [s.path, s])), [sessions])
  const root = useMemo(() => {
    let path = current ?? ''; const seen = new Set<string>()
    while (index.get(path)?.parentSession && !seen.has(path)) {
      seen.add(path); const parent = index.get(path)!.parentSession!
      if (!index.has(parent)) break
      path = parent
    }
    return path
  }, [current, index])
  const family = useMemo(() => {
    const list: string[] = []
    const visit = (path: string): void => { if (list.includes(path)) return; list.push(path); for (const s of sessions) if (s.parentSession === path) visit(s.path) }
    if (root) visit(root)
    return list
  }, [root, sessions])
  useEffect(() => {
    setSelected(null); setQuote(''); setLimit(8)
    try { setFolded(JSON.parse(localStorage.getItem(`yan.map-fold:${root}`) ?? '{}')) } catch { setFolded({}) }
    try { const view = JSON.parse(localStorage.getItem(`yan.map-camera:${root}`) ?? '{}'); setZoom(Math.max(.4, Math.min(2, view.zoom ?? 1))); camera.current = { left: view.left ?? 0, top: view.top ?? 0 } } catch { setZoom(1) }
  }, [root])
  const paths = useMemo(() => {
    const ancestors: string[] = []; let p = current
    while (p && !ancestors.includes(p)) { ancestors.unshift(p); p = index.get(p)?.parentSession }
    return family.filter((p) => family.indexOf(p) < limit || ancestors.includes(p))
  }, [family, limit, current, index])
  const revision = paths.map((p) => `${p}:${index.get(p)?.updatedAt ?? 0}`).join('|')
  useEffect(() => {
    let alive = true
    void (async () => {
      for (const path of paths) {
        const version = index.get(path)?.updatedAt ?? 0
        if (data[path]?.version === version) continue
        const result = await loadTurnSnapshot(path, version, (target) => window.yan.peekSession(target))
        if (!alive) return
        if (result.ok) setData((old) => ({ ...old, [path]: result.snapshot }))
        else setErrors((old) => ({ ...old, [path]: result.error }))
      }
    })()
    return () => { alive = false }
  // Revision gates disk loads; stale completions never populate another family.
  }, [revision])
  const layout = useMemo(() => {
    const starts = new Map<string, number>()
    const visible = new Map<string, ConversationTurn[]>()
    return paths.map((path, column) => {
      const s = index.get(path), origin = s?.branchOrigin?.trim(), parent = s?.parentSession
      let turns = data[path]?.version === (s?.updatedAt ?? 0) ? data[path].turns : []
      let start = 0, anchor = -1
      if (parent) {
        const parentIds = new Set((data[parent]?.turns ?? []).map((turn) => turn.question.entryId).filter(Boolean))
        const inherited = turns.findLastIndex((turn) => !!turn.question.entryId && parentIds.has(turn.question.entryId))
        if (inherited >= 0) {
          const id = turns[inherited].question.entryId
          anchor = (visible.get(parent) ?? []).findIndex((turn) => turn.question.entryId === id)
          turns = turns.slice(inherited + 1)
          if (anchor >= 0) start = (starts.get(parent) ?? 0) + (anchor + 1) * ROW
          else turns = []
        } else if (origin) {
          anchor = (visible.get(parent) ?? []).findLastIndex((turn) => turn.question.text.trim() === origin)
          const childStart = turns.findLastIndex((turn) => turn.question.text.trim() === origin)
          if (childStart >= 0) turns = turns.slice(childStart)
          if (anchor >= 0) start = (starts.get(parent) ?? 0) + anchor * ROW
        }
      }
      starts.set(path, start)
      const cut = turns.findIndex((turn) => turn.id === folded[path]), hidden = cut >= 0 ? turns.length - cut - 1 : 0
      if (cut >= 0) turns = turns.slice(0, cut + 1)
      visible.set(path, turns)
      return { path, column, start, turns, hidden, parent, anchor, title: s?.title ?? t('rail.untitled') }
    })
  }, [paths, index, data, folded, t])
  const height = Math.max(300, ...layout.map((c) => c.start + Math.max(1, c.turns.length) * ROW + 80))
  const fold = (path: string, id: string): void => setFolded((old) => {
    const next = { ...old }; if (next[path] === id) delete next[path]; else next[path] = id
    localStorage.setItem(`yan.map-fold:${root}`, JSON.stringify(next)); return next
  })
  const follow = async (path: string, turn: ConversationTurn, branch: boolean): Promise<void> => {
    if (busy || running) return
    setBusy(true)
    try {
      if (path !== useStore.getState().session?.sessionFile) await useStore.getState().switchSession(path)
      if (useStore.getState().session?.sessionFile !== path) throw new Error(t('map.switchFailed'))
      if (branch && turn.question.entryId && !(await forkAt(turn.question.entryId))) return
      if (quote) useStore.getState().insertIntoComposer(t('map.quotePrompt', { text: quote }))
      onBackToChat()
    } catch (e) { useStore.getState().notify('error', String(e)) } finally { setBusy(false) }
  }
  const locate = (): void => { const c = layout.find((c) => c.path === current); if (c) viewport.current?.scrollTo({ left: c.column * COLUMN * zoom, top: c.start * zoom }) }
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const wheel = (event: WheelEvent): void => { if (event.ctrlKey) { event.preventDefault(); setZoom((old) => Math.max(.4, Math.min(2, old - event.deltaY * .001))) } }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [root])
  useEffect(() => { viewport.current?.scrollTo(camera.current.left, camera.current.top) }, [root, revision])
  useEffect(() => {
    if (!query.trim()) return
    const match = layout.find((column) => column.turns.some((turn) => turn.messages.some((message) => message.text.toLowerCase().includes(query.toLowerCase()))))
    if (match) viewport.current?.scrollTo({ left: match.column * COLUMN * zoom, top: match.start * zoom })
  }, [query, layout, zoom])
  useEffect(() => {
    if (!selected) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); setSelected(null) } }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [selected])
  if (!root || !index.has(root)) return <EmptyState>{t('map.empty')}</EmptyState>
  return <div className="conversation-map" data-testid="session-map">
    <div className="conversation-map-bar"><strong>{index.get(root)?.title ?? t('rail.untitled')}</strong><input className="ui-input" aria-label={t('map.search')} placeholder={t('map.search')} value={query} onChange={(e) => setQuery(e.target.value)} /><Button size="sm" onClick={locate}>{t('map.locate')}</Button><Button size="sm" onClick={() => setZoom(Math.max(.4, zoom - .1))}>−</Button><span>{Math.round(zoom * 100)}%</span><Button size="sm" onClick={() => setZoom(Math.min(2, zoom + .1))}>+</Button><Button size="sm" onClick={() => setZoom(Math.min(1, (viewport.current?.clientWidth ?? 900) / (paths.length * COLUMN)))}>{t('map.fit')}</Button>{family.length > limit ? <Button size="sm" onClick={() => setLimit(limit + 8)}>{t('map.moreBranches', { n: family.length - limit })}</Button> : null}</div>
    <div className="conversation-map-viewport" ref={viewport} onScroll={(e) => { const element = e.currentTarget; camera.current = { left: element.scrollLeft, top: element.scrollTop }; try { localStorage.setItem(`yan.map-camera:${root}`, JSON.stringify({ ...camera.current, zoom })) } catch { /* View preference is optional. */ } }} onPointerDown={(e) => {
      if ((e.target as Element).closest('button, input, article') || e.button !== 0) return
      const element = e.currentTarget, x = e.clientX, y = e.clientY, left = element.scrollLeft, top = element.scrollTop
      const move = (event: PointerEvent): void => { element.scrollTo(left - event.clientX + x, top - event.clientY + y) }
      const end = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end) }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end)
    }}>
      <div style={{ width: paths.length * COLUMN * zoom, height: height * zoom }}><div className="conversation-map-world" style={{ width: paths.length * COLUMN, height, transform: `scale(${zoom})` }}>
        <svg className="conversation-map-links" width={paths.length * COLUMN} height={height} aria-hidden>{layout.map((c) => { const parent = layout.find((p) => p.path === c.parent); if (!parent || c.anchor < 0 || c.turns.length === 0) return null; const x = parent.column * COLUMN + WIDTH + 16, end = c.column * COLUMN + 16, y = parent.start + 118 + c.anchor * ROW, to = c.start + 118; return <path key={c.path} d={`M${x},${y} C${x + 14},${y} ${end - 14},${to} ${end},${to}`} fill="none" stroke="currentColor" /> })}</svg>
        {layout.map((c) => <div key={c.path}>
          <div className="conversation-map-title" style={{ left: c.column * COLUMN + 16, top: c.start + 8 }}>{c.title}{c.path === current ? ' · ' + t('map.current') : ''}</div>
          {!data[c.path] ? <div className="conversation-map-title" style={{ left: c.column * COLUMN + 16, top: c.start + 48 }}>{errors[c.path] ?? t('map.loading')}</div> : null}
          {data[c.path] && c.turns.length === 0 ? <div className="conversation-map-empty-branch" style={{ left: c.column * COLUMN + 16, top: c.start + 40 }}><span>{t('map.emptyBranch')}</span><Button size="sm" disabled={busy || running} onClick={() => { if (c.path === current) onBackToChat(); else void useStore.getState().switchSession(c.path).then(() => onBackToChat()) }}>{t('map.continue')}</Button></div> : null}
          {(data[c.path]?.truncated ?? 0) > 0 ? <div className="conversation-map-title" style={{ left: c.column * COLUMN + 16, top: c.start + 20 }}>{t('map.truncated', { n: data[c.path].truncated })}</div> : null}
          {c.turns.map((turn, i) => <article key={turn.id} className={`ui-map-card conversation-map-card ${selected?.turn.id === turn.id && selected.path === c.path ? 'selected' : ''}`} style={{ left: c.column * COLUMN + 16, top: c.start + 40 + i * ROW, width: WIDTH }} data-testid="map-turn-card" data-path={c.path} data-turn={turn.id}>
            <button className="conversation-map-summary" onClick={() => { setSelected({ path: c.path, turn }); setQuote('') }} onDoubleClick={() => onOpen(c.path)}><strong>{i + 1} · {clip(turn.question.text, 68)}</strong><span>{clip(turn.answer?.text ?? t('map.noAnswer'))}</span>{query && turn.messages.some((m) => m.text.toLowerCase().includes(query.toLowerCase())) ? <mark>{t('map.match')}</mark> : null}</button>
            <div className="conversation-map-actions"><Button size="sm" disabled={busy || running || !turn.question.entryId} onClick={() => void follow(c.path, turn, true)}>{t('map.turns.fork')}</Button><Button size="sm" onClick={() => fold(c.path, turn.id)}>{folded[c.path] === turn.id ? t('map.expand') : t('map.collapse')}</Button></div>
          </article>)}
          {c.hidden > 0 ? <div className="conversation-map-title" style={{ left: c.column * COLUMN + 16, top: c.start + 40 + c.turns.length * ROW }}>{t('map.hiddenTurns', { n: c.hidden })}</div> : null}
        </div>)}
      </div></div>
    </div>
    {selected ? <section className="conversation-map-detail" data-testid="map-preview" onMouseUp={() => setQuote(window.getSelection()?.toString().trim() ?? '')}>
      <div className="conversation-map-actions"><strong>{t('map.details')}</strong><Button size="sm" data-testid="map-preview-close" onClick={() => setSelected(null)}>{t('map.close')}</Button><Button size="sm" disabled={busy || running} onClick={() => void follow(selected.path, selected.turn, false)}>{t('map.continue')}</Button><Button size="sm" data-testid="map-preview-fork" disabled={busy || running || !selected.turn.question.entryId} onClick={() => void follow(selected.path, selected.turn, true)}>{t('map.turns.fork')}</Button></div>
      {quote ? <p>{t('map.quotePrompt', { text: clip(quote, 80) })}</p> : null}
      {selected.turn.messages.map((m) => <div key={m.id}><strong>{m.role === 'user' ? t('map.previewYou') : t('map.previewAssistant')}</strong><p>{m.text}</p>{m.toolCalls?.length ? <details className="ui-disclosure"><summary>{t('map.tools', { n: m.toolCalls.length })}</summary>{m.toolCalls.map((call) => <p key={call.id}>{call.name} · {call.status}</p>)}</details> : null}</div>)}
    </section> : null}
  </div>
}
