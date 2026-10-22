import { useEffect, useMemo, useState, type JSX } from 'react'
import { FolderOpen, Layers, MessageSquare } from 'lucide-react'
import type { ArtifactLibraryItem as ArtifactLibraryEntry } from '../../../../shared/artifact-library'
import { useT } from '../../i18n'
import { Button, EmptyState, IconButton, Notice, PageHeader, SearchField } from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import './artifact-library.css'

type LoadState = { status: 'loading' } | { status: 'ready'; entries: ArtifactLibraryEntry[] } | { status: 'error' }

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

export function ArtifactLibraryPage(): JSX.Element {
  const t = useT()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const switchSession = useStore((s) => s.switchSession)
  const previewFile = useStore((s) => s.previewFile)

  useEffect(() => {
    let alive = true
    void window.yan.listArtifactLibrary()
      .then((result) => { if (alive) setState({ status: 'ready', entries: result.items }) })
      .catch(() => { if (alive) setState({ status: 'error' }) })
    return () => { alive = false }
  }, [])

  const visible = useMemo(() => (state.status === 'ready' ? state.entries.filter((entry) => matches(entry, query.trim())) : []), [state, query])
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }), [])

  const openSession = (entry: ArtifactLibraryEntry): void => {
    if (!entry.sessionPath) return
    useUiV3.getState().navigate({ name: 'chat' })
    void switchSession(entry.sessionPath)
  }

  return (
    <div className="artifact-library" data-testid="v3-artifact-library">
      <PageHeader
        className="artifact-library-head"
        title={t('artifactLibrary.title')}
        description={t('artifactLibrary.subtitle')}
        actions={
          <SearchField aria-label={t('artifactLibrary.search')} placeholder={t('artifactLibrary.search')} value={query} onChange={setQuery} />
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
      {visible.length ? (
        <ul className="artifact-library-list">
          {visible.map((entry) => {
            const { artifact } = entry
            const unavailable = Boolean(artifact.unavailable)
            return (
              <li key={`${entry.sessionId}:${artifact.id}`} className="artifact-library-row" data-unavailable={unavailable || undefined}>
                <FileTypeIcon name={artifact.filename} size={16} />
                <div className="artifact-library-main">
                  <button
                    type="button"
                    className="artifact-library-name"
                    disabled={unavailable || !artifact.previewable}
                    onClick={() => void previewFile(artifact.path)}
                    title={artifact.filename}
                  >
                    {artifact.filename}
                  </button>
                  <span className="artifact-library-meta">
                    {[
                      entry.versions > 1 ? `v${artifact.version ?? entry.versions}` : '',
                      unavailable ? t('artifact.unavailable') : formatBytes(artifact.bytes),
                      dateFormat.format(artifact.createdAt),
                      entry.sessionTitle ?? ''
                    ].filter(Boolean).join(' · ')}
                  </span>
                  {artifact.description ? <span className="artifact-library-desc">{artifact.description}</span> : null}
                </div>
                <div className="artifact-library-actions">
                  <IconButton size="sm" aria-label={t('artifactLibrary.openSession')} isDisabled={!entry.sessionPath} onPress={() => openSession(entry)}>
                    <MessageSquare size={14} />
                  </IconButton>
                  <IconButton size="sm" aria-label={t('artifact.reveal')} isDisabled={unavailable} onPress={() => void window.yan.revealPath(artifact.path)}>
                    <FolderOpen size={14} />
                  </IconButton>
                  {!artifact.previewable && !unavailable ? (
                    <Button size="sm" variant="ghost" onPress={() => void window.yan.openPath(artifact.path)}>
                      {t('artifactLibrary.openFile')}
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
