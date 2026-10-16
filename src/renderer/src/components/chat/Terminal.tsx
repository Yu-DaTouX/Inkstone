import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { ToolDetail } from './MessageParts'
import type { UIToolCall } from '../../../../shared/ipc'

const SIZE_KEY = 'yan.termSize'
const MIN_H = 56
function defaultHeight(): number {
  return Math.max(MIN_H, Math.round(window.innerHeight * 0.5))
}

function loadSize(): { h: number; w: number } {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (raw) {
      const o = JSON.parse(raw) as { h?: unknown; w?: unknown }
      const h = Number(o.h)
      const w = Number(o.w)
      if (Number.isFinite(h) && Number.isFinite(w) && h > 0 && w >= 0) {
        return { h: Math.min(1200, Math.max(MIN_H, Math.round(h))), w: Math.round(w) }
      }
    }
  } catch {
  }
  return { h: defaultHeight(), w: 0 }
}

function saveSize(size: { h: number; w: number }): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(size))
  } catch {
  }
}

function maxHeight(): number {
  return Math.max(200, Math.round(window.innerHeight * 0.8))
}

export function TerminalWindow({
  call,
  target,
  secs,
  fitContent = false
}: {
  call: UIToolCall
  target: string
  secs: number | null
  fitContent?: boolean
}) {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState(loadSize)
  const sizeRef = useRef(size)
  const dragCleanup = useRef<(() => void) | null>(null)
  const [maxed, setMaxed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [drag, setDrag] = useState<'h' | 'w' | 'both' | null>(null)

  const running = call.status === 'running' || call.status === 'pending'

  const output = call.output ?? ''

  const clampH = useCallback((h: number): number => Math.min(maxHeight(), Math.max(MIN_H, Math.round(h))), [])
  const clampW = useCallback((w: number, maxW: number): number => {
    if (w <= 0) return 0
    return Math.min(maxW, Math.max(320, Math.round(w)))
  }, [])

  const setSizeBoth = useCallback((next: { h: number; w: number }): void => {
    sizeRef.current = next
    setSize(next)
  }, [])

  const beginDrag = (kind: 'h' | 'w' | 'both') => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = rootRef.current
    if (!el) return
    const maxW = el.parentElement?.clientWidth ?? el.offsetWidth
    const st = {
      kind,
      x: e.clientX,
      y: e.clientY,
      h: el.offsetHeight,
      w: el.offsetWidth,
      maxW
    }
    setMaxed(false)
    setDrag(kind)
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
    }
    document.body.classList.add('resizing-term')

    const onMove = (ev: PointerEvent): void => {
      const dy = ev.clientY - st.y
      const dx = ev.clientX - st.x
      let h = st.h
      let w = st.w
      if (st.kind === 'h' || st.kind === 'both') h = clampH(st.h + dy)
      if (st.kind === 'w' || st.kind === 'both') {
        const want = clampW(st.w + dx, st.maxW)
        w = want >= st.maxW ? 0 : want
      }
      setSizeBoth({ h, w })
    }
    const finish = (): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      dragCleanup.current = null
      document.body.classList.remove('resizing-term')
      setDrag(null)
      saveSize(sizeRef.current)
    }
    dragCleanup.current = finish
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
  }

  useEffect(() => () => dragCleanup.current?.(), [])

  const onKeyDown = (kind: 'h' | 'w' | 'both') => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 96 : 24
    let handled = true
    const maxW = rootRef.current?.parentElement?.clientWidth ?? 9999
    let { h, w } = sizeRef.current
    if ((kind === 'h' || kind === 'both') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      h = clampH(h + (e.key === 'ArrowDown' ? step : -step))
    } else if ((kind === 'w' || kind === 'both') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const base = w || rootRef.current?.offsetWidth || 480
      w = clampW(base + (e.key === 'ArrowRight' ? step : -step), maxW)
    } else if (e.key === 'Home') {
      h = defaultHeight()
      w = 0
    } else {
      handled = false
    }
    if (handled) {
      e.preventDefault()
      setMaxed(false)
      const next = { h, w: w === maxW ? 0 : w }
      setSizeBoth(next)
      saveSize(next)
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(output || target)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
    }
  }

  const toggleMax = (): void => setMaxed((v) => !v)

  const style: React.CSSProperties = maxed
    ? { height: `min(${maxHeight()}px, 72vh)`, width: '100%' }
    : {
        height: `${Math.max(MIN_H, size.h)}px`,
        width: size.w > 0 ? `${size.w}px` : '100%'
      }

  return (
    <div
      className={`term ${running ? 'running' : ''} ${maxed ? 'max' : ''} ${drag ? 'dragging' : ''}`}
      ref={rootRef}
      style={fitContent ? undefined : style}
      data-testid="tool-terminal"
    >
      <div className="term-bar">
        <span className={`term-ico ${running ? 'live' : ''}`} aria-hidden>
          <Icon name="terminal" size={12} />
        </span>
        <span className="term-title" title={target || call.name}>
          {call.name}
        </span>
        <span className="spacer" />
        {secs !== null ? <span className="term-time">{secs}s</span> : null}
        <button
          className={`term-act ${copied ? 'on' : ''}`}
          onClick={() => void copy()}
          title={t('term.copy')}
          data-testid="term-copy"
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
        </button>
        <button
          className="term-act"
          onClick={toggleMax}
          title={maxed ? t('term.restore') : t('term.expand')}
          data-testid="term-max"
        >
          <Icon name={maxed ? 'sidebar-left' : 'sidebar-right'} size={12} />
        </button>
      </div>

      <div className="term-body">
        <div className="term-prompt">
          <span className="term-prompt-sign" aria-hidden>{call.name === 'bash' ? '$' : '>'}</span>
          <span className="term-prompt-text">{target || call.name}</span>
        </div>
        <div className="term-out">
          <ToolDetail call={call} />
          {running ? <span className="term-caret" aria-hidden /> : null}
        </div>
      </div>

      <div
        className="term-grip term-grip-s"
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        title={t('term.resize')}
        aria-label={t('term.resize')}
        onPointerDown={beginDrag('h')}
        onKeyDown={onKeyDown('h')}
        onDoubleClick={() => {
          setMaxed(false)
          const n = { h: defaultHeight(), w: sizeRef.current.w }
          setSizeBoth(n)
          saveSize(n)
        }}
      />
      <div
        className="term-grip term-grip-e"
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        title={t('term.resizeW')}
        aria-label={t('term.resizeW')}
        onPointerDown={beginDrag('w')}
        onKeyDown={onKeyDown('w')}
        onDoubleClick={() => {
          setMaxed(false)
          const n = { h: sizeRef.current.h, w: 0 }
          setSizeBoth(n)
          saveSize(n)
        }}
      />
      <div
        className="term-grip term-grip-se"
        role="separator"
        tabIndex={0}
        title={t('term.resize')}
        aria-label={t('term.resize')}
        onPointerDown={beginDrag('both')}
        onKeyDown={onKeyDown('both')}
        onDoubleClick={() => {
          setMaxed(false)
          const n = { h: defaultHeight(), w: 0 }
          setSizeBoth(n)
          saveSize(n)
        }}
      />
    </div>
  )
}
