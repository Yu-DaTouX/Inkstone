import { Fragment, type KeyboardEvent, type ReactElement, type RefObject } from 'react'
import { Folder } from 'lucide-react'
import { Button, Spinner } from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { toAbsolutePath } from './files-model'
import { parseFilesQuery, resultDestination, type FilesSearchRow, type HighlightPart } from './files-search'
import type { FilesText } from './files-text'
import type { FilesSearchState } from './use-files-search'

export interface FilesSearchResultsProps {
  text: FilesText
  search: FilesSearchState
  raw: string
  cwd: string
  currentRel: string | null
  listRef: RefObject<HTMLDivElement | null>
  onRetry: () => void
  onBack: () => void
  onClear: () => void
  onOpen: (row: FilesSearchRow) => void
  onSearchContents: () => void
}

function Highlighted({ parts }: { parts: readonly HighlightPart[] }): ReactElement {
  return (
    <>
      {parts.map((part, index) => (part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
    </>
  )
}

function failureText(text: FilesText, search: FilesSearchState): string {
  if (search.mode !== 'content') return text.searchFailed
  switch (search.error) {
    case 'permission':
      return text.contentPermission
    case 'missing':
      return text.contentMissing
    case 'invalid':
      return text.contentInvalid
    default:
      return text.contentFailed
  }
}

function limitText(text: FilesText, search: FilesSearchState): string | null {
  if (!search.limit) return null
  if (search.mode !== 'content') return text.searchTruncated
  return search.limit === 'results' ? text.contentShown.replace('{n}', String(search.shown)) : text.contentScanLimit
}

export function FilesSearchResults({
  text,
  search,
  raw,
  cwd,
  currentRel,
  listRef,
  onRetry,
  onBack,
  onClear,
  onOpen,
  onSearchContents
}: FilesSearchResultsProps): ReactElement {
  const parsed = parseFilesQuery(raw)
  if (parsed.mode === 'content' && !parsed.query) {
    return <p className="v3-files-note" data-testid="v3-files-search-hint">{text.contentHint}</p>
  }
  if (search.mode === parsed.mode && search.error === 'pattern' && search.phase === 'done') {
    return (
      <p className="v3-files-note v3-files-note--error" role="alert" data-testid="v3-files-search-pattern">
        {text.contentPattern}
      </p>
    )
  }
  if (search.phase !== 'done' && !search.rows.length) {
    return (
      <div className="v3-files-note v3-files-note--busy" role="status" data-testid="v3-files-search-busy">
        <Spinner size={12} />
        <span>{text.searching}</span>
      </div>
    )
  }
  if (search.failed) {
    return (
      <div className="v3-files-note v3-files-note--error" role="alert" data-testid="v3-files-search-failed">
        <span>{failureText(text, search)}</span>
        <Button size="sm" variant="ghost" onPress={onRetry} data-testid="v3-files-search-retry">
          {text.retry}
        </Button>
      </div>
    )
  }
  if (!search.rows.length) {
    if (search.mode === 'content') {
      return <p className="v3-files-note" data-testid="v3-files-search-empty">{text.contentEmpty}</p>
    }
    return (
      <div className="v3-files-note" data-testid="v3-files-search-empty">
        <span>{text.searchEmpty}</span>
        <Button size="sm" variant="ghost" onPress={onSearchContents} data-testid="v3-files-search-contents">
          {text.searchInContents}
        </Button>
      </div>
    )
  }

  const rows = search.rows
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClear()
      return
    }
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.v3-files-result') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const destination = resultDestination(event.key, index, rows)
    if (destination === null) return
    event.preventDefault()
    if (destination === 'input') {
      onBack()
      return
    }
    const item = items[destination]
    item?.focus()
    item?.scrollIntoView({ block: 'nearest' })
  }
  const limit = limitText(text, search)

  return (
    <div
      className="v3-files-results"
      ref={listRef}
      role="list"
      aria-busy={search.phase === 'searching'}
      data-mode={search.mode}
      data-stale={search.phase === 'searching' ? '1' : undefined}
      data-testid="v3-files-search-results"
      onKeyDown={move}
    >
      {rows.map((row) => {
        if (row.kind === 'line') {
          return (
            <Fragment key={row.key}>
              <button
                type="button"
                role="listitem"
                className="v3-files-result v3-files-result--line"
                title={`${toAbsolutePath(cwd, row.path)}:${row.line}`}
                aria-label={`${row.path}:${row.line} ${row.text ?? ''}`}
                data-testid={`v3-files-result-${row.key}`}
                onClick={() => onOpen(row)}
              >
                <span className="v3-files-result-line">{row.line}</span>
                <span className="v3-files-result-snippet">
                  {row.lead ? (
                    <span className="v3-files-result-lead" dir="rtl">
                      <span dir="ltr">{row.lead}</span>
                    </span>
                  ) : null}
                  {row.hit?.length ? (
                    <span className="v3-files-result-hit">
                      <Highlighted parts={row.hit} />
                    </span>
                  ) : null}
                  {row.tail?.length ? (
                    <span className="v3-files-result-tail">
                      <Highlighted parts={row.tail} />
                    </span>
                  ) : null}
                </span>
              </button>
              {row.more ? (
                <p className="v3-files-content-more" data-testid={`v3-files-more-${row.path}`}>
                  {text.contentMore}
                </p>
              ) : null}
            </Fragment>
          )
        }
        const matched = row.nameParts.some((part) => part.hit)
        return (
          <button
            key={row.key}
            type="button"
            role="listitem"
            className="v3-files-result"
            title={toAbsolutePath(cwd, row.path)}
            data-current={currentRel === row.path ? '1' : undefined}
            data-group={search.mode === 'content' ? '1' : undefined}
            data-testid={`v3-files-result-${row.key}`}
            onClick={() => onOpen(row)}
          >
            {row.dir ? (
              <span className="v3-files-result-icon" aria-hidden>
                <Folder size={14} />
              </span>
            ) : (
              <FileTypeIcon name={row.name} className="v3-files-result-icon" />
            )}
            <span className="v3-files-result-name" data-matched={matched ? '1' : undefined}>
              <Highlighted parts={row.nameParts} />
            </span>
            {row.parent ? <span className="v3-files-result-path">{row.parent}</span> : null}
          </button>
        )
      })}
      {limit ? (
        <p className="v3-files-more" data-testid="v3-files-search-limit">
          {limit}
        </p>
      ) : null}
    </div>
  )
}
