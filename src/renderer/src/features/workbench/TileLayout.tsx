import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import {
  TILE_GAP,
  TILE_MIN_PX,
  adjustFlexes,
  findStack,
  layoutsEqual,
  moveTile,
  nodeKey,
  orderedTileIds,
  parentOfTile,
  tilePath,
  withStackFlexes,
  type TileLayout,
  type TileNode,
  type TileStack,
  type TileTarget
} from './tile-tree'
import { box, createDropSnapshot, hitTestDrop, type Box, type DropSnapshot } from './tile-drop-zones'

export type TileMoveSide = 'left' | 'right' | 'up' | 'down'
type Edge = 'left' | 'right' | 'top' | 'bottom'

export interface TileLayoutText {
  move: string
  moveSide: Record<TileMoveSide, string>
  moveSideHint: Record<TileMoveSide, string>
  moveInstructions: string
  movedTo: (name: string, position: number, count: number) => string
  moveCancelled: (name: string) => string
  resize: (before: string, after: string) => string
}

export interface TileHandle {
  tileId: string
  label: string
  tooltip: string
  dragging: boolean
  previewing: boolean
  describedBy: string
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  onBlur: () => void
}

export interface TileLayoutProps {
  layout: TileLayout
  mounted: readonly string[]
  dragDisabled?: boolean
  text: TileLayoutText
  tileName: (tileId: string) => string
  renderTile: (tileId: string, handle: TileHandle) => ReactNode
  onLayoutChange: (layout: TileLayout) => void
  canMoveOut?: (tileId: string) => boolean
  onMoveOut?: (tileId: string) => void
  onDraggingChange?: (dragging: boolean) => void
}

interface TileDrag {
  mode: 'tile'
  tileId: string
  pointerId: number
  start: { x: number; y: number }
  delta: { x: number; y: number }
  origin: { left: number; top: number } | null
  slotShift: { x: number; y: number }
  startLayout: TileLayout
  snapshot: DropSnapshot | null
  pending: TileLayout | null
  out: boolean
}

interface Boundary {
  stackId: string
  index: number
  direction: 'row' | 'column'
  startFlexes: number[]
  pxPerFlex: number
  live: number[] | null
}

interface BoundaryDrag {
  mode: 'resize'
  pointerId: number
  start: { x: number; y: number }
  boundary: Boundary
}

type Interaction = TileDrag | BoundaryDrag | null

const KEY_STEP = 24
const KEY_STEP_LARGE = 120
const OUT_THRESHOLD_PX = 24
const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

const plainKey = (event: KeyboardEvent<HTMLElement>): boolean => !event.ctrlKey && !event.metaKey && !event.altKey

function asBox(rect: DOMRect): Box {
  return box(rect.left, rect.top, rect.width, rect.height)
}

function sideEdge(side: 'start' | 'end', direction: 'row' | 'column'): Edge {
  if (direction === 'row') return side === 'start' ? 'left' : 'right'
  return side === 'start' ? 'top' : 'bottom'
}

function crossDirection(direction: 'row' | 'column'): 'row' | 'column' {
  return direction === 'row' ? 'column' : 'row'
}

function stackEdge(stack: TileStack, target: TileTarget | null): Edge | null {
  if (!target) return null
  if (target.kind === 'split' && target.stackId === stack.id && target.direction !== stack.direction) {
    return sideEdge(target.index === 0 ? 'start' : 'end', target.direction)
  }
  const along = (target.kind === 'insert' && target.stackId === stack.id) || (target.kind === 'split' && target.stackId === stack.id)
  if (!along) return null
  if (target.index === 0) return sideEdge('start', stack.direction)
  if (target.index >= stack.children.length) return sideEdge('end', stack.direction)
  return null
}

function boundaryIndexOf(stack: TileStack, target: TileTarget | null): number | null {
  if (!target || (target.kind !== 'insert' && target.kind !== 'split') || target.stackId !== stack.id) return null
  if (target.kind === 'split' && target.direction !== stack.direction) return null
  return target.index > 0 && target.index < stack.children.length ? target.index - 1 : null
}

function wrapEdge(tileId: string, target: TileTarget | null): Edge | null {
  if (!target || target.kind !== 'wrap' || target.tileId !== tileId) return null
  return sideEdge(target.index === 0 ? 'start' : 'end', target.direction)
}

function DropIndicator({ edge }: { edge: Edge }): ReactElement {
  return <div className="wb-pane-indicator" data-edge={edge} aria-hidden />
}

function useContentHosts(): { host: (id: string) => HTMLDivElement; adopt: (id: string, shell: HTMLElement) => void; release: (id: string) => void } {
  const hosts = useRef(new Map<string, HTMLDivElement>())
  return useMemo(() => {
    const host = (id: string): HTMLDivElement => {
      let element = hosts.current.get(id)
      if (!element) {
        element = document.createElement('div')
        hosts.current.set(id, element)
      }
      element.className = 'wb-pane-host'
      return element
    }
    return {
      host,
      adopt: (id, shell) => {
        const element = host(id)
        if (element.parentNode !== shell) shell.appendChild(element)
      },
      release: (id) => {
        const element = hosts.current.get(id)
        if (!element) return
        element.remove()
        hosts.current.delete(id)
      }
    }
  }, [])
}

export function TileLayoutView({
  layout,
  mounted,
  dragDisabled = false,
  text,
  tileName,
  renderTile,
  onLayoutChange,
  canMoveOut,
  onMoveOut,
  onDraggingChange
}: TileLayoutProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const nodeEls = useRef(new Map<string, HTMLElement>())
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const interaction = useRef<Interaction>(null)
  const hosts = useContentHosts()
  const instructionsId = useId()
  const [draggingTile, setDraggingTile] = useState<string | null>(null)
  const [resizing, setResizing] = useState<string | null>(null)
  const [target, setTarget] = useState<TileTarget | null>(null)
  const [outTarget, setOutTarget] = useState(false)
  const [preview, setPreview] = useState<{ tileId: string; side: TileMoveSide; target: TileTarget } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const focusAfterMove = useRef<string | null>(null)
  const latest = useRef({ onLayoutChange, canMoveOut, onMoveOut, text, tileName, onDraggingChange })
  latest.current = { onLayoutChange, canMoveOut, onMoveOut, text, tileName, onDraggingChange }

  const changeLayout = useCallback((next: TileLayout): void => {
    layoutRef.current = next
    latest.current.onLayoutChange(next)
  }, [])

  const registerNodeEl = useCallback(
    (key: string) =>
      (element: HTMLElement | null): void => {
        if (element) nodeEls.current.set(key, element)
        else if (nodeEls.current.get(key)?.isConnected === false) nodeEls.current.delete(key)
      },
    []
  )

  const measure = useCallback((key: string): Box | null => {
    const element = nodeEls.current.get(key)
    return element?.isConnected ? asBox(element.getBoundingClientRect()) : null
  }, [])

  const settleTile = useCallback((tileId: string): void => {
    const element = nodeEls.current.get(tileId)
    if (!element) return
    element.style.transition = ''
    element.style.transform = ''
  }, [])

  const finish = useCallback((): void => {
    interaction.current = null
    setDraggingTile(null)
    setResizing(null)
    setTarget(null)
    setOutTarget(false)
    latest.current.onDraggingChange?.(false)
  }, [])

  const announceMove = useCallback((tileId: string, next: TileLayout): void => {
    const path = tilePath(next, tileId)
    const parent = parentOfTile(next, tileId)
    const position = path ? path[path.length - 1] + 1 : 1
    const { text: t, tileName: name } = latest.current
    setAnnouncement(t.movedTo(name(tileId), position, parent?.children.length ?? 1))
  }, [])

  const commitKeyboardMove = useCallback(
    (tileId: string, to: TileTarget): void => {
      const next = moveTile(layoutRef.current, tileId, to)
      if (layoutsEqual(next, layoutRef.current)) return
      focusAfterMove.current = tileId
      changeLayout(next)
      announceMove(tileId, next)
    },
    [changeLayout, announceMove]
  )

  const measureBoundary = useCallback((stack: TileStack, index: number): Omit<Boundary, 'live'> => {
    const element = nodeEls.current.get(stack.id)
    const rect = element?.getBoundingClientRect()
    const extent = rect ? (stack.direction === 'row' ? rect.width : rect.height) : 0
    const usable = Math.max(0, extent - TILE_GAP * Math.max(0, stack.children.length - 1))
    const flexes = stack.children.map((child) => child.flex)
    const total = flexes.reduce((sum, flex) => sum + flex, 0) || 1
    return { stackId: stack.id, index, direction: stack.direction, startFlexes: flexes, pxPerFlex: usable > 0 ? usable / total : 1 }
  }, [])

  const applyFlexStyles = useCallback((stack: TileStack, flexes: readonly number[]): void => {
    stack.children.forEach((child, index) => {
      const element = nodeEls.current.get(nodeKey(child))
      if (element && flexes[index] !== undefined) element.style.flexGrow = String(flexes[index])
    })
  }, [])

  const commitFlexes = useCallback(
    (boundary: Omit<Boundary, 'live'>, flexes: number[]): void => {
      if (flexes.every((flex, index) => Math.abs(flex - boundary.startFlexes[index]) < 1e-6)) return
      changeLayout(withStackFlexes(layoutRef.current, boundary.stackId, flexes))
    },
    [changeLayout]
  )

  const equalize = useCallback(
    (stackId: string, index: number): void => {
      if (interaction.current) return
      const stack = findStack(layoutRef.current, stackId)
      if (!stack || index + 1 >= stack.children.length) return
      const measured = measureBoundary(stack, index)
      const [a, b] = [measured.startFlexes[index], measured.startFlexes[index + 1]]
      commitFlexes(measured, adjustFlexes(measured.startFlexes, index, ((b - a) / 2) * measured.pxPerFlex, measured.pxPerFlex, TILE_MIN_PX))
    },
    [measureBoundary, commitFlexes]
  )

  const separatorProps = useCallback(
    (stackId: string, index: number) => ({
      onPointerDown: (event: PointerEvent<HTMLElement>): void => {
        if (event.button !== 0 || interaction.current) return
        const stack = findStack(layoutRef.current, stackId)
        if (!stack || index + 1 >= stack.children.length) return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        interaction.current = {
          mode: 'resize',
          pointerId: event.pointerId,
          start: { x: event.clientX, y: event.clientY },
          boundary: { ...measureBoundary(stack, index), live: null }
        }
        setResizing(`${stackId}:${index}`)
      },
      onDoubleClick: (): void => equalize(stackId, index),
      onKeyDown: (event: KeyboardEvent<HTMLElement>): void => {
        if (interaction.current) return
        const stack = findStack(layoutRef.current, stackId)
        if (!stack) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (!event.repeat) equalize(stackId, index)
          return
        }
        if (!plainKey(event)) return
        const row = stack.direction === 'row'
        const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
        const delta =
          event.key === (row ? 'ArrowLeft' : 'ArrowUp')
            ? -step
            : event.key === (row ? 'ArrowRight' : 'ArrowDown')
              ? step
              : event.key === 'Home'
                ? -Infinity
                : event.key === 'End'
                  ? Infinity
                  : null
        if (delta === null) return
        event.preventDefault()
        const measured = measureBoundary(stack, index)
        const bounded = Number.isFinite(delta) ? delta : Math.sign(delta) * 1e6
        commitFlexes(measured, adjustFlexes(measured.startFlexes, index, bounded, measured.pxPerFlex, TILE_MIN_PX))
      }
    }),
    [measureBoundary, equalize, commitFlexes]
  )

  const handleFor = (tileId: string): TileHandle => {
    const side = preview?.tileId === tileId ? preview.side : null
    const name = tileName(tileId)
    return {
      tileId,
      label: side ? text.moveSide[side] : `${text.move} ${name}`,
      tooltip: side ? `${text.moveSide[side]} ↵` : text.move,
      dragging: draggingTile === tileId,
      previewing: side !== null,
      describedBy: instructionsId,
      onPointerDown: (event) => {
        if (dragDisabled || event.button !== 0 || interaction.current) return
        const container = containerRef.current
        if (!container) return
        event.preventDefault()
        event.stopPropagation()
        const startPointer = { x: event.clientX, y: event.clientY }
        const snapshot = createDropSnapshot({
          layout: layoutRef.current,
          containerRect: asBox(container.getBoundingClientRect()),
          measure,
          sourceTileId: tileId,
          startPointer,
          gap: TILE_GAP
        })
        const element = nodeEls.current.get(tileId)
        const origin = element?.getBoundingClientRect()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        interaction.current = {
          mode: 'tile',
          tileId,
          pointerId: event.pointerId,
          start: startPointer,
          delta: { x: 0, y: 0 },
          origin: origin ? { left: origin.left, top: origin.top } : null,
          slotShift: { x: 0, y: 0 },
          startLayout: layoutRef.current,
          snapshot,
          pending: null,
          out: false
        }
        if (element) {
          element.style.transition = 'none'
          element.style.transform = 'translate(0px, 0px)'
        }
        setPreview(null)
        setTarget(null)
        setDraggingTile(tileId)
        latest.current.onDraggingChange?.(true)
      },
      onKeyDown: (event) => {
        if (dragDisabled || interaction.current) return
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
          if (!preview || preview.tileId !== tileId) return
          event.preventDefault()
          const chosen = preview.target
          setPreview(null)
          setTarget(null)
          if (event.key === 'Escape') setAnnouncement(text.moveCancelled(name))
          else commitKeyboardMove(tileId, chosen)
          return
        }
        if (!NAV_KEYS.has(event.key) || !plainKey(event)) return
        const current = layoutRef.current
        const path = tilePath(current, tileId)
        const parent = parentOfTile(current, tileId)
        if (!path || !parent) return
        event.preventDefault()
        const index = path[path.length - 1]
        const last = parent.children.length - 1
        const row = parent.direction === 'row'
        const cross = crossDirection(parent.direction)
        const split = (at: number): TileTarget => ({ kind: 'split', stackId: parent.id, direction: cross, index: at })
        const sideMove: { side: TileMoveSide; target: TileTarget } | null =
          event.key === 'ArrowLeft' && !row
            ? { side: 'left', target: split(0) }
            : event.key === 'ArrowRight' && !row
              ? { side: 'right', target: split(1) }
              : event.key === 'ArrowUp' && row
                ? { side: 'up', target: split(0) }
                : event.key === 'ArrowDown' && row
                  ? { side: 'down', target: split(1) }
                  : null
        if (sideMove) {
          setPreview({ tileId, ...sideMove })
          setTarget(sideMove.target)
          setAnnouncement(text.moveSideHint[sideMove.side])
          return
        }
        setPreview(null)
        setTarget(null)
        const next =
          event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? index - 1
            : event.key === 'ArrowRight' || event.key === 'ArrowDown'
              ? index + 1
              : event.key === 'Home'
                ? 0
                : last
        const clamped = Math.max(0, Math.min(last, next))
        if (clamped !== index) commitKeyboardMove(tileId, { kind: 'insert', stackId: parent.id, index: clamped })
      },
      onBlur: () => {
        if (interaction.current || preview?.tileId !== tileId) return
        setPreview(null)
        setTarget(null)
      }
    }
  }

  const active = draggingTile !== null || resizing !== null
  useEffect(() => {
    if (!active) return undefined
    const move = (event: globalThis.PointerEvent): void => {
      const current = interaction.current
      if (!current || event.pointerId !== current.pointerId) return
      if (current.mode === 'resize') {
        const { boundary } = current
        const stack = findStack(layoutRef.current, boundary.stackId)
        if (!stack) return
        const delta = boundary.direction === 'row' ? event.clientX - current.start.x : event.clientY - current.start.y
        boundary.live = adjustFlexes(boundary.startFlexes, boundary.index, delta, boundary.pxPerFlex, TILE_MIN_PX)
        applyFlexStyles(stack, boundary.live)
        return
      }
      current.delta = { x: event.clientX - current.start.x, y: event.clientY - current.start.y }
      const element = nodeEls.current.get(current.tileId)
      if (element) element.style.transform = `translate(${current.delta.x + current.slotShift.x}px, ${current.delta.y + current.slotShift.y}px)`
      const container = containerRef.current?.getBoundingClientRect()
      const out = !!container && event.clientX < container.left - OUT_THRESHOLD_PX && !!latest.current.canMoveOut?.(current.tileId)
      if (out !== current.out) {
        current.out = out
        setOutTarget(out)
      }
      if (out) {
        current.pending = null
        setTarget(null)
        return
      }
      if (!current.snapshot) return
      const hit = hitTestDrop(layoutRef.current, current.snapshot, current.tileId, { x: event.clientX, y: event.clientY })
      current.pending = hit.pendingLayout
      if (hit.liveLayout && !layoutsEqual(hit.liveLayout, layoutRef.current)) changeLayout(hit.liveLayout)
      setTarget(hit.target)
    }
    const up = (event: globalThis.PointerEvent): void => {
      const current = interaction.current
      if (!current || event.pointerId !== current.pointerId) return
      if (current.mode === 'resize') {
        if (current.boundary.live) commitFlexes(current.boundary, current.boundary.live)
        finish()
        return
      }
      settleTile(current.tileId)
      if (current.out) {
        if (!layoutsEqual(current.startLayout, layoutRef.current)) changeLayout(current.startLayout)
        finish()
        latest.current.onMoveOut?.(current.tileId)
        return
      }
      if (current.pending && !layoutsEqual(current.pending, layoutRef.current)) changeLayout(current.pending)
      finish()
      announceMove(current.tileId, layoutRef.current)
    }
    const cancel = (): void => {
      const current = interaction.current
      if (!current) return
      if (current.mode === 'resize') {
        const stack = findStack(layoutRef.current, current.boundary.stackId)
        if (stack) applyFlexStyles(stack, current.boundary.startFlexes)
        finish()
        return
      }
      if (!layoutsEqual(current.startLayout, layoutRef.current)) changeLayout(current.startLayout)
      settleTile(current.tileId)
      finish()
      setAnnouncement(latest.current.text.moveCancelled(latest.current.tileName(current.tileId)))
    }
    const key = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || !interaction.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
      cancel()
    }
    const pointerCancel = (event: globalThis.PointerEvent): void => {
      if (interaction.current && event.pointerId === interaction.current.pointerId) cancel()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', pointerCancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', pointerCancel)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', key, true)
    }
  }, [active, applyFlexStyles, commitFlexes, changeLayout, finish, settleTile, announceMove])

  useLayoutEffect(() => {
    const current = interaction.current
    if (!current || current.mode !== 'tile' || !current.origin) return
    const element = nodeEls.current.get(current.tileId)
    if (!element) return
    const saved = element.style.transform
    element.style.transform = 'none'
    const rect = element.getBoundingClientRect()
    element.style.transform = saved
    current.slotShift = { x: current.origin.left - rect.left, y: current.origin.top - rect.top }
    element.style.transform = `translate(${current.delta.x + current.slotShift.x}px, ${current.delta.y + current.slotShift.y}px)`
  }, [layout])

  useLayoutEffect(() => {
    const tileId = focusAfterMove.current
    if (!tileId) return
    focusAfterMove.current = null
    containerRef.current?.querySelector<HTMLElement>(`[data-tile-handle="${CSS.escape(tileId)}"]`)?.focus({ preventScroll: true })
  }, [layout])

  const mountedKey = mounted.join('\n')
  const previousMounted = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const now = new Set(mountedKey ? mountedKey.split('\n') : [])
    for (const id of previousMounted.current) if (!now.has(id)) hosts.release(id)
    previousMounted.current = now
  }, [mountedKey, hosts])

  const visible = useMemo(() => new Set(orderedTileIds(layout)), [layout])

  const renderNode = (node: TileNode, depth: number, parentDirection: 'row' | 'column' | null): ReactNode => {
    if (node.kind === 'tile') {
      if (!mounted.includes(node.tileId)) return null
      const edge = wrapEdge(node.tileId, target)
      return (
        <div
          key={node.tileId}
          ref={registerNodeEl(node.tileId)}
          className="wb-pane-tile"
          data-tile-id={node.tileId}
          data-dragging={draggingTile === node.tileId ? '1' : undefined}
          style={{ flexGrow: node.flex }}
        >
          <div
            className="wb-pane-shell"
            ref={(shell) => {
              if (shell) hosts.adopt(node.tileId, shell)
            }}
          />
          {edge ? <DropIndicator edge={edge} /> : null}
        </div>
      )
    }
    const edge = stackEdge(node, target)
    const dropBoundary = boundaryIndexOf(node, target)
    return (
      <div
        key={node.id}
        ref={registerNodeEl(node.id)}
        className="wb-pane-stack"
        data-direction={node.direction}
        data-root={depth === 0 ? '1' : undefined}
        style={depth === 0 ? undefined : { flexGrow: node.flex, minWidth: parentDirection === 'row' ? TILE_MIN_PX : undefined }}
      >
        {node.children.map((child, index) => (
          <Fragment key={nodeKey(child)}>
            {renderNode(child, depth + 1, node.direction)}
            {index < node.children.length - 1 ? (
              <TileSeparator
                direction={node.direction}
                active={resizing === `${node.id}:${index}`}
                dropTarget={dropBoundary === index}
                disabled={draggingTile !== null}
                label={text.resize(nameOf(child, tileName), nameOf(node.children[index + 1], tileName))}
                valueNow={Math.round((child.flex / (child.flex + node.children[index + 1].flex)) * 100)}
                {...separatorProps(node.id, index)}
              />
            ) : null}
          </Fragment>
        ))}
        {edge ? <DropIndicator edge={edge} /> : null}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="wb-panes"
      data-dragging={draggingTile ? '1' : undefined}
      data-resizing={resizing ? '1' : undefined}
      data-out={outTarget ? '1' : undefined}
    >
      {visible.size > 0 ? renderNode(layout.root, 0, null) : null}
      {outTarget ? <div className="wb-pane-out" aria-hidden /> : null}
      <span id={instructionsId} className="wb-sr" hidden>
        {text.moveInstructions}
      </span>
      <span className="wb-sr" role="status">
        {announcement}
      </span>
      {mounted.map((id) => createPortal(renderTile(id, handleFor(id)), hosts.host(id), id))}
    </div>
  )
}

function nameOf(node: TileNode, tileName: (tileId: string) => string): string {
  if (node.kind === 'tile') return tileName(node.tileId)
  return node.children.map((child) => nameOf(child, tileName)).join('、')
}

interface TileSeparatorProps {
  direction: 'row' | 'column'
  active: boolean
  dropTarget: boolean
  disabled: boolean
  label: string
  valueNow: number
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onDoubleClick: () => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

function TileSeparator({ direction, active, dropTarget, disabled, label, valueNow, onPointerDown, onDoubleClick, onKeyDown }: TileSeparatorProps): ReactElement {
  return (
    <div
      role="separator"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
      aria-valuenow={valueNow}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      title={label}
      className="wb-pane-sep"
      data-direction={direction}
      data-active={active ? '1' : undefined}
      data-drop={dropTarget ? '1' : undefined}
      onPointerDown={onPointerDown}
      onMouseDown={(event) => event.preventDefault()}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => {
        if (!disabled) onKeyDown(event)
      }}
    >
      <span className="wb-pane-sep-bar" aria-hidden />
    </div>
  )
}
