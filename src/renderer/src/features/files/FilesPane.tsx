import { useCallback, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { ChevronRight, Eye, EyeOff, File, Folder, FolderOpen, Plus, RefreshCw } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { IconButton } from '../../ui'
import {
  canAttachToContext,
  handleTreeKey,
  rowForPath,
  rootLabel,
  toAbsolutePath,
  type FileTreeRow
} from './files-model'
import { filesText, type FilesText } from './files-text'
import { useFilesTree } from './use-files-tree'
import type { FilesPaneProps } from '../workbench/types'
import './files.css'

export function FilesPane({ owner, onPreview }: FilesPaneProps): ReactElement {
  const { lang } = useI18n()
  const text = filesText(lang)
  const { state, rows, viewWindow, scrollRef, onScroll, focus, toggle, refresh, toggleHidden } =
    useFilesTree(owner)

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

  const onRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, path: string): void => {
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
    [rows, canAdd, focus, toggle, onPreview, owner.cwd, onAdd]
  )

  const onRowClick = useCallback(
    (row: FileTreeRow): void => {
      if (row.kind === 'state') return
      focus(row.path)
      if (row.dir) toggle(row.path)
      else onPreview?.(toAbsolutePath(owner.cwd, row.path))
    },
    [focus, toggle, onPreview, owner.cwd]
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

      {!owner.cwd ? (
        <p className="v3-files-state v3-files-state-block" data-testid="v3-files-invalid">
          {text.invalid}
        </p>
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
              canAdd={canAdd}
              cwd={owner.cwd}
              onFocus={focus}
              onClick={onRowClick}
              onKeyDown={onRowKeyDown}
              onAdd={onAdd}
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
  canAdd,
  cwd,
  onFocus,
  onClick,
  onKeyDown,
  onAdd
}: {
  row: FileTreeRow
  text: FilesText
  focused: boolean
  canAdd: boolean
  cwd: string
  onFocus: (path: string) => void
  onClick: (row: FileTreeRow) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, path: string) => void
  onAdd: (path: string) => void
}): ReactElement {
  const indent = { '--files-depth': String(row.depth) } as CSSProperties

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
    <div className="v3-files-rowwrap" role="none">
      <button
        type="button"
        className={`v3-files-row ${row.dir ? 'is-dir' : 'is-file'}`}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={row.dir ? !!row.open : undefined}
        tabIndex={focused ? 0 : -1}
        style={indent}
        data-tree-path={row.path}
        data-testid={`v3-files-row-${row.path || 'root'}`}
        title={title}
        onFocus={() => onFocus(row.path)}
        onKeyDown={(event) => onKeyDown(event, row.path)}
        onClick={() => onClick(row)}
      >
        <span className="v3-files-chev" aria-hidden>
          {row.dir ? <ChevronRight size={12} className={row.open ? 'is-open' : ''} /> : null}
        </span>
        <span className="v3-files-ico" aria-hidden>
          {row.dir ? row.open ? <FolderOpen size={14} /> : <Folder size={14} /> : <File size={14} />}
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
