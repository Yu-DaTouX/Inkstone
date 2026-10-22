import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { ArrowUpRight, Circle, Pencil, Redo2, SendHorizontal, Square, Trash2, Type, Undo2 } from 'lucide-react'
import { Button, IconButton, Notice } from '../../../ui'
import { DockToggle } from './dock'
import { DRAW_PALETTE, DRAW_PENS, type DrawPen } from './draw-model'
import {
  clearDrawFrame,
  drawFrameState,
  drawHistory,
  drawSnapshot,
  redoDraw,
  setDrawActive,
  setDrawColor,
  setDrawPen,
  setDrawSpace,
  subscribeDraw,
  syncDrawFile,
  undoDraw
} from './draw-store'
import { drawColors } from './draw-overlay'
import { drawText } from './draw-text'
import { sendDrawings } from './draw-send'
import type { CanvasToolPanelProps } from './types'
import './draw.css'

const EDITABLE_TARGET = 'input, textarea, select, [role="textbox"], [contenteditable="true"]'

const PEN_ICONS: Record<DrawPen, typeof Pencil> = {
  free: Pencil,
  rect: Square,
  ellipse: Circle,
  arrow: ArrowUpRight,
  text: Type
}

function deviceName(labels: CanvasToolPanelProps['context']['labels'], id: string): string {
  if (id === 'desktop') return labels.canvasDeviceDesktop
  if (id === 'laptop') return labels.canvasDeviceLaptop
  if (id === 'tablet') return labels.canvasDeviceTablet
  if (id === 'phone') return labels.canvasDevicePhone
  return labels.canvasDeviceCustom
}

export function DrawPanel({ context }: CanvasToolPanelProps): ReactElement {
  const state = useSyncExternalStore(subscribeDraw, drawSnapshot)
  const text = drawText(context.labels.lang)
  const colors = drawColors()
  const panelRef = useRef<HTMLElement | null>(null)
  const spaceRef = useRef(false)
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'fail'; message: string } | null>(null)
  const abs = context.abs
  const frameIds: string[] = context.frames.map((frame) => frame.viewport.id)
  const activeId =
    state.abs === abs && state.active && frameIds.includes(state.active) ? state.active : frameIds[0] ?? ''
  const counts = context.frames.map((frame) => ({
    frame,
    count: state.abs === abs ? drawFrameState(abs, frame.viewport.id).shapes.length : 0
  }))
  const total = counts.reduce((sum, entry) => sum + entry.count, 0)
  const activeCount = counts.find((entry) => entry.frame.viewport.id === activeId)?.count ?? 0
  const history = state.abs === abs && activeId ? drawHistory(abs, activeId) : { undo: 0, redo: 0 }

  useEffect(() => {
    syncDrawFile(abs)
  }, [abs])

  useEffect(() => {
    setStatus(null)
  }, [abs])

  useEffect(() => {
    const stage = panelRef.current?.parentElement ?? null
    const panTo = (dx: number, dy: number): void => {
      if (!stage || (!dx && !dy)) return
      stage.dispatchEvent(new WheelEvent('wheel', { deltaX: -dx, deltaY: -dy, bubbles: false, cancelable: true }))
    }
    const inCanvas = (target: HTMLElement | null): boolean => {
      if (!target || target === document.body) return true
      return !!stage && stage.contains(target)
    }
    const hold = (value: boolean): void => {
      spaceRef.current = value
      if (!value) panRef.current = null
      setDrawSpace(value)
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!spaceRef.current || event.button !== 0) return
      const target = event.target as HTMLElement | null
      if (!stage || !target || !stage.contains(target)) return
      if (panelRef.current?.contains(target) || target.closest('[data-canvas-interactive]')) return
      panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
      event.preventDefault()
      event.stopPropagation()
      try {
        stage.setPointerCapture(event.pointerId)
      } catch {
        panRef.current = null
      }
    }
    const onPointerMove = (event: PointerEvent): void => {
      const pan = panRef.current
      if (!pan || pan.pointerId !== event.pointerId) return
      const dx = event.clientX - pan.x
      const dy = event.clientY - pan.y
      if (!dx && !dy) return
      panRef.current = { ...pan, x: event.clientX, y: event.clientY }
      panTo(dx, dy)
    }
    const endPan = (event: PointerEvent): void => {
      if (panRef.current?.pointerId !== event.pointerId) return
      panRef.current = null
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editable = !!target && (target.isContentEditable || !!target.closest(EDITABLE_TARGET))
      if (event.key === ' ') {
        if (editable || !inCanvas(target) || (target && target.closest('button, [role="button"]'))) return
        event.preventDefault()
        hold(true)
        return
      }
      const mod = event.ctrlKey || event.metaKey
      if (!mod || editable || !inCanvas(target)) return
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoDraw(abs, activeId)
        else undoDraw(abs, activeId)
        return
      }
      if (key === 'y') {
        event.preventDefault()
        redoDraw(abs, activeId)
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === ' ') hold(false)
    }
    const onBlur = (): void => hold(false)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', endPan, true)
    window.addEventListener('pointercancel', endPan, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerup', endPan, true)
      window.removeEventListener('pointercancel', endPan, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      spaceRef.current = false
      panRef.current = null
      setDrawSpace(false)
    }
  }, [abs, activeId])

  const send = (): void => {
    if (busy || !total) return
    setBusy(true)
    setStatus(null)
    const stage = panelRef.current?.parentElement ?? null
    void sendDrawings(context, stage, frameIds).then(
      (outcome) => {
        setBusy(false)
        if (outcome.ok) {
          setStatus({ tone: 'ok', message: text.sent })
          return
        }
        if (outcome.reason === 'chat') setStatus({ tone: 'fail', message: text.sendBlocked })
        else if (outcome.reason === 'empty') setStatus({ tone: 'fail', message: text.sendEmpty })
        else setStatus({ tone: 'fail', message: text.sendFailed })
      },
      () => {
        setBusy(false)
        setStatus({ tone: 'fail', message: text.sendFailed })
      }
    )
  }

  if (context.narrow && context.dockCollapsed) {
    return (
      <aside
        ref={panelRef}
        className="v3-canvas-panel v3-canvas-draw-panel v3-canvas-dock-bar"
        data-canvas-interactive
        aria-label={text.title}
        data-hidden={state.captureHidden || undefined}
        data-testid="v3-canvas-draw-panel"
      >
        <div className="v3-canvas-dock-row">
          <div className="v3-canvas-dock-group" role="group" aria-label={text.penLabel}>
            {DRAW_PENS.map((pen) => {
              const Icon = PEN_ICONS[pen]
              const active = state.pen === pen
              return (
                <IconButton
                  key={pen}
                  size="sm"
                  variant={active ? 'secondary' : 'ghost'}
                  aria-label={text.pens[pen]}
                  title={text.pens[pen]}
                  aria-pressed={active}
                  data-testid={`v3-canvas-draw-pen-${pen}`}
                  onPress={() => setDrawPen(pen)}
                >
                  <Icon size={14} />
                </IconButton>
              )
            })}
          </div>
          <span className="v3-canvas-dock-sep" aria-hidden />
          <div className="v3-canvas-dock-group" role="group" aria-label={text.colorLabel}>
            {DRAW_PALETTE.map((spec) => {
              const active = state.color === spec.key
              return (
                <IconButton
                  key={spec.key}
                  size="sm"
                  variant={active ? 'secondary' : 'ghost'}
                  className="v3-canvas-draw-swatch"
                  aria-label={text.colors[spec.key] ?? spec.key}
                  title={text.colors[spec.key] ?? spec.key}
                  aria-pressed={active}
                  data-testid={`v3-canvas-draw-color-${spec.key}`}
                  onPress={() => setDrawColor(spec.key)}
                >
                  <span className="v3-canvas-draw-dot" style={{ background: colors[spec.key] ?? spec.fallback }} aria-hidden />
                </IconButton>
              )
            })}
          </div>
          <span className="v3-canvas-dock-sep" aria-hidden />
          <IconButton
            size="sm"
            aria-label={text.undo}
            title={`${text.undo} (Ctrl/Cmd+Z)`}
            isDisabled={!history.undo}
            data-testid="v3-canvas-draw-undo"
            onPress={() => undoDraw(abs, activeId)}
          >
            <Undo2 size={14} />
          </IconButton>
          <Button
            size="sm"
            variant="primary"
            icon={<SendHorizontal size={13} />}
            isDisabled={busy || total === 0}
            aria-label={text.send}
            data-testid="v3-canvas-draw-send"
            onPress={send}
          >
            {busy ? text.sending : text.send}
          </Button>
          {status ? (
            <span className="v3-canvas-dock-hint" role="status">
              {status.message}
            </span>
          ) : null}
        </div>
        <DockToggle labels={context.labels} expanded={false} onToggle={context.toggleDock} />
      </aside>
    )
  }

  return (
    <aside
      ref={panelRef}
      className="v3-canvas-panel v3-canvas-draw-panel"
      data-canvas-interactive
      aria-label={text.title}
      data-hidden={state.captureHidden || undefined}
      data-testid="v3-canvas-draw-panel"
    >
      <div className="v3-canvas-panel-head">
        <span className="v3-canvas-panel-title">{text.title}</span>
        {context.narrow ? <DockToggle labels={context.labels} expanded onToggle={context.toggleDock} /> : null}
      </div>
      <div className="v3-canvas-panel-body v3-canvas-draw-body">
        <div className="v3-canvas-draw-group">
          <span className="v3-canvas-draw-caption">{text.penLabel}</span>
          <div className="v3-canvas-draw-row" role="group" aria-label={text.penLabel}>
            {DRAW_PENS.map((pen) => {
              const Icon = PEN_ICONS[pen]
              const active = state.pen === pen
              return (
                <IconButton
                  key={pen}
                  size="sm"
                  variant={active ? 'secondary' : 'ghost'}
                  aria-label={text.pens[pen]}
                  title={text.pens[pen]}
                  aria-pressed={active}
                  data-testid={`v3-canvas-draw-pen-${pen}`}
                  onPress={() => setDrawPen(pen)}
                >
                  <Icon size={14} />
                </IconButton>
              )
            })}
          </div>
        </div>
        <div className="v3-canvas-draw-group">
          <span className="v3-canvas-draw-caption">{text.colorLabel}</span>
          <div className="v3-canvas-draw-row" role="group" aria-label={text.colorLabel}>
            {DRAW_PALETTE.map((spec) => {
              const active = state.color === spec.key
              return (
                <IconButton
                  key={spec.key}
                  size="sm"
                  variant={active ? 'secondary' : 'ghost'}
                  className="v3-canvas-draw-swatch"
                  aria-label={text.colors[spec.key] ?? spec.key}
                  title={text.colors[spec.key] ?? spec.key}
                  aria-pressed={active}
                  data-testid={`v3-canvas-draw-color-${spec.key}`}
                  onPress={() => setDrawColor(spec.key)}
                >
                  <span
                    className="v3-canvas-draw-dot"
                    style={{ background: colors[spec.key] ?? spec.fallback }}
                    aria-hidden
                  />
                </IconButton>
              )
            })}
          </div>
        </div>
        <div className="v3-canvas-draw-row">
          <IconButton
            size="sm"
            aria-label={text.undo}
            title={`${text.undo} (Ctrl/Cmd+Z)`}
            isDisabled={!history.undo}
            data-testid="v3-canvas-draw-undo"
            onPress={() => undoDraw(abs, activeId)}
          >
            <Undo2 size={14} />
          </IconButton>
          <IconButton
            size="sm"
            aria-label={text.redo}
            title={`${text.redo} (Ctrl/Cmd+Shift+Z)`}
            isDisabled={!history.redo}
            data-testid="v3-canvas-draw-redo"
            onPress={() => redoDraw(abs, activeId)}
          >
            <Redo2 size={14} />
          </IconButton>
          <IconButton
            size="sm"
            aria-label={text.clear}
            title={text.clear}
            isDisabled={!activeCount}
            data-testid="v3-canvas-draw-clear"
            onPress={() => clearDrawFrame(abs, activeId)}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
        <div className="v3-canvas-draw-group">
          <span className="v3-canvas-draw-caption">{text.framesLabel}</span>
          <div className="v3-canvas-draw-frames" role="group" aria-label={text.framesLabel}>
            {counts.map(({ frame, count }) => {
              const active = frame.viewport.id === activeId
              return (
                <Button
                  key={frame.viewport.id}
                  size="sm"
                  variant={active ? 'secondary' : 'ghost'}
                  aria-pressed={active}
                  data-testid={`v3-canvas-draw-frame-${frame.viewport.id}`}
                  onPress={() => setDrawActive(abs, frame.viewport.id)}
                >
                  {deviceName(context.labels, frame.viewport.id)} · {count}
                </Button>
              )
            })}
          </div>
        </div>
        <Button
          size="sm"
          variant="primary"
          block
          icon={<SendHorizontal size={13} />}
          isDisabled={busy || total === 0}
          aria-label={text.send}
          data-testid="v3-canvas-draw-send"
          onPress={send}
        >
          {busy ? text.sending : text.send}
        </Button>
        {status ? (
          <Notice tone={status.tone} compact>
            {status.message}
          </Notice>
        ) : null}
        {total === 0 ? <p className="v3-canvas-draw-hint">{text.empty}</p> : null}
        <p className="v3-canvas-draw-hint">{text.hint}</p>
      </div>
    </aside>
  )
}
