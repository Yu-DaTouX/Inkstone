import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ExternalLink, FolderOpen, Layers, MessageSquare, Pin, PinOff } from 'lucide-react'
import type { ArtifactLibraryItem as ArtifactLibraryEntry } from '../../../../shared/artifact-library'
import { isHtmlArtifact } from '../../../../shared/html-artifact-preview'
import { useT } from '../../i18n'
import { Button, EmptyState, IconButton, Notice, PageHeader, SearchField, SegmentedControl } from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { filePreviewUrl } from '../../lib/file-preview-url'
import { HtmlArtifactThumb } from './HtmlArtifactThumb'
import { usePreviewSnapshot, useNearViewport } from './widget-lifecycle'
import './artifacts.css'
import './artifact-library.css'

type LoadState = { status: 'loading' } | { status: 'ready'; entries: ArtifactLibraryEntry[] } | { status: 'error' }
type LibraryView = 'list' | 'grid'

const VIEW_KEY = 'yan.artifactLibrary.view'
const PINNED_KEY = 'yan.artifactLibrary.pinned'
const REFRESH_DELAY_MS = 600

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function matches(entry: ArtifactLibraryEntry, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return [entry.artifact.filename, entry.artifact.description ?? '', entry.sessionTitle ?? ''].some((text) => text.toLowerCase().includes(needle))
}

export function libraryEntryKey(entry: ArtifactLibraryEntry): string {
  return `${entry.sessionId ?? ''}:${entry.artifact.sourceId ?? entry.artifact.id}`
}

function readView(): LibraryView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

function readPinned(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((key): key is string => typeof key === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

const isImageEntry = (entry: ArtifactLibraryEntry): boolean =>
  entry.artifact.previewable && (entry.artifact.kind === 'image' || entry.artifact.kind === 'svg')

function LibraryThumb({ entry, openLabel, onOpen }: { entry: ArtifactLibraryEntry; openLabel: string; onOpen: () => void }): JSX.Element {
  const { artifact } = entry
  const unavailable = Boolean(artifact.unavailable)
  const html = !unavailable && artifact.previewable && isHtmlArtifact(artifact)
  const [near, nearRef] = useNearViewport<HTMLDivElement>()
  const snapshot = usePreviewSnapshot({
    identityKey: `library:${libraryEntryKey(entry)}:${artifact.id}`,
    source: html ? artifact.path : null,
    active: html && near,
    prepare: (path) => window.yan.prepareHtmlArtifact(path),
    release: (url) => window.yan.releaseHtmlArtifact(url)
  })
  return (
    <div ref={nearRef} className="artifact-library-thumb">
      {html && snapshot.url ? (
        <HtmlArtifactThumb url={snapshot.url} title={artifact.filename} openLabel={openLabel} onOpen={onOpen} />
      ) : !unavailable && isImageEntry(entry) ? (
        <button type="button" className="artifact-library-thumb-image" aria-label={`${openLabel} · ${artifact.filename}`} onClick={onOpen}>
          <img src={filePreviewUrl(artifact.path)} alt="" loading="lazy" />
        </button>
      ) : (
        <span className="artifact-library-thumb-icon" aria-hidden>
          <FileTypeIcon name={artifact.filename} size={16} />
        </span>
      )}
    </div>
  )
}

export function ArtifactLibraryPage(): JSX.Element {
  const t = useT()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [view, setView] = useState<LibraryView>(readView)
  const [pinned, setPinned] = useState<Set<string>>(readPinned)
  const switchSession = useStore((s) => s.switchSession)
  const previewFile = useStore((s) => s.previewFile)
  const aliveRef = useRef(true)

  const load = useCallback(() => {
    void window.yan.listArtifactLibrary()
      .then((result) => { if (aliveRef.current) setState({ status: 'ready', entries: result.items }) })
      .catch(() => { if (aliveRef.current) setState((prev) => (prev.status === 'ready' ? prev : { status: 'error' })) })
  }, [])

  useEffect(() => {
    aliveRef.current = true
    load()
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, REFRESH_DELAY_MS)
    }
    const offPush = window.yan.onPush((msg) => { if (msg.ch === 'artifact') schedule() })
    window.addEventListener('focus', schedule)
    return () => {
      aliveRef.current = false
      if (timer) clearTimeout(timer)
      offPush()
      window.removeEventListener('focus', schedule)
    }
  }, [load])

  const visible = useMemo(() => {
    if (state.status !== 'ready') return []
    const found = state.entries.filter((entry) => matches(entry, query.trim()))
    return [...found.filter((entry) => pinned.has(libraryEntryKey(entry))), ...found.filter((entry) => !pinned.has(libraryEntryKey(entry)))]
  }, [state, query, pinned])
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }), [])

  const changeView = (next: LibraryView): void => {
    setView(next)
    writeLocal(VIEW_KEY, next)
  }

  const togglePin = (entry: ArtifactLibraryEntry): void => {
    setPinned((prev) => {
      const next = new Set(prev)
      const key = libraryEntryKey(entry)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      writeLocal(PINNED_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const openSession = (entry: ArtifactLibraryEntry): void => {
    if (!entry.sessionPath) return
    useUiV3.getState().navigate({ name: 'chat' })
    void switchSession(entry.sessionPath)
  }

  const openEntry = (entry: ArtifactLibraryEntry): void => {
    if (entry.artifact.unavailable) return
    if (entry.artifact.previewable) void previewFile(entry.artifact.path)
    else void window.yan.openPath(entry.artifact.path)
  }

  const metaOf = (entry: ArtifactLibraryEntry): string => {
    const { artifact } = entry
    return [
      entry.versions > 1 ? `v${artifact.version ?? entry.versions}` : '',
      artifact.unavailable ? t('artifact.unavailable') : formatBytes(artifact.bytes),
      dateFormat.format(artifact.createdAt),
      entry.sessionTitle ?? ''
    ].filter(Boolean).join(' · ')
  }

  const actionsOf = (entry: ArtifactLibraryEntry): JSX.Element => {
    const { artifact } = entry
    const unavailable = Boolean(artifact.unavailable)
    const isPinned = pinned.has(libraryEntryKey(entry))
    return (
      <div className="artifact-library-actions">
        <IconButton size="sm" aria-label={isPinned ? t('artifactLibrary.unpin') : t('artifactLibrary.pin')} onPress={() => togglePin(entry)}>
          {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
        </IconButton>
        <IconButton size="sm" aria-label={t('artifactLibrary.openSession')} isDisabled={!entry.sessionPath} onPress={() => openSession(entry)}>
          <MessageSquare size={14} />
        </IconButton>
        <IconButton size="sm" aria-label={t('artifact.reveal')} isDisabled={unavailable} onPress={() => void window.yan.revealPath(artifact.path)}>
          <FolderOpen size={14} />
        </IconButton>
        {artifact.previewable || unavailable ? (
          <IconButton size="sm" aria-label={t('artifactLibrary.openFile')} isDisabled={unavailable} onPress={() => void window.yan.openPath(artifact.path)}>
            <ExternalLink size={14} />
          </IconButton>
        ) : (
          <Button size="sm" variant="ghost" onPress={() => void window.yan.openPath(artifact.path)}>
            {t('artifactLibrary.openFile')}
          </Button>
        )}
      </div>
    )
  }

  const nameOf = (entry: ArtifactLibraryEntry): JSX.Element => {
    const { artifact } = entry
    const unavailable = Boolean(artifact.unavailable)
    return (
      <button type="button" className="artifact-library-name" disabled={unavailable || !artifact.previewable} onClick={() => openEntry(entry)} title={artifact.filename}>
        {pinned.has(libraryEntryKey(entry)) ? <Pin size={12} aria-label={t('artifactLibrary.pinned')} className="artifact-library-pin" /> : null}
        {artifact.filename}
      </button>
    )
  }

  return (
    <div className="artifact-library" data-testid="v3-artifact-library" data-view={view}>
      <PageHeader
        className="artifact-library-head"
        title={
          <span className="artifact-library-title">
            <Layers size={18} aria-hidden /> {t('artifactLibrary.title')}
          </span>
        }
        description={t('artifactLibrary.subtitle')}
        actions={
          <div className="artifact-library-tools">
            <SegmentedControl
              label={t('artifactLibrary.view')}
              value={view}
              onChange={changeView}
              options={[
                { value: 'list', label: t('artifactLibrary.viewList'), testId: 'v3-artifact-library-view-list' },
                { value: 'grid', label: t('artifactLibrary.viewGrid'), testId: 'v3-artifact-library-view-grid' }
              ]}
            />
            <SearchField className="artifact-library-search" aria-label={t('artifactLibrary.search')} placeholder={t('artifactLibrary.search')} value={query} onChange={setQuery} />
          </div>
        }
      />
      {state.status === 'loading' ? <p className="artifact-library-note">{t('artifact.reading')}</p> : null}
      {state.status === 'error' ? <Notice tone="fail">{t('artifactLibrary.loadFailed')}</Notice> : null}
      {state.status === 'ready' && !state.entries.length ? (
        <EmptyState icon={<Layers size={20} />} title={t('artifactLibrary.empty')} description={t('artifactLibrary.emptyHint')} />
      ) : null}
      {state.status === 'ready' && state.entries.length > 0 && !visible.length ? (
        <p className="artifact-library-note">{t('artifactLibrary.noMatch')}</p>
      ) : null}
      {visible.length && view === 'list' ? (
        <ul className="artifact-library-list">
          {visible.map((entry) => (
            <li key={libraryEntryKey(entry)} className="artifact-library-row" data-unavailable={entry.artifact.unavailable || undefined}>
              <FileTypeIcon name={entry.artifact.filename} size={16} />
              <div className="artifact-library-main">
                {nameOf(entry)}
                <span className="artifact-library-meta">{metaOf(entry)}</span>
                {entry.artifact.description ? <span className="artifact-library-desc">{entry.artifact.description}</span> : null}
              </div>
              {actionsOf(entry)}
            </li>
          ))}
        </ul>
      ) : null}
      {visible.length && view === 'grid' ? (
        <ul className="artifact-library-grid" data-testid="v3-artifact-library-grid">
          {visible.map((entry) => (
            <li key={libraryEntryKey(entry)} className="artifact-library-card" data-unavailable={entry.artifact.unavailable || undefined}>
              <LibraryThumb entry={entry} openLabel={t('artifact.previewHint')} onOpen={() => openEntry(entry)} />
              <div className="artifact-library-main">
                {nameOf(entry)}
                <span className="artifact-library-meta">{metaOf(entry)}</span>
              </div>
              {actionsOf(entry)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
