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
  type ReactElement,
  type RefObject
} from 'react'
import { ArrowUpRight, Check, ChevronRight, ChevronsDownUp, EllipsisVertical, Folder, List, RefreshCw, Search, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover, SearchField, Separator, Spinner } from '../../ui'
import {
  canAttachToContext,
  handleTreeKey,
  rangeSelected,
  tabbablePath,
  toAbsolutePath,
  toRelativePath,
  toggleSelected,
  treeIndent,
  type FileTreeRow,
  type FilesRootStatus
} from './files-model'
import { filesText, type FilesText } from './files-text'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { FilesRowMenu } from './FilesRowMenu'
import { useFilesSearch, type FilesSearchState } from './use-files-search'
import { parseFilesQuery, type FilesSearchRow } from './files-search'
import { useFilesTree } from './use-files-tree'
import { filesSplitLayout, useFilesSplit } from './use-files-split'
import { canOpenTerminal, openFolderInTerminal } from './files-terminal'
import type { FilesMenuTarget } from './files-menu'
import type { FilesPaneProps } from '../workbench/types'
import {
  PaneChromeContext,
  PaneTitle,
  PaneTools,
  paneMenuSignature,
  usePaneChrome,
  usePaneMenu,
  type PaneChrome,
  type PaneMenuItem
} from '../workbench/pane-chrome'
import './files.css'

export const FILES_QUICK_OPEN_ATTR = 'data-files-quickopen'

export function filesClaimsQuickOpen(): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  return !!active && !!active.closest(`[${FILES_QUICK_OPEN_ATTR}]`)
}

export function FilesPane(props: FilesPaneProps): ReactElement {
  const outer = usePaneChrome()
  if (outer) return <FilesPaneBody {...props} />
  return <StandaloneFilesPane {...props} />
}

function StandaloneFilesPane(props: FilesPaneProps): ReactElement {
  const { lang } = useI18n()
  const text = filesText(lang)
  const [title, setTitle] = useState<HTMLElement | null>(null)
  const [tools, setTools] = useState<HTMLElement | null>(null)
  const [groups, setGroups] = useState<ReadonlyMap<string, readonly PaneMenuItem[]>>(() => new Map())
  const setMenu = useCallback((source: string, items: readonly PaneMenuItem[]): void => {
    setGroups((prev) => {
      if (paneMenuSignature(prev.get(source) ?? []) === paneMenuSignature(items)) return prev
      const next = new Map(prev)
      if (items.length) next.set(source, items)
      else next.delete(source)
      return next
    })
  }, [])
  const chrome = useMemo<PaneChrome>(() => ({ title, tools, setMenu }), [title, tools, setMenu])
  const ordered = ['preview', 'files'].map((source) => groups.get(source) ?? []).filter((items) => items.length > 0)
  const all = ordered.flat()
  return (
    <div className="v3-files-standalone">
      <div className="v3-files-head">
        <span className="v3-files-head-title" ref={setTitle} />
        <span className="v3-files-head-tools" ref={setTools} />
        {all.length ? (
          <MenuTrigger>
            <IconButton size="sm" aria-label={text.title} title={text.title}>
              <EllipsisVertical size={14} />
            </IconButton>
            <Popover placement="bottom end" offset={4}>
              <Menu aria-label={text.title} onAction={(key) => all.find((item) => item.id === key)?.onAction()}>
                {ordered.flatMap((items, index) => [
                  ...(index > 0 ? [<Separator key={`sep:${index}`} />] : []),
                  ...items.map((item) => (
                    <MenuItem key={item.id} id={item.id} textValue={item.label} aria-checked={item.checked}>
                      {item.checked === undefined ? item.icon : <span className="v3-files-check" aria-hidden>{item.checked ? <Check size={14} /> : null}</span>}
                      {item.label}
                    </MenuItem>
                  ))
                ])}
              </Menu>
            </Popover>
          </MenuTrigger>
        ) : null}
      </div>
      <PaneChromeContext.Provider value={chrome}>
        <FilesPaneBody {...props} />
      </PaneChromeContext.Provider>
    </div>
  )
}

interface MenuState {
  targets: FilesMenuTarget[]
}

function FilesPaneBody({ owner, onPreview, path: previewPath, Preview }: FilesPaneProps): ReactElement {
  const { lang } = useI18n()
  const text = filesText(lang)
  const chrome = usePaneChrome()
  const tree = useFilesTree(owner)
  const { state, rows, status, highlight, reveal, viewWindow, scrollRef, onScroll, focus, toggle, collapseAll, refresh } = tree
  const [query, setQuery] = useState('')
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const filterRef = useRef<HTMLDivElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  const [tabsHost, setTabsHost] = useState<HTMLElement | null>(null)
  const search = useFilesSearch(owner, true, query, retry)
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
    (abs: string): void => {
      setNarrowTree(false)
      onPreview?.(abs)
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

  const revealInTree = useCallback(
    (abs: string): void => {
      const rel = toRelativePath(owner.cwd, abs)
      if (rel === null || rel === '') return
      setQuery('')
      showTreeNow()
      reveal(rel)
    },
    [owner.cwd, reveal, showTreeNow]
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
      else if (effect.type === 'preview') openFile(toAbsolutePath(owner.cwd, effect.path))
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
      else openFile(toAbsolutePath(owner.cwd, row.path))
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
      </PaneTools>

      <div className="v3-files-col" hidden={!layout.showTree} role="group" aria-label={text.treeLabel}>
        <div className="v3-files-filter">
          <SearchField
            ref={filterRef}
            aria-label={text.searchLabel}
            placeholder={text.searchPlaceholder}
            value={query}
            className="v3-files-filter-field"
            data-testid="v3-files-search-input"
            isDisabled={!owner.cwd}
            onChange={setQuery}
            onSubmit={() => {
              const first = resultsRef.current?.querySelector<HTMLButtonElement>('.v3-files-result')
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
          {query ? (
            <IconButton
              size="sm"
              className="v3-files-filter-clear"
              aria-label={text.searchClear}
              title={text.searchClear}
              onPress={() => {
                setQuery('')
                filterInput()?.focus()
              }}
            >
              <X size={12} />
            </IconButton>
          ) : null}
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
            onOpen={(row) => {
              if (row.dir) revealInTree(toAbsolutePath(owner.cwd, row.path))
              else openFile(toAbsolutePath(owner.cwd, row.path))
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

      {Preview ? (
        <div className="v3-files-preview" hidden={!layout.showPreview} data-testid="v3-files-preview">
          <PaneChromeContext.Provider value={previewChrome}>
            <Preview owner={owner} path={previewPath} treeShown={layout.showTree} onRevealInTree={revealInTree} />
          </PaneChromeContext.Provider>
        </div>
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

function FilesSearchResults({
  text,
  search,
  raw,
  cwd,
  currentRel,
  listRef,
  onRetry,
  onBack,
  onClear,
  onOpen
}: {
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
}): ReactElement {
  const parsed = parseFilesQuery(raw)
  if (parsed.mode === 'content' && !parsed.query) {
    return <p className="v3-files-note" data-testid="v3-files-search-hint">{text.contentHint}</p>
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
      <div className="v3-files-note v3-files-note--error" data-testid="v3-files-search-failed">
        <span>{search.mode === 'content' ? text.contentFailed : text.searchFailed}</span>
        <Button size="sm" variant="ghost" onPress={onRetry}>
          {text.retry}
        </Button>
      </div>
    )
  }
  if (!search.rows.length) {
    return <p className="v3-files-note" data-testid="v3-files-search-empty">{text.searchEmpty}</p>
  }
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.v3-files-result') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      onClear()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    if (event.key === 'ArrowUp' && index <= 0) {
      onBack()
      return
    }
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? Math.min(index + 1, items.length - 1) : index - 1
    items[next]?.focus()
  }
  return (
    <div
      className="v3-files-results"
      ref={listRef}
      role="list"
      aria-busy={search.phase === 'searching'}
      data-testid="v3-files-search-results"
      onKeyDown={move}
    >
      {search.rows.map((row) => {
        const location = row.line ? `${row.path}:${row.line}` : row.path
        if (row.kind === 'line') {
          return (
            <button
              key={row.key}
              type="button"
              role="listitem"
              className="v3-files-result v3-files-result--line"
              title={`${toAbsolutePath(cwd, row.path)}:${row.line}`}
              data-testid={`v3-files-result-${row.key}`}
              onClick={() => onOpen(row)}
            >
              <span className="v3-files-result-line">{row.line}</span>
              <span className="v3-files-result-snippet">{row.text}</span>
            </button>
          )
        }
        const matched = row.nameParts.some((part) => part.hit)
        return (
          <button
            key={row.key}
            type="button"
            role="listitem"
            className="v3-files-result"
            title={toAbsolutePath(cwd, location)}
            data-current={currentRel === row.path ? '1' : undefined}
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
              {row.nameParts.map((part, index) =>
                part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>
              )}
            </span>
            {row.parent ? <span className="v3-files-result-path">{row.parent}</span> : null}
          </button>
        )
      })}
      {search.truncated ? <p className="v3-files-more">{text.searchTruncated}</p> : null}
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
