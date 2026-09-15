import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

/**
 * 文件树（右栏分区）。
 *
 * ── 设计约束 ──
 * ① **懒加载，一层一次**。不做递归预扫：cwd 可能是整个仓库，
 *    递归会把主进程卡住（`node_modules` 一个目录就能有几万条）。
 * ② 单击文件 = 打开右侧只读预览；加入上下文与拖入 Composer 是独立动作。
 *    不能把「我想看这个文件」和「我想让 agent 读取这个文件」混成一次点击。
 * ③ 目录默认折叠。展开状态与已加载的内容都缓存在本组件内 ——
 *    折叠再展开不重新拉（目录内容在一次会话里基本不变）。
 * ④ 换 cwd 必须清空缓存（否则会拿旧项目的目录树当新的）。
 *
 * ── 与 completePath（@ 补全）的关系 ──
 * 两者共用同一个安全边界（见 main/files.ts）：都只能看 cwd 以内的路径。
 * 但用途不同 —— 补全是「我记得名字，帮我补全」，
 * 文件树是「我不知道有什么，让我看看」。
 */
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
  const closePreview = useStore((s) => s.closePreview)
  const addFileRefPaths = useStore((s) => s.addFileRefPaths)
  const fileContext = useMemo<FileRequestContext | null>(
    () => cwd ? { cwd, generation, ...(projectId ? { projectId } : {}) } : null,
    [cwd, generation, projectId]
  )

  /** 路径（'' = 根）→ 该层内容。null = 加载失败 */
  const [cache, setCache] = useState<Record<string, DirListing | null>>({})
  const [open, setOpen] = useState<Set<string>>(new Set(['']))
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [focusPath, setFocusPath] = useState('')
  const requestGeneration = useRef(0)
  /**
   * 是否列出隐藏项（.gitignore / .vscode / node_modules / .git 这类）。
   *
   * 用户要求：「已跳过改为已隐藏，加一个开关」。
   * 定位：它是**临时看一眼**的动作（找一个被点掉的文件、确认 .git 在不在），
   * 不值得落盘变成永久偏好 —— 所以只存在这个组件的 state 里，重启回默认。
   */
  const [showHidden, setShowHidden] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchResult, setSearchResult] = useState<FileSearchResult | null>(null)
  const [searchError, setSearchError] = useState(false)
  const searchSequence = useRef(0)
  const searchRequestId = useRef<string | null>(null)

  /* 换 cwd → 整个树作废 */
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
  }, [cwd, generation, projectId, showHidden])

  useEffect(() => {
    if (cwd) closePreview()
  }, [closePreview, cwd, generation, projectId])

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
        if (generation !== requestGeneration.current) return
        setLoading((s) => {
          const n = new Set(s)
          n.delete(path)
          return n
        })
      }
    },
    [fileContext, showHidden]
  )

  /* 根层一定要有内容（展开状态里 '' 默认就在） */
  useEffect(() => {
    if (!cwd) return
    if (cache[''] === undefined && !loading.has('')) void load('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, cache[''], load])

  /* 全项目搜索：防抖、可取消，并把响应绑定回当前项目/实例。 */
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
      setOpen((prev) => {
        const n = new Set(prev)
        if (n.has(path)) {
          n.delete(path)
        } else {
          n.add(path)
          if (cache[path] === undefined) void load(path)
        }
        return n
      })
    },
    [cache, load]
  )

  const refresh = useCallback(() => {
    // 只刷新**已展开**的层，不把没看过的目录也拉一遍
    for (const p of open) void load(p)
  }, [open, load])

  const rootName = cache['']?.rootName ?? t('rp.fsRoot')
  const total = useMemo(
    () => Object.values(cache).reduce((n, l) => n + (l?.entries.length ?? 0), 0),
    [cache]
  )

  /* 只根据已加载且展开的节点生成可见顺序；不递归触发任何 IO。 */
  const visiblePaths = useMemo(() => {
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
    /* 逐层补齐缓存，仍然保持一层懒加载而不是递归预扫。 */
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
          <span className="rp-count" data-testid="fs-count">
            {total}
          </span>
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
            open={open.has('')}
            cwd={cwd}
            loading={loading.has('')}
            focused={focusPath === ''}
            visiblePaths={visiblePaths}
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
              onFocusPath={focusTreePath}
            />
          ) : null}
        </div>
      )}

      {error ? <div className="rp-dim rp-fs-err">{error}</div> : null}
      {cache['']?.skipped.length ? (
        <div className="rp-dim" data-testid="fs-skipped">
          {/*
            * 用户要求把「已跳过」改成「已隐藏」——
            * 「跳过」听起来像程序跳过了它们（可能漏内容），
            * 「隐藏」才是事实：它们还在，点上面的开关就显示。
            */}
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
              <Icon name="tag" size={12} />
            </button>
          ) : null}
        </div>
      ))}
      {result.truncated ? <div className="rp-dim rp-fs-state" data-testid="fs-search-truncated">{t('rp.fsSearchTruncated')}</div> : null}
      {result.status === 'partial' && !result.truncated ? <div className="rp-dim rp-fs-state" data-testid="fs-search-partial">{t('rp.fsPartial')}</div> : null}
    </div>
  )
}

/** 一层的内容（根下面的所有条目） */
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
  onFocusPath
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
  onFocusPath: (path: string) => void
}) {
  const t = useT()

  if (!cwd) {
    return <div className="rp-dim rp-fs-state" data-testid="fs-invalid" style={{ paddingLeft: depth * 12 + 14 }}>{fileStatusText(t, 'invalid')}</div>
  }
  if (listing === undefined) {
    return <div className="rp-dim rp-fs-state" data-testid="fs-loading" style={{ paddingLeft: depth * 12 + 14 }}>{t('rp.fsLoading')}</div>
  }
  if (listing === null) {
    return <div className="rp-dim rp-fs-state" data-testid="fs-error" style={{ paddingLeft: depth * 12 + 14 }}>{t('rp.fsError')}</div>
  }
  const status = listing.status ?? (listing.entries.length ? 'ok' : 'empty')
  if (status !== 'ok' && status !== 'empty') {
    return (
      <div className="rp-dim rp-fs-state" data-testid={`fs-${status}`} style={{ paddingLeft: depth * 12 + 14 }}>
        {fileStatusText(t, status)}
      </div>
    )
  }
  if (listing.entries.length === 0) {
    return (
      <div className="rp-dim rp-fs-state" data-testid="fs-empty" style={{ paddingLeft: depth * 12 + 14 }}>
        {t('rp.fsEmpty')}
      </div>
    )
  }

  return (
    <>
      {listing.entries.map((e) => {
        const childPath = listing.path ? `${listing.path}/${e.name}` : e.name
        const isOpen = e.dir && open.has(childPath)
        return (
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
              visiblePaths={visiblePaths}
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
                onFocusPath={onFocusPath}
              />
            ) : null}
          </div>
        )
      })}
      {listing.truncated ? (
        <div className="rp-dim" style={{ paddingLeft: depth * 12 + 14 }}>
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
  visiblePaths,
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
  visiblePaths: string[]
  onFocusPath: (path: string) => void
  onToggle: (p: string) => void
  onPreview?: (rel: string) => void
  onAdd?: (rel: string) => void
  dragPath?: string
}) {
  const t = useT()
  const [hot, setHot] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)

  /*
   * 点击后的短暂高亮：「已插入 @路径」必须看得见 ——
   * 否则用户不知道点这一下发生了什么（输入框可能在视野下方）。
   */
  useEffect(() => {
    if (!hot) return
    const id = setTimeout(() => setHot(false), 700)
    return () => clearTimeout(id)
  }, [hot])

  return (
    <div className="rp-fs-row-wrap">
      <button
        ref={ref}
        className={`rp-fs-row ${dir ? 'dir' : 'file'} ${hot ? 'hot' : ''}`}
        style={{ paddingLeft: 4 + depth * 12 }}
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
          const index = visiblePaths.indexOf(path)
          const move = (next: string | undefined) => {
            /* 根节点的路径是空字符串，不能把它当成“没有目标”。 */
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
          /* Alt+Enter / “a” 是键盘可发现的独立加入上下文动作。 */
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
        {dir && loading ? <span className="rp-fs-spin" aria-hidden /> : null}
        {!dir && size !== undefined ? <span className="rp-fs-size">{fmtSize(size)}</span> : null}
      </button>
      {!dir && onAdd ? (
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
          <Icon name="tag" size={12} />
        </button>
      ) : null}
    </div>
  )
}

/** 文件树只给 Composer 传当前 cwd 内的已列出文件，统一转换成绝对路径。 */
function toAbsolutePath(cwd: string, rel: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  return rel ? `${root}\\${rel.replace(/\//g, '\\')}` : root
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

function sameFileContext(a: FileRequestContext | undefined, b: FileRequestContext): boolean {
  return !a || (
    samePath(a.cwd, b.cwd) &&
    a.projectId === b.projectId &&
    a.generation === b.generation
  )
}

/** 1023 B → 1023B，1.4 KB，2.1 MB（文件树里只需量级，不要精度） */
function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n / 1024 < 10 ? 1 : 0)}K`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}
