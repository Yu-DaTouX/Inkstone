/**
 * 文件树业务 hook：把纯 reducer 接到 `window.yan.listDir`、焦点与虚拟化上。
 *
 * 职责边界：
 *   · 一层懒加载 —— 只对「已展开且没加载过」的目录发请求，绝不递归预扫。
 *   · owner / cwd / 隐藏开关变化时递增代次并清空本地缓存，迟到的旧响应
 *     在 reducer 里按代次丢弃，旧 A 的目录列表不会覆盖 B。
 *   · 只发正式 `listDir`（相对路径 + cwd 上下文），越界与软链接交给主进程判断。
 */
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
  /** 虚拟化窗口；命名避开全局 `window`，load 里还要用 `window.yan`。 */
  viewWindow: FilesWindow
  scrollRef: RefObject<HTMLDivElement | null>
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  /** 键盘 / 程序设定焦点；会先把目标行滚进视口再落焦。 */
  focus: (path: string) => void
  toggle: (path: string) => void
  /** 重新拉取所有已展开的目录（不碰没看过的目录）。 */
  refresh: () => void
  toggleHidden: () => void
}

export function useFilesTree(owner: FilesOwner): FilesTreeController {
  const [state, dispatch] = useReducer(filesTreeReducer, undefined, () =>
    freshTreeState(owner.key, owner.cwd, 0, false)
  )
  /** 与 state.generation 同步的请求代次；load 用它给每次请求打标。 */
  const generationRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pendingFocusRef = useRef(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT)
  const showHidden = state.showHidden
  const cwd = owner.cwd
  const ownerGeneration = owner.generation

  /* owner / cwd / 运行代次变化 → 作废整棵树。reset 保留隐藏开关。 */
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

  /*
   * 自动加载已展开但没加载过的目录。
   *
   * `state.generation === generationRef.current` 这一条很重要：reset effect 与这个
   * effect 在同一次提交里先后跑，先跑的那个已经把代次推进了；不筛就会用新代次对
   * 旧 state 发请求，被 reducer 丢掉后再补一次，白白多一次 IPC。
   */
  useEffect(() => {
    if (!cwd || state.generation !== generationRef.current) return
    for (const path of Object.keys(state.open)) {
      if (state.listings[path] === undefined && !state.loading[path]) void load(path)
    }
  }, [cwd, state.generation, state.open, state.listings, state.loading, load])

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

  /* 焦点行始终保留在渲染窗口里（见 computeWindow 的 includeIndex）。 */
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

  /* 落焦：状态更新后目标行一定已渲染（窗口包含了它）。 */
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

  const toggleHidden = useCallback((): void => {
    generationRef.current += 1
    dispatch({ type: 'toggleHidden', generation: generationRef.current })
  }, [])

  return { state, rows, viewWindow, scrollRef, onScroll, focus, toggle, refresh, toggleHidden }
}
