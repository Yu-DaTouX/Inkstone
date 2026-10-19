import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement
} from 'react'
import { ChevronRight, ChevronsDownUp, Eye, EyeOff, Folder, FolderOpen, Plus, RefreshCw, Search, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, IconButton } from '../../ui'
import {
  canAttachToContext,
  handleTreeKey,
  rangeSelected,
  rowForPath,
  rootLabel,
  toAbsolutePath,
  toggleSelected,
  type FileTreeRow
} from './files-model'
import { filesText, type FilesText } from './files-text'
import { filesIconSpec } from './files-icon'
import { FilesRowMenu } from './FilesRowMenu'
import { useFilesSearch, type FilesSearchState } from './use-files-search'
import { useFilesTree } from './use-files-tree'
import type { FilesPaneProps } from '../workbench/types'
import './files.css'

export function FilesPane({ owner, onPreview }: FilesPaneProps): ReactElement {
  const { lang } = useI18n()
  const text = filesText(lang)
  const { state, rows, viewWindow, scrollRef, onScroll, focus, toggle, collapseAll, refresh, toggleHidden } =
    useFilesTree(owner)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const search = useFilesSearch(owner, searchOpen, query)
  const selectedFiles = useMemo(
    () => rows.filter((row) => row.kind === 'file' && selected.has(row.path)).map((row) => row.path),
    [rows, selected]
  )

  const addFileRefPaths = useStore((store) => store.addFileRefPaths)
  const activeSessionId = useStore((store) => store.session?.sessionId)
  const canAdd = canAttachToContext(owner, activeSessionId)

  const onAdd = useCallback(
    (rel: string): void => {
      if (!canAttachToContext(owner, useStore.getState().session?.sessionId)) return
      void addFileRefPaths([toAbsolutePath(owner.cwd, rel)])
    },
    [owner, addFileRefPaths]
  )

  const addSelected = useCallback((): void => {
    if (!canAttachToContext(owner, useStore.getState().session?.sessionId)) return
    if (!selectedFiles.length) return
    void addFileRefPaths(selectedFiles.map((rel) => toAbsolutePath(owner.cwd, rel)))
  }, [owner, addFileRefPaths, selectedFiles])

  const onRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, path: string): void => {
      if (event.key === 'Escape' && selected.size) {
        event.preventDefault()
        setSelected(new Set())
        return
      }
      const effect = handleTreeKey({
        rows,
        currentPath: path,
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        isComposing: event.nativeEvent.isComposing,
        canAdd
      })
      if (effect.type === 'none') return
      event.preventDefault()
      if (effect.type === 'focus') focus(effect.path)
      else if (effect.type === 'toggle') toggle(effect.path)
      else if (effect.type === 'preview') onPreview?.(toAbsolutePath(owner.cwd, effect.path))
      else if (effect.type === 'add') onAdd(effect.path)
    },
    [rows, canAdd, focus, toggle, onPreview, owner.cwd, onAdd, selected]
  )

  const onRowClick = useCallback(
    (row: FileTreeRow, event: MouseEvent<HTMLButtonElement>): void => {
      if (row.kind === 'state') return
      const anchor = state.focusPath
      focus(row.path)
      if (row.dir) {
        setSelected(new Set())
        toggle(row.path)
        return
      }
      if (event.shiftKey) {
        setSelected(rangeSelected(rows, anchor, row.path))
        return
      }
      if (event.ctrlKey || event.metaKey) {
        setSelected((prev) => toggleSelected(prev, row.path))
        return
      }
      setSelected(new Set())
      onPreview?.(toAbsolutePath(owner.cwd, row.path))
    },
    [rows, state.focusPath, focus, toggle, onPreview, owner.cwd]
  )

  const onRowDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>, row: FileTreeRow): void => {
      if (row.dir) {
        event.preventDefault()
        return
      }
      const paths = selected.has(row.path) && selectedFiles.length > 1 ? selectedFiles : [row.path]
      const absolute = paths.map((rel) => toAbsolutePath(owner.cwd, rel))
      event.dataTransfer.setData('application/x-yan-file-path', absolute[0])
      event.dataTransfer.setData('application/x-yan-file-paths', JSON.stringify(absolute))
      event.dataTransfer.effectAllowed = 'copy'
    },
    [owner.cwd, selected, selectedFiles]
  )

  const rootName = rowForPath(rows, '')?.name ?? rootLabel(owner.cwd)
  const visible = rows.slice(viewWindow.start, viewWindow.end)

  return (
    <section className="v3-files" data-testid="v3-files" aria-label={text.treeLabel}>
      <div className="v3-files-bar">
        <span className="v3-files-title" title={owner.cwd || rootName}>
          {rootName}
        </span>
        <div className="v3-files-actions">
          <IconButton
            aria-label={text.collapseAll}
            title={text.collapseAll}
            data-testid="v3-files-collapse"
            onPress={collapseAll}
          >
            <ChevronsDownUp size={14} />
          </IconButton>
          <IconButton
            aria-label={text.searchLabel}
            title={text.searchLabel}
            data-testid="v3-files-search-toggle"
            onPress={() => {
              setSearchOpen((open) => {
                if (open) setQuery('')
                return !open
              })
            }}
          >
            <Search size={14} />
          </IconButton>
          <IconButton
            aria-label={state.showHidden ? text.hideHidden : text.showHidden}
            title={state.showHidden ? text.hideHidden : text.showHidden}
            data-testid="v3-files-hidden"
            onPress={toggleHidden}
          >
            {state.showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
          </IconButton>
          <IconButton
            aria-label={text.refresh}
            title={text.refresh}
            data-testid="v3-files-refresh"
            onPress={refresh}
          >
            <RefreshCw size={14} />
          </IconButton>
        </div>
      </div>

      {searchOpen ? (
        <div className="v3-files-searchbar">
          <Search size={13} aria-hidden className="v3-files-search-ico" />
          <input
            className="ui-input v3-files-search-input"
            aria-label={text.searchLabel}
            placeholder={text.searchPlaceholder}
            value={query}
            autoFocus
            data-testid="v3-files-search-input"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              setQuery('')
              setSearchOpen(false)
            }}
          />
          <IconButton aria-label={text.searchClear} title={text.searchClear} onPress={() => setQuery('')}>
            <X size={13} />
          </IconButton>
        </div>
      ) : null}

      {selectedFiles.length > 1 ? (
        <div className="v3-files-bulk" data-testid="v3-files-bulk">
          <span className="v3-files-bulk-count">
            {text.selectedCount.replace('{n}', String(selectedFiles.length))}
          </span>
          <Button size="sm" variant="ghost" isDisabled={!canAdd} onPress={addSelected}>
            {text.addSelected}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => setSelected(new Set())}>
            {text.clearSelection}
          </Button>
        </div>
      ) : null}

      {!owner.cwd ? (
        <p className="v3-files-state v3-files-state-block" data-testid="v3-files-invalid">
          {text.invalid}
        </p>
      ) : searchOpen && query.trim() ? (
        <FilesSearchResults
          text={text}
          search={search}
          cwd={owner.cwd}
          onOpen={(path) => onPreview?.(toAbsolutePath(owner.cwd, path))}
        />
      ) : (
        <div
          className="v3-files-scroll"
          ref={scrollRef}
          role="tree"
          aria-label={text.treeLabel}
          data-testid="v3-files-tree"
          onScroll={onScroll}
        >
          <div className="v3-files-pad" style={{ height: viewWindow.padTop }} aria-hidden />
          {visible.map((row) => (
            <FilesRowView
              key={`${row.kind}:${row.path}:${row.depth}`}
              row={row}
              text={text}
              focused={state.focusPath === row.path}
              selected={selected.has(row.path)}
              canAdd={canAdd}
              cwd={owner.cwd}
              onFocus={focus}
              onClick={onRowClick}
              onKeyDown={onRowKeyDown}
              onAdd={onAdd}
              onDragStart={onRowDragStart}
            />
          ))}
          <div className="v3-files-pad" style={{ height: viewWindow.padBottom }} aria-hidden />
        </div>
      )}
    </section>
  )
}

function FilesRowView({
  row,
  text,
  focused,
  selected,
  canAdd,
  cwd,
  onFocus,
  onClick,
  onKeyDown,
  onAdd,
  onDragStart
}: {
  row: FileTreeRow
  text: FilesText
  focused: boolean
  selected: boolean
  canAdd: boolean
  cwd: string
  onFocus: (path: string) => void
  onClick: (row: FileTreeRow, event: MouseEvent<HTMLButtonElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, path: string) => void
  onAdd: (path: string) => void
  onDragStart: (event: DragEvent<HTMLButtonElement>, row: FileTreeRow) => void
}): ReactElement {
  const indent = { '--files-depth': String(row.depth) } as CSSProperties
  const iconSpec = filesIconSpec(row.name)
  const rowRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const restoreRowFocus = (): void => {
    requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>('.v3-files-row')?.focus())
  }

  if (row.kind === 'state') {
    return (
      <div
        className="v3-files-state"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-disabled="true"
        style={indent}
        data-testid={`v3-files-state-${row.path || 'root'}`}
      >
        {statusLabel(text, row.state)}
      </div>
    )
  }

  const title = `${toAbsolutePath(cwd, row.path)}${
    !row.dir && row.size !== undefined ? ` · ${formatSize(row.size)}` : ''
  }`

  return (
    <div
      className="v3-files-rowwrap"
      role="none"
      ref={rowRef}
      data-menu={menuOpen ? '1' : undefined}
      onContextMenu={(event) => {
        event.preventDefault()
        onFocus(row.path)
        setMenuOpen(true)
      }}
    >
      <button
        type="button"
        className={`v3-files-row ${row.dir ? 'is-dir' : 'is-file'}${selected ? ' is-selected' : ''}`}
        role="treeitem"
        aria-selected={row.dir ? undefined : selected}
        draggable={!row.dir}
        aria-level={row.depth + 1}
        aria-expanded={row.dir ? !!row.open : undefined}
        tabIndex={focused ? 0 : -1}
        style={indent}
        data-tree-path={row.path}
        data-testid={`v3-files-row-${row.path || 'root'}`}
        title={title}
        onFocus={() => onFocus(row.path)}
        onKeyDown={(event) => onKeyDown(event, row.path)}
        onDragStart={(event) => onDragStart(event, row)}
        onClick={(event) => onClick(row, event)}
      >
        <span className="v3-files-chev" aria-hidden>
          {row.dir ? <ChevronRight size={12} className={row.open ? 'is-open' : ''} /> : null}
        </span>
        <span className={`v3-files-ico ${row.dir ? 'is-dir' : `is-${iconSpec.tone}`}`} aria-hidden>
          {row.dir ? row.open ? <FolderOpen size={14} /> : <Folder size={14} /> : <iconSpec.Icon size={14} />}
        </span>
        <span className="v3-files-name">{row.name}</span>
      </button>
      {!row.dir && canAdd ? (
        <button
          type="button"
          className="v3-files-add"
          tabIndex={-1}
          aria-label={`${text.addContext}: ${row.name}`}
          title={text.addContext}
          data-testid={`v3-files-add-${row.path}`}
          onClick={(event) => {
            event.stopPropagation()
            onAdd(row.path)
          }}
        >
          <Plus size={12} />
        </button>
      ) : null}
      <FilesRowMenu
        row={row}
        text={text}
        cwd={cwd}
        canAdd={canAdd}
        anchor={rowRef}
        open={menuOpen}
        onOpenChange={(next) => {
          setMenuOpen(next)
          if (!next) restoreRowFocus()
        }}
        onAdd={onAdd}
      />
    </div>
  )
}

function FilesSearchResults({
  text,
  search,
  cwd,
  onOpen
}: {
  text: FilesText
  search: FilesSearchState
  cwd: string
  onOpen: (path: string) => void
}): ReactElement {
  if (search.phase === 'searching') {
    return (
      <p className="v3-files-state v3-files-state-block" data-testid="v3-files-search-busy">
        {text.searching}
      </p>
    )
  }
  if (search.failed) {
    return (
      <p className="v3-files-state v3-files-state-block" data-testid="v3-files-search-failed">
        {text.searchFailed}
      </p>
    )
  }
  if (!search.rows.length) {
    return (
      <p className="v3-files-state v3-files-state-block" data-testid="v3-files-search-empty">
        {text.searchEmpty}
      </p>
    )
  }
  return (
    <div className="v3-files-scroll" role="list" data-testid="v3-files-search-results">
      {search.rows.map((row) => {
        const spec = filesIconSpec(row.name)
        const Icon = spec.Icon
        const location = row.line ? `${row.path}:${row.line}` : row.path
        return (
          <button
            key={row.key}
            type="button"
            role="listitem"
            className="v3-files-result"
            title={`${toAbsolutePath(cwd, row.path)}${row.line ? `:${row.line}` : ''}`}
            data-testid={`v3-files-result-${row.key}`}
            onClick={() => onOpen(row.path)}
          >
            <Icon size={14} className={`v3-files-ico is-${spec.tone}`} aria-hidden />
            <span className="v3-files-result-main">
              <span className="v3-files-result-name">{row.name}</span>
              <span className="v3-files-result-path">{location}</span>
            </span>
            {row.text ? <span className="v3-files-result-text">{row.text}</span> : null}
          </button>
        )
      })}
      {search.truncated ? <p className="v3-files-note">{text.searchTruncated}</p> : null}
    </div>
  )
}

function statusLabel(text: FilesText, state: FileTreeRow['state']): string {
  switch (state) {
    case 'loading':
      return text.loading
    case 'empty':
      return text.empty
    case 'permission':
      return text.permission
    case 'missing':
      return text.missing
    case 'invalid':
      return text.invalid
    case 'partial':
      return text.partial
    case 'error':
    default:
      return text.error
  }
}

function formatSize(size: number): string {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size / 1024 < 10 ? 1 : 0)}K`
  return `${(size / 1024 / 1024).toFixed(1)}M`
}
