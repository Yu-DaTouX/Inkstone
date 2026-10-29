import { Fragment, type KeyboardEvent, type ReactElement, type RefObject } from 'react'
import { Folder } from 'lucide-react'
import { Button, EmptyState, ListRow, Notice, Spinner } from '../../ui'
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
    return <EmptyState className="v3-files-note" size="sm" title={text.contentHint} data-testid="v3-files-search-hint" />
  }
  if (search.mode === parsed.mode && search.error === 'pattern' && search.phase === 'done') {
    return (
      <Notice className="v3-files-note" tone="fail" variant="hint" role="alert" data-testid="v3-files-search-pattern">
        {text.contentPattern}
      </Notice>
    )
  }
  if (search.phase !== 'done' && !search.rows.length) {
    return (
      <EmptyState className="v3-files-note" size="sm" role="status" icon={<Spinner size="xs" />} title={text.searching} data-testid="v3-files-search-busy" />
    )
  }
  if (search.failed) {
    return (
      <EmptyState
        className="v3-files-note"
        size="sm"
        role="alert"
        title={failureText(text, search)}
        action={
          <Button size="sm" variant="ghost" onPress={onRetry} data-testid="v3-files-search-retry">
            {text.retry}
          </Button>
        }
        data-testid="v3-files-search-failed"
      />
    )
  }
  if (!search.rows.length) {
    if (search.mode === 'content') {
      return <EmptyState className="v3-files-note" size="sm" title={text.contentEmpty} data-testid="v3-files-search-empty" />
    }
    return (
      <EmptyState
        className="v3-files-note"
        size="sm"
        title={text.searchEmpty}
        action={
          <Button size="sm" variant="ghost" onPress={onSearchContents} data-testid="v3-files-search-contents">
            {text.searchInContents}
          </Button>
        }
        data-testid="v3-files-search-empty"
      />
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
              <ListRow
                role="listitem"
                className="v3-files-result v3-files-result--line"
                title={`${toAbsolutePath(cwd, row.path)}:${row.line}`}
                aria-label={`${row.path}:${row.line} ${row.text ?? ''}`}
                data-testid={`v3-files-result-${row.key}`}
                onClick={() => onOpen(row)}
              >
                <span className="v3-files-result-body">
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
                </span>
              </ListRow>
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
          <ListRow
            key={row.key}
            role="listitem"
            className="v3-files-result"
            title={toAbsolutePath(cwd, row.path)}
            current={currentRel === row.path}
            icon={row.dir ? <Folder size={14} /> : <FileTypeIcon name={row.name} size={14} />}
            data-group={search.mode === 'content' ? '1' : undefined}
            data-testid={`v3-files-result-${row.key}`}
            onClick={() => onOpen(row)}
          >
            <span className="v3-files-result-body">
              <span className="v3-files-result-name" data-matched={matched ? '1' : undefined}>
                <Highlighted parts={row.nameParts} />
              </span>
              {row.parent ? <span className="v3-files-result-path">{row.parent}</span> : null}
            </span>
          </ListRow>
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
