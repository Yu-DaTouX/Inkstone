import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import type { RefObject, UIEvent } from 'react'
import type { DirListing, FileRequestContext } from '../../../../shared/ipc'
import {
  DEFAULT_ROW_HEIGHT,
  REVEAL_FLASH_MS,
  computeWindow,
  filesTreeReducer,
  flattenRows,
  freshTreeState,
  rootStatus,
  type FileTreeRow,
  type FilesRootStatus,
  type FilesOwner,
  type FilesTreeState,
  type FilesWindow
} from './files-model'

import { filesHiddenStore } from './files-hidden'

export interface FilesTreeController {
  state: FilesTreeState
  rows: FileTreeRow[]
  status: FilesRootStatus
  highlight: string | null
  reveal: (path: string, options?: { focus?: boolean }) => void
  ensureDir: (path: string) => void
  viewWindow: FilesWindow
  scrollRef: RefObject<HTMLDivElement | null>
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  focus: (path: string) => void
  toggle: (path: string) => void
  collapseAll: () => void
  refresh: () => void
}

let watchSeq = 0

export function useFilesTree(owner: FilesOwner): FilesTreeController {
  const [state, dispatch] = useReducer(filesTreeReducer, undefined, () =>
    freshTreeState(owner.key, owner.cwd, 0, filesHiddenStore().getSnapshot())
  )
  const hiddenStore = filesHiddenStore()
  const showHiddenPref = useSyncExternalStore(hiddenStore.subscribe, hiddenStore.getSnapshot, hiddenStore.getSnapshot)
  const generationRef = useRef(0)
  useEffect(() => {
    if (state.showHidden === showHiddenPref) return
    generationRef.current += 1
    dispatch({ type: 'toggleHidden', generation: generationRef.current })
  }, [showHiddenPref, state.showHidden])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pendingFocusRef = useRef(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT)
  const showHidden = state.showHidden
  const cwd = owner.cwd
  const ownerGeneration = owner.generation
  const watchIdRef = useRef('')
  if (!watchIdRef.current) {
    watchSeq += 1
    watchIdRef.current = `files-${watchSeq}`
  }
  const watchId = watchIdRef.current
  const openDirs = useMemo(() => Object.keys(state.open), [state.open])
  const watchContext = useCallback(
    (): FileRequestContext => ({ cwd, generation: ownerGeneration ?? generationRef.current }),
    [cwd, ownerGeneration]
  )

  useEffect(() => {
    generationRef.current += 1
    dispatch({ type: 'reset', ownerKey: owner.key, cwd: owner.cwd, generation: generationRef.current })
  }, [owner.key, owner.cwd, ownerGeneration])

  const load = useCallback(
    async (path: string): Promise<void> => {
      if (!cwd) return
      const generation = generationRef.current
      dispatch({ type: 'loadStart', path, generation })
      const context: FileRequestContext = {
        cwd,
        generation: ownerGeneration ?? generation
      }
      let listing: DirListing
      try {
        listing = await window.yan.listDir(path, showHidden, context)
      } catch {
        dispatch({ type: 'loadError', path, generation })
        return
      }
      dispatch({ type: 'loadOk', path, generation, listing })
    },
    [cwd, ownerGeneration, showHidden]
  )

  useEffect(() => {
    if (!cwd || state.generation !== generationRef.current) return
    for (const path of Object.keys(state.open)) {
      if (state.listings[path] === undefined && !state.loading[path]) void load(path)
    }
  }, [cwd, state.generation, state.open, state.listings, state.loading, load])

  useEffect(() => {
    if (!cwd) return
    void window.yan.watchDirs(watchId, openDirs, watchContext())
  }, [cwd, watchId, openDirs, watchContext])

  useEffect(() => {
    const context = watchContext()
    return () => {
      void window.yan.watchDirs(watchId, [], context)
    }
  }, [watchId, watchContext])

  useEffect(() => {
    if (!cwd) return undefined
    return window.yan.onFilesChanged((payload) => {
      if (payload.watchId !== watchId) return
      if (!openDirs.includes(payload.dir)) return
      void load(payload.dir)
    })
  }, [cwd, watchId, openDirs, load])

  const rows = useMemo(() => flattenRows(state), [state])
  const status = rootStatus(state)
  const [highlight, setHighlight] = useState<string | null>(null)
  useEffect(() => {
    if (!highlight) return undefined
    const timer = window.setTimeout(() => setHighlight(null), REVEAL_FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [highlight])
  const revealTarget = useRef<string | null>(null)
  const revealFocus = useRef(true)
  const rowIndexOf = useCallback(
    (path: string): number => rows.findIndex((row) => row.focusable && row.path === path),
    [rows]
  )
  const focusIndex = rowIndexOf(state.focusPath)

  const ensureScrollVisible = useCallback(
    (index: number): void => {
      const el = scrollRef.current
      if (!el || index < 0) return
      const top = index * rowHeight
      if (top < el.scrollTop) el.scrollTop = top
      else if (top + rowHeight > el.scrollTop + el.clientHeight) {
        el.scrollTop = top + rowHeight - el.clientHeight
      }
    },
    [rowHeight]
  )

  const focus = useCallback(
    (path: string): void => {
      const index = rowIndexOf(path)
      if (index >= 0) ensureScrollVisible(index)
      pendingFocusRef.current = true
      dispatch({ type: 'focus', path })
    },
    [rowIndexOf, ensureScrollVisible]
  )

  const viewWindow = useMemo(
    () =>
      computeWindow({
        count: rows.length,
        scrollTop,
        viewportHeight: viewportHeight || 480,
        rowHeight,
        includeIndex: focusIndex >= 0 ? focusIndex : undefined
      }),
    [rows.length, scrollTop, viewportHeight, rowHeight, focusIndex]
  )

  useEffect(() => {
    if (!pendingFocusRef.current) return
    pendingFocusRef.current = false
    const el = scrollRef.current
    if (!el) return
    const target = [...el.querySelectorAll<HTMLElement>('[data-tree-path]')].find(
      (node) => node.dataset.treePath === state.focusPath
    )
    target?.focus()
  }, [state.focusPath, rows, viewWindow])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => {
      setViewportHeight(el.clientHeight)
      const raw = getComputedStyle(el).getPropertyValue('--files-row').trim()
      const px = Number.parseFloat(raw)
      if (Number.isFinite(px) && px > 0) setRowHeight(px)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  const toggle = useCallback((path: string): void => {
    dispatch({ type: 'toggle', path })
  }, [])

  const refresh = useCallback((): void => {
    for (const path of Object.keys(state.open)) void load(path)
  }, [state.open, load])

  const collapseAll = useCallback((): void => {
    dispatch({ type: 'collapseAll' })
  }, [])

  const reveal = useCallback((path: string, options?: { focus?: boolean }): void => {
    revealTarget.current = path
    revealFocus.current = options?.focus !== false
    pendingFocusRef.current = options?.focus !== false
    dispatch({ type: 'reveal', path })
    setHighlight(path)
  }, [])

  const ensureDir = useCallback(
    (path: string): void => {
      if (state.listings[path] !== undefined || state.loading[path]) return
      void load(path)
    },
    [state.listings, state.loading, load]
  )

  useEffect(() => {
    const target = revealTarget.current
    if (!target) return
    const index = rowIndexOf(target)
    if (index < 0) return
    revealTarget.current = null
    const el = scrollRef.current
    if (!el) return
    const top = index * rowHeight
    if (top < el.scrollTop || top + rowHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2 + rowHeight / 2)
    }
    if (!revealFocus.current) return
    requestAnimationFrame(() => {
      const node = [...el.querySelectorAll<HTMLElement>('[data-tree-path]')].find((item) => item.dataset.treePath === target)
      node?.focus({ preventScroll: true })
    })
  }, [rowIndexOf, rowHeight])

  return { state, rows, status, highlight, reveal, ensureDir, viewWindow, scrollRef, onScroll, focus, toggle, collapseAll, refresh }
}
