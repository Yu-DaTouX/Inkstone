import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

export const TREE_WIDTH_KEY = 'inkstone.v3.files.treeWidth'
export const TREE_SHOWN_KEY = 'inkstone.v3.files.treeShown'
export const TREE_WIDTH_DEFAULT = 240
export const TREE_WIDTH_MIN = 160
export const TREE_WIDTH_MAX = 640
export const PREVIEW_MIN_WIDTH = 160
export const SPLIT_FIT_WIDTH = 400
const KEY_STEP = 16

export function clampTreeWidth(width: number, paneWidth: number): number {
  const limit = paneWidth > 0 ? Math.max(TREE_WIDTH_MIN, Math.min(TREE_WIDTH_MAX, paneWidth - PREVIEW_MIN_WIDTH)) : TREE_WIDTH_MAX
  return Math.round(Math.min(limit, Math.max(TREE_WIDTH_MIN, width)))
}

export function readTreeWidth(raw: string | null): number {
  const value = Number(raw)
  return Number.isFinite(value) && value >= TREE_WIDTH_MIN && value <= TREE_WIDTH_MAX ? value : TREE_WIDTH_DEFAULT
}

export interface FilesSplitLayout {
  split: boolean
  narrow: boolean
  showTree: boolean
  showPreview: boolean
  treePressed: boolean
}

export function filesSplitLayout(input: {
  hasPreview: boolean
  hasFile: boolean
  paneWidth: number
  treeShown: boolean
  narrowTree: boolean
}): FilesSplitLayout {
  if (!input.hasPreview) return { split: false, narrow: false, showTree: true, showPreview: false, treePressed: true }
  const narrow = input.paneWidth > 0 && input.paneWidth < SPLIT_FIT_WIDTH
  if (!narrow) {
    return { split: input.treeShown, narrow, showTree: input.treeShown, showPreview: true, treePressed: input.treeShown }
  }
  const tree = input.hasFile ? input.narrowTree : input.treeShown
  return { split: false, narrow, showTree: tree, showPreview: !tree, treePressed: tree }
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

export interface FilesSplit {
  hostRef: (node: HTMLElement | null) => void
  paneWidth: number
  treeWidth: number
  treeShown: boolean
  dragging: boolean
  toggleTree: () => void
  showTree: () => void
  onDividerPointerDown: (event: PointerEvent<HTMLElement>) => void
  onDividerKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  resetWidth: () => void
}

export function useFilesSplit(): FilesSplit {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  const [storedWidth, setStoredWidth] = useState(() => readTreeWidth(readStored(TREE_WIDTH_KEY)))
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [treeShown, setTreeShown] = useState(() => readStored(TREE_SHOWN_KEY) !== '0')
  const paneWidthRef = useRef(0)
  paneWidthRef.current = paneWidth
  const dragStopRef = useRef<(() => void) | null>(null)

  useEffect(() => () => dragStopRef.current?.(), [])

  useEffect(() => {
    if (!host) return undefined
    const measure = (): void => setPaneWidth(Math.round(host.getBoundingClientRect().width))
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [host])

  const commitWidth = useCallback((width: number): void => {
    const next = clampTreeWidth(width, paneWidthRef.current)
    setStoredWidth(next)
    writeStored(TREE_WIDTH_KEY, String(next))
  }, [])

  const setShown = useCallback((next: boolean): void => {
    setTreeShown(next)
    writeStored(TREE_SHOWN_KEY, next ? '1' : '0')
  }, [])

  const toggleTree = useCallback((): void => setShown(!treeShown), [setShown, treeShown])
  const showTree = useCallback((): void => setShown(true), [setShown])

  const onDividerPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      const target = event.currentTarget
      const startX = event.clientX
      const startWidth = clampTreeWidth(storedWidth, paneWidthRef.current)
      let latest = startWidth
      target.setPointerCapture(event.pointerId)
      setDragWidth(startWidth)
      const move = (ev: globalThis.PointerEvent): void => {
        latest = clampTreeWidth(startWidth - (ev.clientX - startX), paneWidthRef.current)
        setDragWidth(latest)
      }
      const detach = (): void => {
        dragStopRef.current = null
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', up)
        target.removeEventListener('pointercancel', cancel)
        window.removeEventListener('keydown', onKey, true)
      }
      const finish = (commit: boolean): void => {
        detach()
        setDragWidth(null)
        if (commit) commitWidth(latest)
      }
      const up = (): void => finish(true)
      const cancel = (): void => finish(false)
      const onKey = (ev: globalThis.KeyboardEvent): void => {
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopPropagation()
        finish(false)
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
      target.addEventListener('pointercancel', cancel)
      window.addEventListener('keydown', onKey, true)
      dragStopRef.current = detach
    },
    [storedWidth, commitWidth]
  )

  const onDividerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      const delta = event.key === 'ArrowLeft' ? KEY_STEP : event.key === 'ArrowRight' ? -KEY_STEP : 0
      if (event.key === 'Home') {
        event.preventDefault()
        commitWidth(TREE_WIDTH_MIN)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        commitWidth(TREE_WIDTH_MAX)
        return
      }
      if (!delta) return
      event.preventDefault()
      commitWidth(storedWidth + delta)
    },
    [storedWidth, commitWidth]
  )

  const resetWidth = useCallback((): void => commitWidth(TREE_WIDTH_DEFAULT), [commitWidth])

  return {
    hostRef: setHost,
    paneWidth,
    treeWidth: clampTreeWidth(dragWidth ?? storedWidth, paneWidth),
    treeShown,
    dragging: dragWidth !== null,
    toggleTree,
    showTree,
    onDividerPointerDown,
    onDividerKeyDown,
    resetWidth
  }
}
