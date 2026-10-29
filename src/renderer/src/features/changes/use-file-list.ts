import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { FILE_LIST_WIDTH, canFitFileList, clampFileListWidth, fileListLimit, isCompactPane } from './file-list'

const WIDTH_KEY = 'inkstone.changes.fileListWidth'
const SHOWN_KEY = 'inkstone.changes.fileListShown'
const COMPACT_SHOWN_KEY = 'inkstone.changes.fileListShownCompact'
const KEY_STEP = 24
const KEY_STEP_LARGE = 120

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

function readWidth(): number {
  const raw = readStored(WIDTH_KEY)
  return raw === null ? FILE_LIST_WIDTH.DEFAULT : clampFileListWidth(Number(raw))
}

export interface ChangesFileList {
  hostRef: (node: HTMLElement | null) => void
  paneWidth: number
  width: number
  limit: number
  shown: boolean
  canFit: boolean
  compact: boolean
  dragging: boolean
  show: () => void
  hide: () => void
  toggle: () => void
  resetWidth: () => void
  onDividerPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onDividerKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
}

interface DragSession {
  startX: number
  startWidth: number
}

export function useChangesFileList(): ChangesFileList {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  const [storedWidth, setStoredWidth] = useState(readWidth)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [shownPref, setShownPref] = useState(() => readStored(SHOWN_KEY) !== '0')
  const [compactShownPref, setCompactShownPref] = useState(() => readStored(COMPACT_SHOWN_KEY) === '1')
  const dragRef = useRef<DragSession | null>(null)
  const latestRef = useRef(0)
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!host) return undefined
    const measure = (): void => {
      const width = host.offsetWidth
      if (width > 0) setPaneWidth(width)
    }
    measure()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [host])

  useEffect(() => () => stopRef.current?.(), [])

  const canFit = canFitFileList(paneWidth)
  const limit = paneWidth > 0 ? fileListLimit(paneWidth) : FILE_LIST_WIDTH.MAX
  const width = clampFileListWidth(dragWidth ?? storedWidth, limit)
  const compact = isCompactPane(paneWidth)
  const shown = (compact ? compactShownPref : shownPref) && canFit

  const setShown = useCallback(
    (next: boolean): void => {
      if (compact) setCompactShownPref(next)
      else setShownPref(next)
      writeStored(compact ? COMPACT_SHOWN_KEY : SHOWN_KEY, next ? '1' : '0')
    },
    [compact]
  )

  const commitWidth = useCallback(
    (value: number): void => {
      const next = clampFileListWidth(value, limit)
      setStoredWidth(next)
      writeStored(WIDTH_KEY, String(next))
    },
    [limit]
  )

  const onDividerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      dragRef.current = { startX: event.clientX, startWidth: width }
      latestRef.current = width
      setDragging(true)
      const onMove = (move: PointerEvent): void => {
        const session = dragRef.current
        if (!session) return
        const next = Math.max(FILE_LIST_WIDTH.MIN, Math.min(limit, session.startWidth - move.clientX + session.startX))
        latestRef.current = next
        setDragWidth(next)
      }
      const finish = (commit: boolean): void => {
        const session = dragRef.current
        dragRef.current = null
        setDragging(false)
        setDragWidth(null)
        if (commit && session) commitWidth(latestRef.current)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        stopRef.current = null
      }
      const up = (): void => finish(true)
      const cancel = (): void => finish(false)
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
      stopRef.current = () => finish(false)
    },
    [commitWidth, limit, width]
  )

  const onDividerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (event.metaKey || event.altKey || event.ctrlKey) return
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        commitWidth(width + (event.key === 'ArrowLeft' ? step : -step))
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        commitWidth(FILE_LIST_WIDTH.MIN)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        commitWidth(limit)
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        if (!event.repeat) setShown(false)
      }
    },
    [commitWidth, limit, setShown, width]
  )

  return {
    hostRef: setHost,
    paneWidth,
    width,
    limit,
    shown,
    canFit,
    compact,
    dragging,
    show: () => setShown(true),
    hide: () => setShown(false),
    toggle: () => setShown(!shown),
    resetWidth: () => commitWidth(FILE_LIST_WIDTH.DEFAULT),
    onDividerPointerDown,
    onDividerKeyDown
  }
}
