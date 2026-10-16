import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { TOOL_SECTIONS, type ToolSectionId } from '../../../../shared/ipc'
import { SECTION_TITLE } from './ToolSection'
import { SECTION_REGISTRY, resolveToolDrop } from './RightPanel'
import {
  avoidFloatObstacle,
  clampFloatPixels,
  defaultToolLayout,
  pxRectToNormalized,
  setTileCollapsed,
  setTilePlacement,
  snapFloatRect,
  TILE_HEAD_H,
  TILE_MIN_W,
  type FloatArea,
  type FloatPxRect,
  type SnapGuide,
  type ToolLayout,
  type ToolTile
} from '../../../../shared/tool-layout'
import { IconButton } from '../ui'
import { hasVisibleSubagents } from '../../state/subagent-view'

const DRAG_THRESHOLD = 6
function workspaceArea(): FloatArea | null {
  const el = document.querySelector('.workspace')
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function browserArea(): FloatArea | null {
  if (!useStore.getState().browserState.open) return null
  const el = document.querySelector('.rightpanel')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
}

function tilePxRect(tile: ToolTile, area: FloatArea): FloatPxRect {
  const rect = tile.rect ?? { x: 0.06, y: 0.1, w: 0.3, h: 0.4 }
  const width = Math.min(area.width, Math.max(TILE_MIN_W, rect.w * area.width))
  const height = Math.min(area.height, Math.max(TILE_HEAD_H, rect.h * area.height))
  return clampFloatPixels(
    { left: area.left + rect.x * area.width, top: area.top + rect.y * area.height, width, height },
    area
  )
}

interface DragState {
  id: string
  offsetX: number
  offsetY: number
  startX: number
  startY: number
  origin: FloatPxRect
  moved: boolean
}

interface ResizeState {
  id: string
  startX: number
  startY: number
  origin: FloatPxRect
}

export function FloatingTiles() {
  const stored = useStore((s) => s.settings?.toolLayout)
  const setToolLayout = useStore((s) => s.setToolLayout)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const setToolDropTarget = useStore((s) => s.setToolDropTarget)
  const sessionKey = useStore(
    (s) => s.session?.conversationFile ?? s.session?.sessionFile ?? s.session?.conversationId ?? s.session?.sessionId ?? ''
  )
  const layout = useMemo<ToolLayout>(() => stored ?? defaultToolLayout(TOOL_SECTIONS), [stored])
  const tiles = useMemo(
    () => layout.tiles.filter((tile) => tile.placement === 'floating').sort((a, b) => a.order - b.order),
    [layout]
  )
  const todos = useStore((s) => s.todos)
  const goal = useStore((s) => s.goal)
  const hasMessageOutputs = useStore((s) => s.messages.some((message) =>
    !!message.artifacts?.length || (message.role === 'user' && !!message.images?.length)
  ))
  const hasSubagents = useStore(hasVisibleSubagents)
  const logs = useStore((s) => s.logs)
  const statuses = useStore((s) => s.statuses)
  const widgets = useStore((s) => s.widgets)

  const [area, setArea] = useState<FloatArea | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [resize, setResize] = useState<ResizeState | null>(null)
  const [ghost, setGhost] = useState<FloatPxRect | null>(null)
  const [notice, setNotice] = useState('')
  const restoreRects = useRef<Record<string, FloatPxRect>>({})
  const releaseRef = useRef<(() => void) | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const t = useT()

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  useEffect(() => {
    const measure = (): void => setArea(workspaceArea())
    measure()
    const host = document.querySelector('.workspace')
    const ro = host ? new ResizeObserver(measure) : null
    if (host && ro) ro.observe(host)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  const [guides, setGuides] = useState<SnapGuide[]>([])

  const otherTileRects = useCallback(
    (selfId: string): FloatPxRect[] =>
      area ? tiles.filter((t) => t.id !== selfId).map((t) => tilePxRect(t, area)) : [],
    [area, tiles]
  )

  const cancelGesture = useCallback(() => {
    document.body.classList.remove('tile-dragging')
    setDrag(null)
    setResize(null)
    setGhost(null)
    setGuides([])
    useStore.getState().setToolDropTarget(null)
  }, [])

  useEffect(() => {
    cancelGesture()
  }, [sessionKey, cancelGesture])

  useEffect(() => {
    if (!drag && !resize) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelGesture()
      }
    }
    const onBlur = (): void => cancelGesture()
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [drag, resize, cancelGesture])

  useEffect(() => {
    if (!drag && !resize) return undefined
    releaseRef.current = acquireOverlayBlocker('tile-drag')
    return () => {
      releaseRef.current?.()
      releaseRef.current = null
    }
  }, [drag, resize, acquireOverlayBlocker])

  const commitDrag = useCallback(
    (state: Pick<DragState, 'id'>, rect: FloatPxRect, snap = true) => {
      if (!area) return
      const snapped = snap ? snapFloatRect(rect, area, otherTileRects(state.id)).rect : rect
      const wanted = clampFloatPixels(snapped, area)
      const safe = avoidFloatObstacle(wanted, area, browserArea())
      if (!safe) {
        setNotice(t('tl.noRoom'))
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        noticeTimer.current = window.setTimeout(() => {
          noticeTimer.current = null
          setNotice('')
        }, 3200)
        void setToolLayout(setTilePlacement(layout, state.id, 'docked'))
        return
      }
      void setToolLayout(setTilePlacement(layout, state.id, 'floating', pxRectToNormalized(safe, area)))
    },
    [area, layout, otherTileRects, setToolLayout, t]
  )

  if (tiles.length === 0 && !notice) return null

  return (
    <div className="rp-float-layer" data-testid="float-layer">
      {guides.map((guide) => (
        <div
          key={`${guide.axis}-${guide.at}-${guide.kind}`}
          className="rp-snap-guide"
          data-axis={guide.axis}
          data-kind={guide.kind}
          data-testid="float-snap-guide"
          style={guide.axis === 'x' ? { left: guide.at } : { top: guide.at }}
        />
      ))}
      {notice ? (
        <div className="rp-float-notice" role="status" data-testid="float-notice">
          {notice}
        </div>
      ) : null}
      {area
        ? tiles.map((tile) => {
            const id = tile.id as ToolSectionId
            const rect = ((drag?.id === tile.id || resize?.id === tile.id) && ghost) ? ghost : tilePxRect(tile, area)
            const name = t(SECTION_TITLE[id])
            const Body = SECTION_REGISTRY[id].Body
            const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
              if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
              e.preventDefault()
              e.stopPropagation()
              const start: DragState = {
                id: tile.id,
                offsetX: e.clientX - rect.left,
                offsetY: e.clientY - rect.top,
                startX: e.clientX,
                startY: e.clientY,
                origin: rect,
                moved: false
              }
              setDrag(start)
              setGhost(rect)
              try {
                ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
              } catch {
              }
            }
            const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
              if (!drag || drag.id !== tile.id) return
              const dx = e.clientX - drag.startX
              const dy = e.clientY - drag.startY
              if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
              if (!drag.moved) {
                setDrag({ ...drag, moved: true })
                document.body.classList.add('tile-dragging')
              }
              const { rect: snapped, guides: nextGuides } = area
                ? snapFloatRect(
                    { ...drag.origin, left: drag.origin.left + dx, top: drag.origin.top + dy },
                    area,
                    otherTileRects(tile.id)
                  )
                : { rect: { ...drag.origin, left: drag.origin.left + dx, top: drag.origin.top + dy }, guides: [] }
              setGuides(nextGuides)
              setGhost(clampFloatPixels(snapped, area))
              const panel = document.querySelector('.rightpanel')?.getBoundingClientRect()
              const overPanel =
                !!panel && e.clientX >= panel.left && e.clientX <= panel.right &&
                e.clientY >= panel.top && e.clientY <= panel.bottom
              setToolDropTarget(overPanel ? resolveToolDrop(e.clientY, tile.id) : null)
            }
            const onUp = (e: React.PointerEvent<HTMLDivElement>): void => {
              if (!drag || drag.id !== tile.id) return
              document.body.classList.remove('tile-dragging')
              try {
                ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
              } catch {
              }
              const moved = drag.moved
              const finalRect = ghost ?? rect
              const dock = document.querySelector('.rightpanel')?.getBoundingClientRect()
              const droppedInRightPanel = !!dock && e.clientX >= dock.left && e.clientX <= dock.right &&
                e.clientY >= dock.top && e.clientY <= dock.bottom
              cancelGesture()
              if (moved) delete restoreRects.current[tile.id]
              if (moved && droppedInRightPanel) {
                void setToolLayout(setTilePlacement(layout, tile.id, 'docked'))
              } else if (moved) commitDrag(drag, finalRect)
            }
            const onResizeDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
              if (e.button !== 0 || tile.collapsed) return
              e.preventDefault()
              e.stopPropagation()
              setResize({ id: tile.id, startX: e.clientX, startY: e.clientY, origin: rect })
              setGhost(rect)
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
              }
            }
            const onResizeMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
              if (!resize || resize.id !== tile.id || !area) return
              const right = area.left + area.width - resize.origin.left
              const bottom = area.top + area.height - resize.origin.top
              const minWidth = Math.min(TILE_MIN_W, right)
              const maxWidth = right
              const minHeight = Math.min(TILE_HEAD_H, bottom)
              const maxHeight = bottom
              setGhost({
                ...resize.origin,
                width: Math.max(minWidth, Math.min(maxWidth, resize.origin.width + e.clientX - resize.startX)),
                height: Math.max(minHeight, Math.min(maxHeight, resize.origin.height + e.clientY - resize.startY))
              })
            }
            const onResizeUp = (e: React.PointerEvent<HTMLButtonElement>): void => {
              if (!resize || resize.id !== tile.id) return
              try {
                e.currentTarget.releasePointerCapture(e.pointerId)
              } catch {
              }
              const finalRect = ghost ?? rect
              const resizedId = resize.id
              cancelGesture()
              delete restoreRects.current[resizedId]
              commitDrag({ id: resizedId }, finalRect, false)
            }
            return (
              <section
                key={tile.id}
                className={`rp-float-tile ${drag?.id === tile.id && drag.moved ? 'dragging' : ''} ${resize?.id === tile.id ? 'resizing' : ''} ${tile.collapsed ? 'collapsed' : ''}`}
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: tile.collapsed ? TILE_HEAD_H : rect.height
                }}
                data-float-id={tile.id}
                data-testid={`float-tile-${tile.id}`}
              >
                <header
                  className="rp-float-head"
                  data-testid={`float-head-${tile.id}`}
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={() => {
                    document.body.classList.remove('tile-dragging')
                    cancelGesture()
                  }}
                >
                  <span className="rp-float-title" title={name}>
                    {name}
                  </span>
                  <span className="spacer" />
                  <IconButton icon="maximize" label={t('tile.toggleMax')} size="sm" type="button" data-testid={`float-maximize-${tile.id}`} onClick={() => {
                      if (!area) return
                      const previous = restoreRects.current[tile.id]
                      if (previous) {
                        delete restoreRects.current[tile.id]
                        commitDrag({ id: tile.id }, previous)
                      } else {
                        restoreRects.current[tile.id] = rect
                        const obstacle = browserArea()
                        const width = obstacle ? Math.max(TILE_MIN_W, obstacle.left - area.left) : area.width
                        commitDrag({ id: tile.id }, { left: area.left, top: area.top, width, height: area.height })
                      }
                    }} />
                  <IconButton
                    icon="chevron-right"
                    size="sm"
                    iconClassName={`chev ${tile.collapsed ? '' : 'on'}`}
                    label={tile.collapsed ? t('tl.expand') : t('tl.collapse')}
                    aria-expanded={!tile.collapsed}
                    data-testid={`float-fold-${tile.id}`}
                    onClick={() => void setToolLayout(setTileCollapsed(layout, tile.id, !tile.collapsed))}
                  />
                  <IconButton icon="dock" label={t('tl.dockBack')} size="sm" data-testid={`float-dock-${tile.id}`} onClick={() => void setToolLayout(setTilePlacement(layout, tile.id, 'docked'))} />
                </header>
                {tile.collapsed ? null : (
                  <>
                    <div
                      className="rp-float-body"
                      style={{ maxHeight: Math.max(0, rect.height - TILE_HEAD_H) }}
                    >
                      {(SECTION_REGISTRY[id].isEmpty
                        ? SECTION_REGISTRY[id].isEmpty!({ todos, goal, hasMessageOutputs, hasSubagents, logs, statuses, widgets })
                        : false) ? (
                        <div className="rp-float-empty">{t('tl.empty')}</div>
                      ) : (
                        <Body />
                      )}
                    </div>
                    <button
                      type="button"
                      className="rp-float-resize"
                      aria-label={t('tile.resizeLabel', { name })}
                      title={t('tile.resizeHint')}
                      data-testid={`float-resize-${tile.id}`}
                      onPointerDown={onResizeDown}
                      onPointerMove={onResizeMove}
                      onPointerUp={onResizeUp}
                      onPointerCancel={cancelGesture}
                    />
                  </>
                )}
              </section>
            )
          })
        : null}
    </div>
  )
}
