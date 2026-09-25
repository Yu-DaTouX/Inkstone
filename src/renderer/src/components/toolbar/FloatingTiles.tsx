import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
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
  TILE_HEAD_H,
  TILE_MIN_W,
  type FloatArea,
  type FloatPxRect,
  type ToolLayout,
  type ToolTile
} from '../../../../shared/tool-layout'

/** 进入拖动的最小位移（设计 §5.2：≥6 CSS px；正文选字/点击不触发拖动） */
const DRAG_THRESHOLD = 6
/** 应用内容区（浮动磁贴的可用范围 = .workspace 的矩形） */
function workspaceArea(): FloatArea | null {
  const el = document.querySelector('.workspace')
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/**
 * 原生网页的占位矩形（设计 §5.4）。
 *
 * 浏览器是 WebContentsView，不在 DOM 里；右栏可见且浏览器打开时，
 * 它占据右栏矩形。浮动磁贴的落点要避开它，否则一放下就被原生层盖住。
 */
function browserArea(): FloatArea | null {
  if (!useStore.getState().browserState.open) return null
  const el = document.querySelector('.rightpanel')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
}

/** 归一化 rect → 当前像素矩形（含尺寸夹取，窗口变化后仍可见） */
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
  /** 指针按下时相对磁贴左上角的偏移 */
  offsetX: number
  offsetY: number
  startX: number
  startY: number
  /** 原始 rect（Esc / 取消时还原） */
  origin: FloatPxRect
  moved: boolean
}

interface ResizeState {
  id: string
  startX: number
  startY: number
  origin: FloatPxRect
}

/**
 * 应用内容区上的浮动工具磁贴层（实施-12 U-4 / U-5）。
 *
 * 一个磁贴 ID 只有一个主实例：这里渲染的必须是 `floating` 放置的项，
 * 工具页只留占位（见 RightPanel 的 FloatPlaceholder）。内容仍绑定当前会话 ——
 * 本组件只读布局，不缓存任何业务数据。
 *
 * 拖动遵循设计 §5.2 的状态机：按下 → 移动 ≥6px 才进入 dragging →
 * 放开 commit（一次性写盘）/ Esc·失焦·切会话 cancel（还原）。
 */
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
  /* 空判据需要的几个字段（与 RightPanel 的 SECTION_REGISTRY.isEmpty 同一个口径） */
  const todos = useStore((s) => s.todos)
  const logs = useStore((s) => s.logs)
  const statuses = useStore((s) => s.statuses)
  const widgets = useStore((s) => s.widgets)

  const [area, setArea] = useState<FloatArea | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [resize, setResize] = useState<ResizeState | null>(null)
  /** 拖动中的临时像素矩形（只用本地 state，不每帧写盘） */
  const [ghost, setGhost] = useState<FloatPxRect | null>(null)
  /** 拖不动时的就地说明（例如放不下被退回） */
  const [notice, setNotice] = useState('')
  const restoreRects = useRef<Record<string, FloatPxRect>>({})
  const releaseRef = useRef<(() => void) | null>(null)
  const t = useT()

  /* 可用区跟随窗口/缩放/栏宽变化重算；几何变了就把磁贴重新夹一遍 */
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

  /** 还原拖动（不写盘）：Esc / pointercancel / 失焦 / 切会话都走它 */
  const cancelGesture = useCallback(() => {
    document.body.classList.remove('tile-dragging')
    setDrag(null)
    setResize(null)
    setGhost(null)
    /* 拖回工具页时画出的插入线也要一起撤掉，否则它会留在栏里 */
    useStore.getState().setToolDropTarget(null)
  }, [])

  /* 切会话取消拖动：布局是应用级，但拖动中的临时位移属于上一个会话上下文 */
  useEffect(() => {
    cancelGesture()
  }, [sessionKey, cancelGesture])

  /* Esc 取消 + 失焦取消（拖到窗口外再放开不能留下一个漂着的磁贴） */
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

  /* 拖动期间释放 blocker：原生网页在拖动中暂隐，放开/取消后由协调器复判 */
  useEffect(() => {
    if (!drag && !resize) return undefined
    releaseRef.current = acquireOverlayBlocker('tile-drag')
    return () => {
      releaseRef.current?.()
      releaseRef.current = null
    }
  }, [drag, resize, acquireOverlayBlocker])

  const commitDrag = useCallback(
    (state: Pick<DragState, 'id'>, rect: FloatPxRect) => {
      if (!area) return
      const wanted = clampFloatPixels(rect, area)
      const safe = avoidFloatObstacle(wanted, area, browserArea())
      if (!safe) {
        /* 没有能完整容纳磁贴的 DOM 区：退回工具页并说明原因，不永久压住网页 */
        setNotice(t('tl.noRoom'))
        window.setTimeout(() => setNotice(''), 3200)
        void setToolLayout(setTilePlacement(layout, state.id, 'docked'))
        return
      }
      void setToolLayout(setTilePlacement(layout, state.id, 'floating', pxRectToNormalized(safe, area)))
    },
    [area, layout, setToolLayout, t]
  )

  if (tiles.length === 0 && !notice) return null

  return (
    <div className="rp-float-layer" data-testid="float-layer">
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
              /* 整条标题栏可拖；操作按钮自己处理点击。 */
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
                /* capture 失败也能拖，只是指针移出头部后断流 */
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
              setGhost(
                clampFloatPixels(
                  { ...drag.origin, left: drag.origin.left + dx, top: drag.origin.top + dy },
                  area
                )
              )
              /*
               * 拖到工具页上方时，在栏里画出插入位置（与栏内重排同一条指示线）。
               * 浮窗本体跟着指针走，但「松手会插到哪」只有这条线能回答 ——
               * 栏内的槽位不在这个组件的 DOM 里，所以走 store 共享。
               */
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
                /* 指针没了也无所谓 */
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
                /* capture 失败时仍可在把手上调整 */
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
                /* 指针已释放时无需额外处理 */
              }
              const finalRect = ghost ?? rect
              const resizedId = resize.id
              cancelGesture()
              delete restoreRects.current[resizedId]
              commitDrag({ id: resizedId }, finalRect)
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
                  <button
                    type="button"
                    className="rp-float-btn"
                    title="放大或还原磁贴"
                    aria-label="放大或还原磁贴"
                    data-testid={`float-maximize-${tile.id}`}
                    onClick={() => {
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
                    }}
                  >
                    <span aria-hidden="true">⛶</span>
                  </button>
                  <button
                    className="rp-float-btn"
                    title={tile.collapsed ? t('tl.expand') : t('tl.collapse')}
                    aria-label={tile.collapsed ? t('tl.expand') : t('tl.collapse')}
                    aria-expanded={!tile.collapsed}
                    data-testid={`float-fold-${tile.id}`}
                    onClick={() => void setToolLayout(setTileCollapsed(layout, tile.id, !tile.collapsed))}
                  >
                    <Icon name="chevron-right" size={12} className={`chev ${tile.collapsed ? '' : 'on'}`} />
                  </button>
                  <button
                    className="rp-float-btn"
                    title={t('tl.dockBack')}
                    aria-label={t('tl.dockBack')}
                    data-testid={`float-dock-${tile.id}`}
                    onClick={() => void setToolLayout(setTilePlacement(layout, tile.id, 'docked'))}
                  >
                    <Icon name="layers" size={12} />
                  </button>
                </header>
                {tile.collapsed ? null : (
                  <>
                    <div
                      className="rp-float-body"
                      style={{ maxHeight: Math.max(0, rect.height - TILE_HEAD_H) }}
                    >
                      {(SECTION_REGISTRY[id].isEmpty
                        ? SECTION_REGISTRY[id].isEmpty!({ todos, logs, statuses, widgets })
                        : false) ? (
                        <div className="rp-float-empty">{t('tl.empty')}</div>
                      ) : (
                        <Body />
                      )}
                    </div>
                    <button
                      type="button"
                      className="rp-float-resize"
                      aria-label={`${name} 尺寸调整`}
                      title="拖动调整尺寸"
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
