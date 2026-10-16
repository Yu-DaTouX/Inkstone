import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import type { TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { Section } from './ToolSection'
import type {
  DirListing,
  FileListingStatus,
  FileRequestContext,
  FileSearchResult
} from '../../../../shared/ipc'
import { Spinner } from '../ui'
import { samePath } from '../../../../shared/session-path'
import { indexVisiblePaths } from './workspace-control-guards'

function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

function relativeToCwd(cwd: string, abs: string): string | null {
  const root = cwd.replace(/[\\/]+$/, '').replace(/[\\/]/g, '/')
  const target = abs.replace(/[\\/]/g, '/')
  if (target.toLowerCase() === root.toLowerCase()) return ''
  if (!target.toLowerCase().startsWith(root.toLowerCase() + '/')) return null
  return target.slice(root.length + 1)
}

const FS_PAGE = 50

const indentStyle = (px: number): CSSProperties => ({ '--fs-indent': `${px}px` }) as CSSProperties

type FileSearchStatus = FileSearchResult['status']

function fileStatusText(t: TFunc, status: FileListingStatus | FileSearchStatus): string {
  switch (status) {
    case 'permission': return t('rp.fsPermission')
    case 'missing': return t('rp.fsMissing')
    case 'invalid': return t('rp.fsInvalid')
    case 'partial': return t('rp.fsPartial')
    case 'cancelled': return t('rp.fsSearchCancelled')
    case 'error': return t('rp.fsError')
    default: return t('rp.fsEmpty')
  }
}

export function FileTree() {
  const t = useT()
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd)
  const generation = useStore((s) =>
    s.runners.find((runner) => (runner.runId ?? runner.id) === s.activeRunnerId)?.generation ?? 0
  )
  const projectId = useStore((s) => {
    const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    if (runner?.projectId) return runner.projectId
    const summary = s.sessions.find((item) => item.id === s.session?.sessionId || item.path === s.session?.sessionFile)
    if (summary?.scope === 'global') return undefined
    const activeCwd = s.session?.cwd ?? s.settings?.cwd ?? ''
    return summary?.projectId ?? s.settings?.projects.find((project) => samePath(project.cwd, activeCwd))?.id
  })
  const previewFile = useStore((s) => s.previewFile)
  const filePreview = useStore((s) => s.filePreview)
  const closePreview = useStore((s) => s.closePreview)
  const addFileRefPaths = useStore((s) => s.addFileRefPaths)
  const attachments = useStore((s) => s.attachments)
  const fileContext = useMemo<FileRequestContext | null>(
    () => cwd ? { cwd, generation, ...(projectId ? { projectId } : {}) } : null,
    [cwd, generation, projectId]
  )

  const inContextPaths = useMemo(() => {
    const set = new Set<string>()
    for (const a of attachments) if (a.kind === 'file' && a.path) set.add(normPath(a.path))
    return set
  }, [attachments])

  const [cache, setCache] = useState<Record<string, DirListing | null>>({})
  const [open, setOpen] = useState<Set<string>>(new Set(['']))
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [focusPath, setFocusPath] = useState('')
  const [visibleLimit, setVisibleLimit] = useState(FS_PAGE)
  const requestGeneration = useRef(0)
  const [showHidden, setShowHidden] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchToggleRef = useRef<HTMLButtonElement>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchResult, setSearchResult] = useState<FileSearchResult | null>(null)
  const [searchError, setSearchError] = useState(false)
  const searchSequence = useRef(0)
  const searchRequestId = useRef<string | null>(null)

  useEffect(() => {
    requestGeneration.current += 1
    setCache({})
    setOpen(new Set(['']))
    setLoading(new Set())
    setFocusPath('')
    setError(null)
    setSearchResult(null)
    setSearchLoading(false)
    setSearchError(false)
    setVisibleLimit(FS_PAGE)
  }, [cwd, generation, projectId, showHidden])

  const previewScope = `${cwd ?? ''}\u0000${projectId ?? ''}\u0000${generation ?? 0}`
  const lastPreviewScopeRef = useRef(previewScope)
  useEffect(() => {
    if (lastPreviewScopeRef.current === previewScope) return
    lastPreviewScopeRef.current = previewScope
    if (cwd) closePreview()
  }, [closePreview, cwd, previewScope])

  const load = useCallback(
    async (path: string) => {
      const generation = requestGeneration.current
      setLoading((s) => new Set(s).add(path))
      try {
        if (!fileContext) return
        const requestContext = fileContext
        const r = await window.yan.listDir(path, showHidden, requestContext)
        if (generation !== requestGeneration.current) return
        if (!sameFileContext(r.request, requestContext)) return
        setCache((c) => ({ ...c, [path]: r }))
        setError(null)
      } catch {
        if (generation !== requestGeneration.current) return
        if (!fileContext) return
        setCache((c) => ({
          ...c,
          [path]: {
            path,
            abs: '',
            entries: [],
            skipped: [],
            truncated: false,
            status: 'error',
            error: 'error',
            request: fileContext
          }
        }))
        setError(null)
      } finally {
        setLoading((s) => {
          const n = new Set(s)
          n.delete(path)
          return n
        })
      }
    },
    [fileContext, showHidden]
  )

  useEffect(() => {
    if (!cwd) return
    if (cache[''] === undefined && !loading.has('')) void load('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, cache[''], load, loading])

  useEffect(() => {
    const query = searchQuery.trim()
    const sequence = ++searchSequence.current
    const previousRequestId = searchRequestId.current
    searchRequestId.current = null
    if (previousRequestId) void window.yan.cancelFileSearch(previousRequestId).catch(() => undefined)

    if (!searchOpen || !query || !fileContext) {
      setSearchLoading(false)
      setSearchResult(null)
      setSearchError(false)
      return
    }

    const requestId = `file-search-${Date.now()}-${sequence}`
    searchRequestId.current = requestId
    setSearchLoading(true)
    setSearchResult(null)
    setSearchError(false)
    const timer = window.setTimeout(() => {
      const request: FileRequestContext & { requestId: string; query: string; limit: number } = {
        ...fileContext,
        requestId,
        query,
        limit: 200
      }
      void window.yan.searchFiles(request).then((result) => {
        if (sequence !== searchSequence.current || !sameFileContext(result.request, fileContext)) return
        setSearchResult(result)
        setSearchLoading(false)
        setSearchError(result.status === 'invalid' || result.status === 'permission' || result.status === 'missing' || result.status === 'error')
      }).catch(() => {
        if (sequence !== searchSequence.current) return
        setSearchResult(null)
        setSearchLoading(false)
        setSearchError(true)
      })
    }, 140)
    return () => {
      window.clearTimeout(timer)
      void window.yan.cancelFileSearch(requestId).catch(() => undefined)
    }
  }, [fileContext, searchOpen, searchQuery])

  const toggleDir = useCallback(
    (path: string) => {
      const opening = !open.has(path)
      setOpen((prev) => {
        const n = new Set(prev)
        if (n.has(path)) n.delete(path)
        else n.add(path)
        return n
      })
      if (opening && cache[path] === undefined) void load(path)
    },
    [cache, load, open]
  )

  const previewRelPath = useMemo(() => {
    const abs = filePreview?.data?.abs
    if (!abs || !cwd) return undefined
    const rel = relativeToCwd(cwd, abs)
    return rel ? rel : undefined
  }, [filePreview?.data?.abs, cwd])

  const locatedPathRef = useRef('')
  useEffect(() => {
    const rel = previewRelPath
    if (!rel || locatedPathRef.current === rel) return
    locatedPathRef.current = rel
    const parts = rel.split('/').filter(Boolean)
    const dirs: string[] = ['']
    for (let i = 0; i < parts.length - 1; i++) dirs.push(parts.slice(0, i + 1).join('/'))
    setOpen((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const dir of dirs) {
        if (!next.has(dir)) {
          next.add(dir)
          changed = true
        }
      }
      return changed ? next : prev
    })
    for (const dir of dirs) if (cache[dir] === undefined && !loading.has(dir)) void load(dir)
    setFocusPath(rel)
    requestAnimationFrame(() => {
      ;[...document.querySelectorAll<HTMLElement>('[data-tree-path]')].find((row) => row.dataset.treePath === rel)?.scrollIntoView({ block: 'nearest' })
    })
  }, [previewRelPath, cache, loading, load])

  const refresh = useCallback(() => {
    for (const p of open) void load(p)
  }, [open, load])

  const rootName = cache['']?.rootName ?? t('rp.fsRoot')

  const allVisiblePaths = useMemo(() => {
    const paths: string[] = ['']
    const visit = (parent: string) => {
      if (!open.has(parent)) return
      const listing = cache[parent]
      if (!listing) return
      for (const entry of listing.entries) {
        const child = parent ? `${parent}/${entry.name}` : entry.name
        paths.push(child)
        if (entry.dir) visit(child)
      }
    }
    visit('')
    return paths
  }, [cache, open])

  const visiblePaths = useMemo(
    () => allVisiblePaths.slice(0, visibleLimit),
    [allVisiblePaths, visibleLimit]
  )

  const visibleSet = useMemo(() => new Set(visiblePaths), [visiblePaths])
  const visibleIndex = useMemo(() => indexVisiblePaths(visiblePaths), [visiblePaths])

  const focusTreePath = useCallback((path: string) => {
    setFocusPath(path)
    requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-tree-path]')]
        .find((el) => el.dataset.treePath === path)
      row?.focus()
    })
  }, [])

  const addFileToContext = useCallback(
    (rel: string) => {
      if (!cwd) return
      void addFileRefPaths([toAbsolutePath(cwd, rel)])
    },
    [addFileRefPaths, cwd]
  )

  const openSearchDirectory = useCallback((path: string) => {
    setSearchOpen(false)
    setSearchQuery('')
    const pieces = path.split('/').filter(Boolean)
    let current = ''
    setOpen((previous) => {
      const next = new Set(previous)
      next.add('')
      for (const piece of pieces) {
        current = current ? `${current}/${piece}` : piece
        next.add(current)
      }
      return next
    })
    let parent = ''
    for (const piece of pieces) {
      const child = parent ? `${parent}/${piece}` : piece
      if (cache[parent] === undefined) void load(parent)
      if (cache[child] === undefined) void load(child)
      parent = child
    }
  }, [cache, load])

  return (
    <Section
      titleKey="rp.files"
      testId="rp-files"
      extra={
        <>
          <button
            className={`rp-mini ${showHidden ? 'on' : ''}`}
            data-testid="fs-hidden-toggle"
            title={showHidden ? t('rp.fsHideHidden') : t('rp.fsShowHidden')}
            aria-pressed={showHidden}
            onClick={(e) => {
              e.stopPropagation()
              setShowHidden((v) => !v)
            }}
          >
            <Icon name={showHidden ? 'sun' : 'moon'} size={12} />
          </button>
          <button
            ref={searchToggleRef}
            className={`rp-mini ${searchOpen ? 'on' : ''}`}
            data-testid="fs-search-toggle"
            title={t('rp.fsSearchToggle')}
            aria-pressed={searchOpen}
            onClick={(e) => {
              e.stopPropagation()
              setSearchOpen((v) => !v)
            }}
          >
            <Icon name="search" size={12} />
          </button>
          <button
            className="rp-mini"
            data-testid="fs-refresh"
            title={t('rp.fsRefresh')}
            onClick={(e) => {
              e.stopPropagation()
              refresh()
            }}
          >
            <Icon name="refresh" size={12} />
          </button>
        </>
      }
    >
      {searchOpen ? (
        <div className="rp-fs-search" data-testid="fs-search-panel">
          <input
            className="rp-fs-search-input"
            data-testid="fs-search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              setSearchQuery('')
              setSearchOpen(false)
              searchToggleRef.current?.focus()
            }}
            placeholder={t('rp.fsSearchPlaceholder')}
            aria-label={t('rp.fsSearchPlaceholder')}
            autoFocus
          />
          <span className="rp-dim rp-fs-search-hint">{t('rp.fsSearchHint')}</span>
        </div>
      ) : null}

      {searchOpen && searchQuery.trim() ? (
        <FileSearchResults
          query={searchQuery.trim()}
          loading={searchLoading}
          result={searchResult}
          error={searchError}
          cwd={cwd}
          onPreview={(p) => void previewFile(p, undefined, cwd)}
          onAdd={addFileToContext}
          onOpenDirectory={openSearchDirectory}
        />
      ) : (
        <div
          className="rp-fs"
          data-testid="fs-tree"
          role="tree"
          aria-label={rootName}
        >
          <TreeRow
            path=""
            name={rootName}
            dir
            depth={0}
            variant="head"
            open={open.has('')}
            cwd={cwd}
            loading={loading.has('')}
            focused={focusPath === ''}
            visiblePaths={visiblePaths}
            visibleIndex={visibleIndex}
            onFocusPath={focusTreePath}
            onToggle={toggleDir}
          />
          {open.has('') ? (
            <TreeLevel
              listing={cache['']}
              depth={1}
              cwd={cwd}
              open={open}
              loading={loading}
              cache={cache}
              onToggle={toggleDir}
              onPreview={(p) => void previewFile(p, undefined, cwd)}
              onAdd={addFileToContext}
              focusPath={focusPath}
              visiblePaths={visiblePaths}
              visibleIndex={visibleIndex}
              onFocusPath={focusTreePath}
              visibleSet={visibleSet}
              inContextPaths={inContextPaths}
              previewPath={previewRelPath}
            />
          ) : null}
          {allVisiblePaths.length > visibleLimit ? (
            <button
              className="rp-fs-more"
              data-testid="fs-more"
              onClick={() => {
                const next = visibleLimit + FS_PAGE
                setVisibleLimit(next)
                const firstNew = allVisiblePaths[visibleLimit]
                if (allVisiblePaths.length <= next && firstNew !== undefined) focusTreePath(firstNew)
              }}
            >
              {t('rp.fsShowMore', { n: String(allVisiblePaths.length - visibleLimit) })}
            </button>
          ) : null}
        </div>
      )}

      {error ? <div className="rp-dim rp-fs-err">{error}</div> : null}
      {cache['']?.skipped.length ? (
        <div className="rp-dim" data-testid="fs-skipped">
          {t('rp.fsHidden', { names: cache[''].skipped.join('、') })}
        </div>
      ) : null}
    </Section>
  )
}

function FileSearchResults({
  query,
  loading,
  result,
  error,
  cwd,
  onPreview,
  onAdd,
  onOpenDirectory
}: {
  query: string
  loading: boolean
  result: FileSearchResult | null
  error: boolean
  cwd?: string
  onPreview: (rel: string) => void
  onAdd: (rel: string) => void
  onOpenDirectory: (rel: string) => void
}) {
  const t = useT()

  if (loading) {
    return <div className="rp-fs-search-results" data-testid="fs-search-loading"><div className="rp-dim rp-fs-state">{t('rp.fsSearchLoading')}</div></div>
  }
  if (error || !result) {
    const status = result?.status ?? 'error'
    return <div className="rp-fs-search-results" data-testid="fs-search-error"><div className="rp-dim rp-fs-state rp-fs-err">{fileStatusText(t, status)}</div></div>
  }
  if (result.status === 'cancelled') {
    return <div className="rp-fs-search-results" data-testid="fs-search-cancelled"><div className="rp-dim rp-fs-state">{t('rp.fsSearchCancelled')}</div></div>
  }
  if (result.entries.length === 0) {
    return <div className="rp-fs-search-results" data-testid="fs-search-empty"><div className="rp-dim rp-fs-state">{t('rp.fsSearchNoMatch', { query })}</div></div>
  }

  return (
    <div className="rp-fs-search-results" data-testid="fs-search-results" role="listbox" aria-label={t('rp.fsSearchResults')}>
      {result.entries.map((entry) => (
        <div className="rp-fs-search-row" key={`${entry.dir ? 'd' : 'f'}:${entry.path}`}>
          <button
            className={`rp-fs-search-main ${entry.dir ? 'dir' : 'file'}`}
            data-testid={`fs-search-row-${entry.path}`}
            title={cwd ? toAbsolutePath(cwd, entry.path) : entry.path}
            role="option"
            onClick={() => entry.dir ? onOpenDirectory(entry.path) : onPreview(entry.path)}
          >
            {entry.dir ? <Icon name="folder" size={12} /> : <span className="rp-fs-search-dot">·</span>}
            <span className="rp-fs-name">{entry.path}</span>
            <span className="rp-fs-search-kind">{entry.dir ? t('rp.fsSearchDirectory') : t('rp.fsSearchFile')}</span>
          </button>
          {!entry.dir ? (
            <button
              className="rp-fs-add"
              tabIndex={-1}
              data-testid={`fs-search-add-${entry.path}`}
              title={t('rp.fsAddContext')}
              aria-label={`${t('rp.fsAddContext')}: ${entry.path}`}
              onClick={(e) => {
                e.stopPropagation()
                onAdd(entry.path)
              }}
            >
              <Icon name="plus" size={12} />
            </button>
          ) : null}
        </div>
      ))}
      {result.truncated ? <div className="rp-dim rp-fs-state" data-testid="fs-search-truncated">{t('rp.fsSearchTruncated')}</div> : null}
      {result.status === 'partial' && !result.truncated ? <div className="rp-dim rp-fs-state" data-testid="fs-search-partial">{t('rp.fsPartial')}</div> : null}
    </div>
  )
}

function TreeLevel({
  listing,
  depth,
  cwd,
  open,
  loading,
  cache,
  onToggle,
  onPreview,
  onAdd,
  focusPath,
  visiblePaths,
  visibleIndex,
  onFocusPath,
  visibleSet,
  inContextPaths,
  previewPath
}: {
  listing: DirListing | null | undefined
  depth: number
  cwd?: string
  open: Set<string>
  loading: Set<string>
  cache: Record<string, DirListing | null>
  onToggle: (p: string) => void
  onPreview: (rel: string) => void
  onAdd: (rel: string) => void
  focusPath: string
  visiblePaths: string[]
  visibleIndex: Map<string, number>
  onFocusPath: (path: string) => void
  visibleSet: Set<string>
  inContextPaths?: Set<string>
  previewPath?: string
}) {
  const t = useT()

  if (!cwd) {
    return <div className="rp-dim rp-fs-state" data-testid="fs-invalid" style={indentStyle(depth * 14 + 14)}>{fileStatusText(t, 'invalid')}</div>
  }
  if (listing === undefined) {
    return <div className="rp-dim rp-fs-state" data-testid="fs-loading" style={indentStyle(depth * 14 + 14)}>{t('rp.fsLoading')}</div>
  }
  if (listing === null) {
    return <div className="rp-dim rp-fs-state" data-testid="fs-error" style={indentStyle(depth * 14 + 14)}>{t('rp.fsError')}</div>
  }
  const status = listing.status ?? (listing.entries.length ? 'ok' : 'empty')
  if (status !== 'ok' && status !== 'empty') {
    return (
      <div className="rp-dim rp-fs-state" data-testid={`fs-${status}`} style={indentStyle(depth * 14 + 14)}>
        {fileStatusText(t, status)}
      </div>
    )
  }
  if (listing.entries.length === 0) {
    return (
      <div className="rp-dim rp-fs-state" data-testid="fs-empty" style={indentStyle(depth * 14 + 14)}>
        {t('rp.fsEmpty')}
      </div>
    )
  }

  const nodes: ReactNode[] = []
  for (const e of listing.entries) {
    const childPath = listing.path ? `${listing.path}/${e.name}` : e.name
    if (!visibleSet.has(childPath)) break
    const isOpen = e.dir && open.has(childPath)
    nodes.push(
      <div key={childPath} className="rp-fs-node">
        <TreeRow
          path={childPath}
          name={e.name}
          dir={e.dir}
          size={e.size}
          depth={depth}
          cwd={cwd}
          open={isOpen}
          loading={e.dir && loading.has(childPath)}
          focused={focusPath === childPath}
          current={previewPath === childPath}
          inContext={
            !e.dir && cwd ? inContextPaths?.has(normPath(toAbsolutePath(cwd, childPath))) === true : false
          }
          visiblePaths={visiblePaths}
          visibleIndex={visibleIndex}
          onFocusPath={onFocusPath}
          onToggle={onToggle}
          onPreview={onPreview}
          onAdd={!e.dir && cwd ? onAdd : undefined}
          dragPath={!e.dir && cwd ? toAbsolutePath(cwd, childPath) : undefined}
        />
        {isOpen ? (
          <TreeLevel
            listing={cache[childPath]}
            depth={depth + 1}
            cwd={cwd}
            open={open}
            loading={loading}
            cache={cache}
            onToggle={onToggle}
            onPreview={onPreview}
            onAdd={onAdd}
            focusPath={focusPath}
            visiblePaths={visiblePaths}
            visibleIndex={visibleIndex}
            onFocusPath={onFocusPath}
            visibleSet={visibleSet}
            inContextPaths={inContextPaths}
            previewPath={previewPath}
          />
        ) : null}
      </div>
    )
  }

  return (
    <>
      {nodes}
      {listing.truncated ? (
        <div className="rp-dim" style={indentStyle(depth * 14 + 14)}>
          {t('rp.fsMore')}
        </div>
      ) : null}
    </>
  )
}

function TreeRow({
  path,
  name,
  dir,
  size,
  depth,
  cwd,
  open,
  loading,
  focused,
  current,
  inContext,
  variant,
  visiblePaths,
  visibleIndex,
  onFocusPath,
  onToggle,
  onPreview,
  onAdd,
  dragPath
}: {
  path: string
  name: string
  dir: boolean
  size?: number
  depth: number
  cwd?: string
  open: boolean
  loading?: boolean
  focused: boolean
  current?: boolean
  inContext?: boolean
  variant?: 'head'
  visiblePaths: string[]
  visibleIndex: Map<string, number>
  onFocusPath: (path: string) => void
  onToggle: (p: string) => void
  onPreview?: (rel: string) => void
  onAdd?: (rel: string) => void
  dragPath?: string
}) {
  const t = useT()
  const [hot, setHot] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!hot) return
    const id = setTimeout(() => setHot(false), 700)
    return () => clearTimeout(id)
  }, [hot])

  return (
    <div className="rp-fs-row-wrap">
      <button
        ref={ref}
        className={`rp-fs-row ${dir ? 'dir' : 'file'} ${variant === 'head' ? 'head' : ''} ${hot ? 'hot' : ''}`}
        style={indentStyle(variant === 'head' ? 4 : 4 + depth * 14)}
        aria-current={current ? 'true' : undefined}
        data-path={path}
        data-tree-path={path}
        data-dir={dir ? '1' : '0'}
        data-testid={`fs-row-${path || 'root'}`}
        role="treeitem"
        tabIndex={focused ? 0 : -1}
        aria-level={depth + 1}
        draggable={!!dragPath}
        title={`${cwd ? toAbsolutePath(cwd, path) : path || name}${!dir && size !== undefined ? ` · ${fmtSize(size)}` : ''}`}
        aria-expanded={dir ? open : undefined}
        onFocus={() => onFocusPath(path)}
        onKeyDown={(e) => {
          const index = visibleIndex.get(path) ?? -1
          const move = (next: string | undefined) => {
            if (next === undefined) return
            e.preventDefault()
            onFocusPath(next)
          }

          if (e.key === 'ArrowDown') {
            move(visiblePaths[index + 1])
            return
          }
          if (e.key === 'ArrowUp') {
            move(visiblePaths[index - 1])
            return
          }
          if (e.key === 'Home') {
            move(visiblePaths[0])
            return
          }
          if (e.key === 'End') {
            move(visiblePaths[visiblePaths.length - 1])
            return
          }
          if (e.key === 'ArrowRight' && dir) {
            e.preventDefault()
            if (!open) onToggle(path)
            else move(visiblePaths[index + 1])
            return
          }
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            if (dir && open) {
              onToggle(path)
            } else {
              const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
              onFocusPath(parent)
            }
            return
          }
          if ((e.key === 'Enter' || e.key === ' ') && !e.altKey) {
            e.preventDefault()
            if (dir) onToggle(path)
            else {
              setHot(true)
              onPreview?.(path)
            }
            return
          }
          if (!dir && onAdd && ((e.key === 'Enter' && e.altKey) || e.key.toLowerCase() === 'a')) {
            e.preventDefault()
            setHot(true)
            onAdd(path)
          }
        }}
        onClick={() => {
          onFocusPath(path)
          if (dir) onToggle(path)
          else {
            setHot(true)
            onPreview?.(path)
          }
        }}
        onDragStart={(e) => {
          if (!dragPath) return
          e.dataTransfer.effectAllowed = 'copy'
          e.dataTransfer.setData('application/x-yan-file-path', dragPath)
          e.dataTransfer.setData('text/plain', `@${path}`)
        }}
      >
        {dir ? <Icon name="chevron-right" size={12} className={`fs-chevron ${open ? 'open' : ''}`} /> : <span style={{ width: 12, flex: 'none' }} />}
        {dir ? (
          <Icon name={open ? 'folder-open' : 'folder'} size={12} className="rp-fs-ico" />
        ) : (
          <svg className="fs-file-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h8" /></svg>
        )}
        <span className="rp-fs-name">{name}</span>
        {inContext ? <span className="rp-fs-inctx" data-testid={`fs-inctx-${path}`} aria-hidden /> : null}
        {dir && loading ? <Spinner mute className="rp-fs-spin" /> : null}
      </button>
      {!dir && onAdd ? (
        <span className="rp-fs-trailing">
          <button
            className="rp-fs-add"
            tabIndex={-1}
            data-testid={`fs-add-${path}`}
            title={t('rp.fsAddContext')}
            aria-label={t('rp.fsAddContext')}
            onClick={(e) => {
              e.stopPropagation()
              setHot(true)
              onAdd(path)
            }}
          >
            <Icon name="plus" size={12} />
          </button>
        </span>
      ) : null}
    </div>
  )
}

function toAbsolutePath(cwd: string, rel: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  return rel ? `${root}\\${rel.replace(/\//g, '\\')}` : root
}


function sameFileContext(a: FileRequestContext | undefined, b: FileRequestContext): boolean {
  return !a || (
    samePath(a.cwd, b.cwd) &&
    a.projectId === b.projectId &&
    a.generation === b.generation
  )
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n / 1024 < 10 ? 1 : 0)}K`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}
