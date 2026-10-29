import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement
} from 'react'
import { ArrowUpRight, ChevronRight, ChevronsDownUp, List, RefreshCw, Search, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, IconButton, SearchField, Spinner } from '../../ui'
import type { DirEntry } from '../../../../shared/ipc'
import {
  canAttachToContext,
  handleTreeKey,
  rangeSelected,
  rootLabel,
  tabbablePath,
  toAbsolutePath,
  toRelativePath,
  toggleSelected,
  treeIndent,
  type FileTreeRow,
  type FilesRootStatus
} from './files-model'
import { breadcrumbDirectory, breadcrumbParent } from './breadcrumb-model'
import { FileBreadcrumbs } from './FileBreadcrumbs'
import { filesText, type FilesText } from './files-text'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { FilesRowMenu } from './FilesRowMenu'
import { useFilesSearch } from './use-files-search'
import {
  CONTENT_QUERY_MAX,
  DEFAULT_CONTENT_OPTIONS,
  NAME_QUERY_MAX,
  contentQueryFrom,
  isContentQuery,
  type ContentOptions
} from './files-search'
import { FilesSearchResults } from './FilesSearchResults'
import { useFilesTree } from './use-files-tree'
import { filesSplitLayout, useFilesSplit } from './use-files-split'
import { canOpenTerminal, openFolderInTerminal } from './files-terminal'
import type { FilesMenuTarget } from './files-menu'
import type { FilesPaneProps } from '../workbench/types'
import type { PreviewOpenOptions } from '../workbench/preview-state'
import {
  PaneChromeContext,
  PaneTitle,
  PaneTools,
  usePaneChrome,
  usePaneMenu,
  type PaneChrome
} from '../workbench/pane-chrome'
import './files.css'

export const FILES_QUICK_OPEN_ATTR = 'data-files-quickopen'

export function filesClaimsQuickOpen(): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  return !!active && !!active.closest(`[${FILES_QUICK_OPEN_ATTR}]`)
}

interface MenuState {
  targets: FilesMenuTarget[]
}

export function FilesPane({ owner, onPreview, path: previewPath, Preview }: FilesPaneProps): ReactElement {
  const { lang } = useI18n()
  const text = filesText(lang)
  const chrome = usePaneChrome()
  const tree = useFilesTree(owner)
  const { state, rows, status, highlight, reveal, ensureDir, viewWindow, scrollRef, onScroll, focus, toggle, collapseAll, refresh } = tree
  const [query, setQuery] = useState('')
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const filterRef = useRef<HTMLDivElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  const [tabsHost, setTabsHost] = useState<HTMLElement | null>(null)
  const [contentOptions, setContentOptions] = useState<ContentOptions>(DEFAULT_CONTENT_OPTIONS)
  const search = useFilesSearch(owner, true, query, retry, contentOptions)
  const contentMode = isContentQuery(query)
  const split = useFilesSplit()
  const [narrowTree, setNarrowTree] = useState(false)
  const hasPreview = !!Preview
  const layout = filesSplitLayout({
    hasPreview,
    hasFile: !!previewPath,
    paneWidth: split.paneWidth,
    treeShown: split.treeShown,
    narrowTree
  })
  const currentRel = previewPath ? toRelativePath(owner.cwd, previewPath) : null

  const openFile = useCallback(
    (abs: string, options?: PreviewOpenOptions): void => {
      setNarrowTree(false)
      onPreview?.(abs, options)
    },
    [onPreview]
  )
  const toggleTree = useCallback((): void => {
    if (layout.narrow && previewPath) setNarrowTree((open) => !open)
    else split.toggleTree()
  }, [layout.narrow, previewPath, split])

  const showTreeNow = useCallback((): void => {
    if (layout.narrow && previewPath) setNarrowTree(true)
    else split.showTree()
  }, [layout.narrow, previewPath, split])

  const filterInput = (): HTMLInputElement | null => filterRef.current?.querySelector('input') ?? null
  const focusFilter = useCallback((): void => {
    showTreeNow()
    requestAnimationFrame(() => {
      const input = filterRef.current?.querySelector('input')
      input?.focus()
      input?.select()
    })
  }, [showTreeNow])

  const goToDirectory = useCallback(
    (rel: string): void => {
      setQuery('')
      showTreeNow()
      if (rel === '') {
        focus('')
        if (scrollRef.current) scrollRef.current.scrollTop = 0
        return
      }
      reveal(rel, { focus: false })
    },
    [focus, reveal, showTreeNow]
  )

  const revealInTree = useCallback(
    (abs: string): void => {
      const rel = toRelativePath(owner.cwd, abs)
      if (rel === null) return
      if (rel === '') {
        goToDirectory('')
        return
      }
      setQuery('')
      showTreeNow()
      reveal(rel)
    },
    [owner.cwd, reveal, showTreeNow, goToDirectory]
  )

  const currentDir = useMemo(() => {
    const row = rows.find((item) => item.focusable && item.path === state.focusPath)
    if (!row) return breadcrumbParent(state.focusPath) ?? ''
    return breadcrumbDirectory(state.focusPath, row.dir)
  }, [rows, state.focusPath])
  const crumbEntries = useCallback(
    (dir: string): readonly DirEntry[] | null | undefined => {
      const listing = state.listings[dir]
      if (listing === undefined) return undefined
      return listing === null ? null : listing.entries
    },
    [state.listings]
  )

  useEffect(() => {
    return window.yan.onHotkey((action) => {
      if (action !== 'cycleModel') return
      const host = sectionRef.current
      if (!host || !document.activeElement || !host.contains(document.activeElement)) return
      focusFilter()
    })
  }, [focusFilter])

  const addFileRefPaths = useStore((store) => store.addFileRefPaths)
  const activeSessionId = useStore((store) => store.session?.sessionId)
  const canAdd = canAttachToContext(owner, activeSessionId)

  const attach = useCallback(
    (paths: string[]): void => {
      if (!canAttachToContext(owner, useStore.getState().session?.sessionId) || !paths.length) return
      void addFileRefPaths(paths.map((rel) => toAbsolutePath(owner.cwd, rel)))
    },
    [owner, addFileRefPaths]
  )

  const selectedRows = useMemo(() => rows.filter((row) => row.focusable && selected.has(row.path)), [rows, selected])
  const selectedFiles = useMemo(() => selectedRows.filter((row) => !row.dir).map((row) => row.path), [selectedRows])

  const openMenu = useCallback(
    (row: FileTreeRow, anchor: HTMLElement): void => {
      menuAnchor.current = anchor
      const inSelection = selected.has(row.path) && selectedRows.length > 1
      const targets = inSelection ? selectedRows : [row]
      setMenu({ targets: targets.map((item) => ({ path: item.path, name: item.name, dir: item.dir, blocked: item.blocked })) })
    },
    [selected, selectedRows]
  )

  const onRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, path: string): void => {
      if (event.key === 'Escape' && selected.size) {
        event.preventDefault()
        setSelected(new Set())
        return
      }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault()
        const row = rows.find((item) => item.focusable && item.path === path)
        if (row) openMenu(row, event.currentTarget)
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
      else if (effect.type === 'preview') openFile(toAbsolutePath(owner.cwd, effect.path), { preview: true })
      else if (effect.type === 'add') attach([effect.path])
    },
    [rows, canAdd, focus, toggle, openFile, owner.cwd, attach, selected, openMenu]
  )

  const onRowClick = useCallback(
    (row: FileTreeRow, event: MouseEvent<HTMLButtonElement>): void => {
      if (row.kind === 'state') return
      const anchor = state.focusPath
      focus(row.path)
      if (event.shiftKey) {
        setSelected(rangeSelected(rows, anchor, row.path))
        return
      }
      if (event.ctrlKey || event.metaKey) {
        setSelected((prev) => toggleSelected(prev, row.path))
        return
      }
      setSelected(new Set())
      if (row.blocked) return
      if (row.dir) toggle(row.path)
      else openFile(toAbsolutePath(owner.cwd, row.path), { preview: event.detail < 2 })
    },
    [rows, state.focusPath, focus, toggle, openFile, owner.cwd]
  )

  const onRowDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>, row: FileTreeRow): void => {
      if (row.dir || row.blocked) {
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

  usePaneMenu('files', [
    ...(hasPreview ? [{ id: 'files:tree', label: text.showTree, checked: layout.treePressed, onAction: toggleTree }] : []),
    { id: 'files:collapse', label: text.collapseAll, icon: <ChevronsDownUp size={14} aria-hidden />, onAction: collapseAll },
    { id: 'files:refresh', label: text.refresh, icon: <RefreshCw size={14} aria-hidden />, onAction: refresh }
  ])

  const previewChrome = useMemo<PaneChrome | null>(
    () => (chrome ? { title: tabsHost, tools: chrome.tools, setMenu: chrome.setMenu } : null),
    [chrome, tabsHost]
  )

  const onSectionKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'y' && hasPreview) {
      event.preventDefault()
      toggleTree()
    }
  }

  const tabbable = tabbablePath(rows, state.focusPath)
  const visible = rows.slice(viewWindow.start, viewWindow.end)
  const searching = query.trim().length > 0
  const treeShortcut = 'Ctrl+Shift+Y'
  const treeLabel = layout.treePressed ? text.hideTree : text.showTree
  const refreshing = status === 'ready' && Object.keys(state.loading).length > 0

  return (
    <section
      className="v3-files"
      ref={(node) => {
        sectionRef.current = node
        split.hostRef(node)
      }}
      data-testid="v3-files"
      data-tree={layout.showTree ? '1' : '0'}
      data-preview={layout.showPreview ? '1' : '0'}
      data-dragging={split.dragging ? '1' : undefined}
      style={{ '--files-tree-w': `${split.treeWidth}px` } as CSSProperties}
      onKeyDown={onSectionKeyDown}
      data-files-quickopen=""
    >
      <PaneTitle>
        <span className="v3-files-headlead" data-testid="v3-files-head">
          <span className="v3-files-headtitle">{text.title}</span>
          <span className="v3-files-headtabs" ref={setTabsHost} />
        </span>
      </PaneTitle>
      <PaneTools>
        <IconButton
          size="sm"
          aria-label={text.goToFile}
          title={`${text.goToFile} (Ctrl+P)`}
          aria-keyshortcuts="Control+P"
          data-testid="v3-files-search-toggle"
          onPress={focusFilter}
        >
          <Search size={14} />
        </IconButton>
        {hasPreview ? (
          <IconButton
            size="sm"
            aria-label={treeLabel}
            title={`${treeLabel} (${treeShortcut})`}
            aria-pressed={layout.treePressed}
            aria-keyshortcuts="Control+Shift+Y"
            data-testid="v3-files-tree-toggle"
            onPress={toggleTree}
          >
            <List size={14} />
          </IconButton>
        ) : null}
      </PaneTools>

      {Preview ? (
        <div className="v3-files-preview" hidden={!layout.showPreview} data-testid="v3-files-preview">
          <PaneChromeContext.Provider value={previewChrome}>
            <Preview owner={owner} path={previewPath} treeShown={layout.showTree} onRevealInTree={revealInTree} />
          </PaneChromeContext.Provider>
        </div>
      ) : null}

      <div className="v3-files-col" hidden={!layout.showTree} role="group" aria-label={text.treeLabel}>
        {owner.cwd ? (
          <FileBreadcrumbs
            rootLabel={rootLabel(owner.cwd, state.listings['']?.rootName)}
            path={currentDir}
            text={text}
            label={text.crumbsLabel}
            browse
            entries={crumbEntries}
            onBrowse={ensureDir}
            onNavigate={goToDirectory}
          />
        ) : null}
        <div className="v3-files-filter" data-content={contentMode ? '1' : undefined} data-query={query ? '1' : undefined}>
          <SearchField
            ref={filterRef}
            aria-label={text.searchLabel}
            placeholder={text.searchPlaceholder}
            value={query}
            className="v3-files-filter-field"
            data-testid="v3-files-search-input"
            isDisabled={!owner.cwd}
            isInvalid={contentMode && search.error === 'pattern'}
            maxLength={contentMode ? CONTENT_QUERY_MAX : NAME_QUERY_MAX}
            onChange={setQuery}
            onSubmit={() => {
              const list = resultsRef.current
              const first =
                (contentMode ? list?.querySelector<HTMLButtonElement>('.v3-files-result--line') : null) ??
                list?.querySelector<HTMLButtonElement>('.v3-files-result')
              first?.click()
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown') return
              const first = resultsRef.current?.querySelector<HTMLButtonElement>('.v3-files-result')
              if (!first) return
              event.preventDefault()
              first.focus()
            }}
          />
          <span className="v3-files-filter-tail">
            {contentMode ? (
              <span className="v3-files-filter-options" role="group" aria-label={text.searchOptions} data-testid="v3-files-search-options">
                {(
                  [
                    ['matchCase', 'Aa', text.matchCase],
                    ['wholeWord', 'ab', text.wholeWord],
                    ['regexp', '.*', text.useRegexp]
                  ] as const
                ).map(([key, glyph, label]) => (
                  <IconButton
                    key={key}
                    size="sm"
                    className="v3-files-filter-option"
                    aria-label={label}
                    title={label}
                    aria-pressed={contentOptions[key]}
                    data-option={key}
                    data-testid={`v3-files-search-${key}`}
                    onPress={(event) => {
                      setContentOptions((current) => ({ ...current, [key]: !current[key] }))
                      if (event.pointerType !== 'keyboard') filterInput()?.focus()
                    }}
                  >
                    <span aria-hidden>{glyph}</span>
                  </IconButton>
                ))}
              </span>
            ) : null}
            {query ? (
              <IconButton
                size="sm"
                className="v3-files-filter-clear"
                aria-label={text.searchClear}
                title={text.searchClear}
                data-testid="v3-files-search-clear"
                onPress={() => {
                  setQuery('')
                  filterInput()?.focus()
                }}
              >
                <X size={12} />
              </IconButton>
            ) : null}
          </span>
        </div>

        {searching ? (
          <FilesSearchResults
            text={text}
            search={search}
            raw={query}
            cwd={owner.cwd}
            currentRel={currentRel}
            listRef={resultsRef}
            onRetry={() => setRetry((value) => value + 1)}
            onBack={() => filterInput()?.focus()}
            onClear={() => {
              setQuery('')
              filterInput()?.focus()
            }}
            onSearchContents={() => {
              setQuery(contentQueryFrom(query))
              filterInput()?.focus()
            }}
            onOpen={(row) => {
              if (row.dir) revealInTree(toAbsolutePath(owner.cwd, row.path))
              else openFile(toAbsolutePath(owner.cwd, row.path), row.line ? { preview: true, line: row.line } : { preview: true })
            }}
          />
        ) : (
          <>
            {status !== 'ready' ? <FilesRootState status={status} text={text} busy={!!state.loading['']} onRetry={refresh} /> : null}
            <div
              className="v3-files-scroll"
              ref={scrollRef}
              role="tree"
              aria-label={text.treeLabel}
              aria-multiselectable="true"
              hidden={status !== 'ready'}
              data-testid="v3-files-tree"
              onScroll={onScroll}
            >
              <div className="v3-files-pad" style={{ height: viewWindow.padTop }} aria-hidden />
              {visible.map((row) => (
                <FilesRowView
                  key={`${row.kind}:${row.path}:${row.depth}`}
                  row={row}
                  text={text}
                  tabbable={tabbable === row.path}
                  selected={selected.has(row.path)}
                  current={currentRel === row.path}
                  highlighted={highlight === row.path}
                  menuOpen={!!menu && menu.targets.some((target) => target.path === row.path)}
                  cwd={owner.cwd}
                  onFocus={focus}
                  onClick={onRowClick}
                  onKeyDown={onRowKeyDown}
                  onDragStart={onRowDragStart}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    focus(row.path)
                    openMenu(row, event.currentTarget)
                  }}
                />
              ))}
              <div className="v3-files-pad" style={{ height: viewWindow.padBottom }} aria-hidden />
            </div>
            <span className="v3-files-sr" role="status" aria-live="polite">
              {refreshing ? text.refreshing : ''}
            </span>
          </>
        )}
      </div>

      {layout.split && layout.showTree && layout.showPreview ? (
        <div
          className="v3-files-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={text.resizeTree}
          aria-valuenow={split.treeWidth}
          aria-valuemin={160}
          aria-valuemax={640}
          tabIndex={0}
          data-testid="v3-files-divider"
          onPointerDown={split.onDividerPointerDown}
          onKeyDown={split.onDividerKeyDown}
          onDoubleClick={split.resetWidth}
        >
          <span className="v3-files-divider-bar" aria-hidden />
        </div>
      ) : null}
      {hasPreview && !layout.showTree && layout.showPreview && !layout.narrow ? (
        <button
          type="button"
          className="v3-files-edge"
          aria-label={text.showTree}
          title={text.showTree}
          data-testid="v3-files-edge"
          onClick={showTreeNow}
        />
      ) : null}

      <FilesRowMenu
        targets={menu?.targets ?? []}
        text={text}
        cwd={owner.cwd}
        canAdd={canAdd}
        canTerminal={canOpenTerminal() && owner.active}
        anchor={menuAnchor}
        open={!!menu}
        onOpenChange={(next) => {
          if (next) return
          setMenu(null)
          const anchor = menuAnchor.current
          requestAnimationFrame(() => anchor?.focus())
        }}
        onAttach={attach}
        onPreview={(rel) => openFile(toAbsolutePath(owner.cwd, rel))}
        onTerminal={(rel) => void openFolderInTerminal(owner.key, toAbsolutePath(owner.cwd, rel))}
      />
    </section>
  )
}

function FilesRootState({
  status,
  text,
  busy,
  onRetry
}: {
  status: FilesRootStatus
  text: FilesText
  busy: boolean
  onRetry: () => void
}): ReactElement | null {
  if (status === 'ready') return null
  if (status === 'loading') {
    return (
      <div className="v3-files-block" role="status" data-testid="v3-files-loading">
        <Spinner size={12} label={text.loading} />
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="v3-files-block" data-testid="v3-files-error">
        <p className="v3-files-block-text">{text.error}</p>
        <Button size="sm" variant="ghost" isDisabled={busy} aria-label={busy ? text.listing : undefined} onPress={onRetry}>
          {text.retry}
        </Button>
      </div>
    )
  }
  return (
    <div className="v3-files-block" data-testid={status === 'none' ? 'v3-files-invalid' : 'v3-files-empty'}>
      <p className="v3-files-block-text">{status === 'none' ? text.noCwd : text.empty}</p>
    </div>
  )
}

function linkTitle(text: FilesText, row: FileTreeRow): string | undefined {
  const link = row.link
  if (!link) return undefined
  if (link.state === 'dangling') return text.linkDangling
  if (link.state === 'cycle') return text.linkCycle
  if (link.state === 'external') return text.linkExternal.replace('{target}', link.target ?? '')
  return text.linkTo.replace('{target}', link.target ?? '')
}

function FilesRowView({
  row,
  text,
  tabbable,
  selected,
  current,
  highlighted,
  menuOpen,
  cwd,
  onFocus,
  onClick,
  onKeyDown,
  onDragStart,
  onContextMenu
}: {
  row: FileTreeRow
  text: FilesText
  tabbable: boolean
  selected: boolean
  current: boolean
  highlighted: boolean
  menuOpen: boolean
  cwd: string
  onFocus: (path: string) => void
  onClick: (row: FileTreeRow, event: MouseEvent<HTMLButtonElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, path: string) => void
  onDragStart: (event: DragEvent<HTMLButtonElement>, row: FileTreeRow) => void
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void
}): ReactElement {
  const indent = { '--files-indent': `${treeIndent(row.depth)}px`, '--files-depth': String(row.depth) } as CSSProperties

  if (row.kind === 'state') {
    return (
      <div
        className="v3-files-staterow"
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

  const expandable = row.dir && !row.blocked
  const linkNote = linkTitle(text, row)
  const title = [toAbsolutePath(cwd, row.path), linkNote].filter(Boolean).join('\n')

  return (
    <button
      type="button"
      className="v3-files-row"
      role="treeitem"
      aria-selected={selected}
      aria-level={row.depth + 1}
      aria-expanded={expandable ? !!row.open : undefined}
      aria-disabled={row.blocked ? true : undefined}
      aria-current={current ? 'true' : undefined}
      draggable={!row.dir && !row.blocked}
      tabIndex={tabbable ? 0 : -1}
      style={indent}
      data-tree-path={row.path}
      data-selected={selected ? '1' : undefined}
      data-current={current ? '1' : undefined}
      data-highlighted={highlighted ? '1' : undefined}
      data-pressed={menuOpen ? '1' : undefined}
      data-blocked={row.blocked ? '1' : undefined}
      data-testid={`v3-files-row-${row.path}`}
      title={title}
      onFocus={() => onFocus(row.path)}
      onKeyDown={(event) => onKeyDown(event, row.path)}
      onDragStart={(event) => onDragStart(event, row)}
      onClick={(event) => onClick(row, event)}
      onContextMenu={onContextMenu}
    >
      <span className="v3-files-glyph" aria-hidden>
        {row.dir ? (
          <ChevronRight size={12} className="v3-files-caret" data-open={row.open ? '1' : undefined} />
        ) : (
          <FileTypeIcon name={row.name} />
        )}
      </span>
      <span className="v3-files-name">{row.name}</span>
      {row.link ? <ArrowUpRight size={12} className="v3-files-linkmark" aria-hidden /> : null}
    </button>
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
