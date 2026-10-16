import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useConfirm } from '../ui/confirm'
import { useStore } from '../../state/store'
import { listSourceFiles, removeSourceFile } from '../../state/source-files'
import type { SourceLinkView, SourceRefView } from '../../../../shared/ipc'
import { sessionSourceStorageKey } from '../toolbar/workspace-control-guards'

export type SourceFilter = 'all' | 'image' | 'file' | 'web'

const WEB_KEY = 'yan.source-links.v1'
const webKeyFor = sessionSourceStorageKey

export interface WebLink {
  id: string
  sessionId: string
  url: string
  title: string
  addedAt: number
}

function loadJson<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function loadSessionWeb(sessionId: string): WebLink[] {
  const key = webKeyFor(sessionId)
  try {
    if (localStorage.getItem(key) !== null) return loadJson<WebLink>(key)
  } catch { return [] }
  const legacy = loadJson<WebLink>(WEB_KEY).filter((link) => link.sessionId === sessionId)
  if (legacy.length) saveJson(key, legacy)
  return legacy
}

function saveJson(key: string, list: unknown[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

export function SourceMenu({ sessionId, open, onClose }: { sessionId: string; open: boolean; onClose?: () => void }): React.JSX.Element {
  const t = useT()
  const confirm = useConfirm()
  const locateMessage = useStore((s) => s.locateMessage)
  const injectComposerText = useStore((s) => s.injectComposerText)
  const [images, setImages] = useState<SourceRefView[]>([])
  const [files, setFiles] = useState<SourceRefView[]>([])
  const [webs, setWebs] = useState<SourceRefView[]>([])
  const [links, setLinks] = useState<SourceLinkView[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [bad, setBad] = useState(false)
  const [actionError, setActionError] = useState('')
  const [dir, setDir] = useState('')
  const [webSearch, setWebSearch] = useState<{ available: boolean; title?: string; location?: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const gate = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    setActionError('')
    const mine = ++gate.current
    const current = sessionId
    try {
      const listed = await window.yan.sources.list(current)
      if (gate.current !== mine) return
      setImages(listed.images ?? [])
      setDir(listed.dir ?? '')
      setLinks(listed.links ?? [])
    } catch {
      if (gate.current === mine) setImages([])
    }
    const refs = listSourceFiles(current)
    try {
      const verified = await window.yan.sources.verifyFiles({ sessionId: current, entries: refs })
      if (gate.current === mine) setFiles(verified)
    } catch {
      if (gate.current === mine) setFiles([])
    }
    const links = loadSessionWeb(current)
    if (gate.current !== mine) return
    setWebs(
      links.map((l) => ({
        sourceId: `web:${l.id}`,
        sessionId: current,
        kind: 'web' as const,
        title: l.title || l.url,
        ref: l.url,
        fingerprint: l.url,
        origin: l.url,
        addedAt: l.addedAt,
        available: true
      }))
    )
  }, [sessionId])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      try {
        const res = await window.yan.sources.webSearch()
        if (alive) setWebSearch(res ?? { available: false })
      } catch {
        if (alive) setWebSearch({ available: false })
      }
    })()
    return () => {
      alive = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      for (const img of images) {
        if (thumbs[img.sourceId]) continue
        try {
          const res = await window.yan.sources.readImage({ sessionId, sourceId: img.sourceId })
          if (!alive) return
          if (res.ok && res.base64) setThumbs((prev) => ({ ...prev, [img.sourceId]: `data:${res.mime ?? 'image/png'};base64,${res.base64}` }))
        } catch {
        }
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, images, sessionId])

  const all: SourceRefView[] = [...images, ...files, ...webs].sort((a, b) => b.addedAt - a.addedAt)
  const shown = filter === 'all' ? all : all.filter((x) => x.kind === filter)

  const removeOne = async (item: SourceRefView): Promise<void> => {
    setActionError('')
    if (item.kind === 'image') {
      const result = await window.yan.sources.removeImage({ sessionId, sourceId: item.sourceId })
      if (!result.ok) throw new Error(result.error || t('src.remove'))
    } else if (item.kind === 'file') {
      removeSourceFile(sessionId, item.ref)
    } else {
      if (!saveJson(webKeyFor(sessionId), loadSessionWeb(sessionId).filter((x) => `web:${x.id}` !== item.sourceId))) {
        throw new Error(t('src.remove'))
      }
    }
    await refresh()
  }

  const removeWithFeedback = async (item: SourceRefView): Promise<void> => {
    if (item.kind === 'image' && !(await confirm({ title: t('src.remove'), body: t('src.note'), detail: item.title, confirmLabel: t('src.remove'), tone: 'danger' }))) return
    try { await removeOne(item) }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const addWeb = (): void => {
    const clean = normalizeUrl(url)
    if (!clean) {
      setBad(true)
      return
    }
    setBad(false)
    const links = loadSessionWeb(sessionId)
    links.unshift({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      url: clean,
      title: title.trim() || new URL(clean).host,
      addedAt: Date.now()
    })
    if (!saveJson(webKeyFor(sessionId), links)) { setActionError(t('src.badUrl')); return }
    setUrl('')
    setTitle('')
    void refresh()
  }

  const counts = {
    all: all.length,
    image: images.length,
    file: files.length,
    web: webs.length
  }

  return (
    <div className="env-links" data-testid="env-source-menu">
      <div className="env-links-head">
        <Icon name="library" size={12} />
        <span className="env-label">{t('src.title')}</span>
        <span className="env-sub">{counts.all > 0 ? String(counts.all) : ''}</span>
      </div>

      {counts.all > 0 ? (
        <div className="src-filters">
          {(['all', 'image', 'file', 'web'] as SourceFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`src-filter ${filter === f ? 'sel' : ''}`}
              data-testid={`src-filter-${f}`}
              disabled={f !== 'all' && counts[f] === 0}
              onClick={() => setFilter(f)}
            >
              {t(`src.${f}`)} {f === 'all' ? counts.all : counts[f]}
            </button>
          ))}
        </div>
      ) : null}

      {shown.length === 0 ? (
        <div className="env-carry-hint" data-testid="src-empty">
          {counts.all === 0 ? t('src.empty') : t('src.noneInFilter')}
        </div>
      ) : (
        <div className="src-list" data-testid="src-list">
          {shown.map((item) => (
            <div className="src-item" key={item.sourceId} data-testid="src-item">
              {item.kind === 'image' ? (
                thumbs[item.sourceId] ? (
                  <img className="src-thumb" src={thumbs[item.sourceId]} alt={item.title} data-testid="src-thumb" />
                ) : (
                  <span className="src-thumb src-thumb-empty" title={t('src.thumbPending')}>
                    <Icon name="image" size={14} />
                  </span>
                )
              ) : (
                <span className="src-icon">
                  <Icon name={item.kind === 'web' ? 'globe' : 'folder'} size={14} />
                </span>
              )}

              <div className="src-meta">
                <span className="src-title" title={item.kind === 'file' ? item.ref : item.origin || item.title}>
                  {item.title}
                </span>
                <span className="src-tags">
                  <span className="src-tag">{t('src.linked')}</span>
                  {item.kind === 'file' && !item.available ? (
                    <span className="src-tag src-tag-bad" data-testid="src-unavailable">
                      {item.error ?? t('src.unavailable')}
                    </span>
                  ) : null}
                </span>
              </div>

              {(() => {
                const mine = links.filter((l) => l.sourceId === item.sourceId)
                if (mine.length === 0) return null
                const latest = mine[mine.length - 1]
                return (
                  <button
                    type="button"
                    className="env-mini"
                    data-testid="src-locate"
                    title={t('src.locateHint', { n: mine.length })}
                    onClick={() => locateMessage(latest.messageId)}
                  >
                    {t('src.locate')}
                  </button>
                )
              })()}
              <button
                type="button"
                className="env-mini"
                data-testid="src-open"
                title={item.kind === 'image' ? item.ref : item.ref}
                onClick={() => {
                  if (item.kind === 'web') void window.yan.browser.open(item.ref).catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)))
                  else void navigator.clipboard.writeText(item.ref).catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)))
                }}
              >
                {item.kind === 'web' ? t('src.openWeb') : t('src.copyPath')}
              </button>
              <button type="button" className="env-mini" data-testid="src-remove" onClick={() => void removeWithFeedback(item)}>
                {t('src.remove')}
              </button>
            </div>
          ))}
        </div>
      )}

      {dir && images.length > 0 ? (
        <div className="env-carry-hint src-dir" title={dir}>
          {t('src.stored', { dir })}
        </div>
      ) : null}

      {webSearch?.available && webSearch.title ? (
        <div className="env-link-add" data-testid="src-websearch">
          <input
            className="env-branch-input"
            data-testid="src-search-query"
            placeholder={t('src.searchPlaceholder')}
            value={searchQuery}
            spellCheck={false}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            type="button"
            className="env-mini"
            data-testid="src-search-run"
            disabled={!searchQuery.trim()}
            onClick={() => {
              const query = searchQuery.trim()
              if (!query) return
              const hint = webSearch.location ? `（能力入口：${webSearch.location}）` : ''
              injectComposerText(
                `请用「${webSearch.title}」搜索网页：${query}\n${hint}搜到的链接与标题请作为网页来源登记。`
              )
              setSearchQuery('')
              onClose?.()
            }}
          >
            {t('src.searchWith', { name: webSearch.title })}
          </button>
        </div>
      ) : null}
      <div className="env-link-add">
        <input
          className="env-branch-input"
          data-testid="src-url"
          placeholder="https://…"
          value={url}
          spellCheck={false}
          onChange={(e) => {
            setUrl(e.target.value)
            setBad(false)
          }}
        />
        <input
          className="env-branch-input"
          data-testid="src-title"
          placeholder={t('src.titlePlaceholder')}
          value={title}
          spellCheck={false}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="button" className="env-mini" data-testid="src-add-web" disabled={!url.trim()} onClick={addWeb}>
          {t('src.add')}
        </button>
      </div>
      {bad ? <div className="env-error">{t('src.badUrl')}</div> : null}
      {actionError ? <div className="env-error" role="alert" data-testid="src-action-error">{actionError}</div> : null}
      {counts.all > 0 ? <div className="env-carry-hint">{t('src.note')}</div> : null}
    </div>
  )
}
