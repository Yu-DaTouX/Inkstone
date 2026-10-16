import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { useT } from '../../i18n'
import { PANEL_MAX, PANEL_MIN, RAIL_MAX, RAIL_MIN } from '../../../../shared/ipc'

const REVIEW_WIDTH_KEY = 'yan.reviewWidth'

export function Resizer({ side, review = false }: { side: 'rail' | 'panel'; review?: boolean }) {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const setRailPinned = useStore((s) => s.setRailPinned)
  const toggleRightPanel = useStore((s) => s.toggleRightPanel)
  const toggleCollapse = useCallback((): void => {
    if (side === 'rail') setRailPinned(false)
    else void toggleRightPanel()
  }, [side, setRailPinned, toggleRightPanel])

  const reviewMode = side === 'panel' && review
  const [reviewWidth, setReviewWidth] = useState(() => {
    const width = Number(window.localStorage.getItem(REVIEW_WIDTH_KEY))
    return Number.isFinite(width) && width >= PANEL_MIN && width <= 900 ? width : 0
  })
  const stored = reviewMode ? reviewWidth : (side === 'rail' ? settings?.railWidth : settings?.panelWidth) ?? 0
  const [dragging, setDragging] = useState<number | null>(null)
  const startRef = useRef<{ x: number; base: number } | null>(null)

  const COLLAPSE_AT = 100

  const [willCollapse, setWillCollapse] = useState(false)

  const cssVar = side === 'rail' ? '--w-rail-user' : reviewMode ? '--w-review-user' : '--w-panel-user'
  const [min, max] = side === 'rail' ? [RAIL_MIN, RAIL_MAX] : [PANEL_MIN, reviewMode ? 900 : PANEL_MAX]
  const saveWidth = (width: number): void => {
    if (reviewMode) {
      if (width > 0) window.localStorage.setItem(REVIEW_WIDTH_KEY, String(width))
      else window.localStorage.removeItem(REVIEW_WIDTH_KEY)
      setReviewWidth(width)
    } else {
      void setPanelWidth(side === 'rail' ? { railWidth: width } : { panelWidth: width })
    }
  }
  const clamp = useCallback((w: number): number => {
    const other = document.querySelector(side === 'rail' ? '.rightpanel' : '.rail')?.getBoundingClientRect().width ?? 0
    const available = Math.max(min, window.innerWidth - other - 360)
    return Math.round(Math.min(max, available, Math.max(min, w)))
  }, [min, max, side])
  const readCurrent = useCallback((): number => {
    const el = document.documentElement
    const v = getComputedStyle(el).getPropertyValue(cssVar).trim()
    const n = parseFloat(v)
    if (Number.isFinite(n) && n > 0) return n
    const sel = side === 'rail' ? '.rail' : '.rightpanel'
    const box = document.querySelector(sel)?.getBoundingClientRect().width
    return box && box > 0 ? Math.round(box) : side === 'rail' ? 300 : 264
  }, [cssVar, side])

  const apply = useCallback(
    (w: number) => {
      document.documentElement.style.setProperty(cssVar, `${w}px`)
    },
    [cssVar]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const base = readCurrent()
    startRef.current = { x: e.clientX, base }
    setDragging(base)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
    }
    document.body.classList.add('resizing')
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = startRef.current
    if (!st) return
    const dx = e.clientX - st.x
    const raw = side === 'rail' ? st.base + dx : st.base - dx
    if (raw < COLLAPSE_AT) {
      setWillCollapse(true)
      setDragging(min)
      apply(min)
      return
    }
    setWillCollapse(false)
    const next = clamp(raw)
    setDragging(next)
    apply(next)
  }

  const cancel = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = startRef.current
    if (!start) return
    startRef.current = null
    setWillCollapse(false)
    setDragging(null)
    document.body.classList.remove('resizing')
    apply(start.base)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
  }

  const finish = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = startRef.current
    if (!st) return
    startRef.current = null
    const collapseNow = willCollapse
    setWillCollapse(false)
    setDragging(null)
    document.body.classList.remove('resizing')
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
    }
    if (collapseNow) {
      document.documentElement.style.removeProperty(cssVar)
      void toggleCollapse()
      return
    }
    const final = readCurrent()
    saveWidth(final)
  }

  const reset = (): void => {
    document.documentElement.style.removeProperty(cssVar)
    saveWidth(0)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 24 : 8
    const widen = side === 'rail' ? 'ArrowRight' : 'ArrowLeft'
    const narrow = side === 'rail' ? 'ArrowLeft' : 'ArrowRight'
    if (e.key !== widen && e.key !== narrow && e.key !== 'Home') return
    e.preventDefault()
    if (e.key === 'Home') {
      reset()
      return
    }
    const cur = readCurrent()
    const next = clamp(e.key === widen ? cur + step : cur - step)
    apply(next)
    saveWidth(next)
  }

  useEffect(() => () => {
    if (startRef.current) {
      document.body.classList.remove('resizing')
      document.documentElement.style.setProperty(cssVar, `${startRef.current.base}px`)
    }
  }, [cssVar])

  useEffect(() => {
    if (dragging !== null) return
    if (stored > 0) document.documentElement.style.setProperty(cssVar, `${stored}px`)
    else document.documentElement.style.removeProperty(cssVar)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, cssVar])

  return (
    <div
      className={`resizer resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      title={t('rp.resizeHint')}
      aria-label={t('rp.resizeHint')}
      data-testid={`resizer-${side}`}
      data-dragging={dragging !== null ? '1' : '0'}
      data-will-collapse={willCollapse ? '1' : '0'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  )
}
