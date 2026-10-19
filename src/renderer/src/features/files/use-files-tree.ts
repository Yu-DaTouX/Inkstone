import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { RefObject, UIEvent } from 'react'
import type { DirListing, FileRequestContext } from '../../../../shared/ipc'
import {
  DEFAULT_ROW_HEIGHT,
  computeWindow,
  filesTreeReducer,
  flattenRows,
  focusablePaths,
  freshTreeState,
  type FileTreeRow,
  type FilesOwner,
  type FilesTreeState,
  type FilesWindow
} from './files-model'

export interface FilesTreeController {
  state: FilesTreeState
  rows: FileTreeRow[]
  viewWindow: FilesWindow
  scrollRef: RefObject<HTMLDivElement | null>
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  focus: (path: string) => void
  toggle: (path: string) => void
  collapseAll: () => void
  refresh: () => void
  toggleHidden: () => void
}

let watchSeq = 0

export function useFilesTree(owner: FilesOwner): FilesTreeController {
  const [state, dispatch] = useReducer(filesTreeReducer, undefined, () =>
    freshTreeState(owner.key, owner.cwd, 0, false)
  )
  const generationRef = useRef(0)
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
  const focusables = useMemo(() => focusablePaths(rows), [rows])
  const focusIndex = focusables.indexOf(state.focusPath)

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
      const index = focusables.indexOf(path)
      if (index >= 0) ensureScrollVisible(index)
      pendingFocusRef.current = true
      dispatch({ type: 'focus', path })
    },
    [focusables, ensureScrollVisible]
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
      const raw = getComputedStyle(el).getPropertyValue('--d-row').trim()
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

  const toggleHidden = useCallback((): void => {
    generationRef.current += 1
    dispatch({ type: 'toggleHidden', generation: generationRef.current })
  }, [])

  return { state, rows, viewWindow, scrollRef, onScroll, focus, toggle, collapseAll, refresh, toggleHidden }
}
