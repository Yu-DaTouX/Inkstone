import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { IconName } from '../../icons/Icon'
import { IconButton, Menu, MenuItem, MenuSeparator, Select, Tab } from '../ui'
import { useStore } from '../../state/store'
import { loadWorkbenchState } from '../../state/workbench'
import { CHAT_PANE, DOCK_GAP, defaultWorkspaceLayout, dockGroups, hideDockPane, measureDockLayout, moveDockPane, normalizeWorkspaceLayout, openDockPane, resizeDockSplit, withoutDockPane, type DockEdge, type DockRect, type DockSeparator, type WorkspaceLayout } from '../../state/workspace-layout'

/** Resource-owned commands shown in the tile menu; layout never decides what they do. */
export interface PaneAction { label: string; icon?: IconName; danger?: boolean; run(): void }
/** `hint` is the tab tooltip; `closeLabel` gives the tab its own × (closing the resource, not just hiding the tile). */
interface PaneInfo { id: string; title: string; icon?: IconName; addLabel?: string; hint?: string; closeLabel?: string }
interface PaneCommands { actions?: PaneAction[]; onAdd?(): void; onClose?(): void }
interface WorkspaceContextValue {
  host: HTMLDivElement | null
  register(info: PaneInfo): void
  unregister(id: string): void
  open(id: string): void
  hide(id: string): void
  rects: Map<string, DockRect>
  /** The pane lifted by a drag; it follows the pointer above the other tiles. */
  floating: string | null
  commands: Map<string, PaneCommands>
}
export type MenuAnchor = { top: number; right: number }
type WorkspaceMenu = { kind: 'workspace'; at: MenuAnchor } | { kind: 'pane'; pane: string; at: MenuAnchor }
/** Tool tiles have a tab row; the main conversation only has a slim grip. */
const HEAD = 28, GRIP = 10, GRIP_MAXIMIZED = 24
/** Space between the tiles and the edges of the content area. */
const EDGE_X = DOCK_GAP, EDGE_TOP = 2, EDGE_BOTTOM = DOCK_GAP
export function menuAnchor(el: Element): MenuAnchor {
  const r = el.getBoundingClientRect()
  return { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }
}
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)
const storageKey = 'inkstone.workspace.tiles.v1'
export function loadWorkspaceLayout(key: string): WorkspaceLayout {
  try {
    const map = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (map[key]) return normalizeWorkspaceLayout(map[key])
    if (key !== 'pending' && map.pending) {
      const migrated = normalizeWorkspaceLayout(map.pending)
      delete map.pending; map[key] = migrated
      localStorage.setItem(storageKey, JSON.stringify(map))
      return migrated
    }
    const legacy = loadWorkbenchState(key)
    let migrated = defaultWorkspaceLayout()
    const ids = legacy.tabs.filter(tab => !['start', 'tools', 'subagent'].includes(tab.kind)).map(tab => tab.id)
    for (const id of ids) migrated = openDockPane(migrated, id)
    if (ids.includes(legacy.activeTabId)) migrated = openDockPane(migrated, legacy.activeTabId)
    return migrated
  } catch { return defaultWorkspaceLayout() }
}
export function useWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('Workspace pane needs a workspace')
  return value
}
export function Workspace({ sessionKey, children }: { sessionKey: string; children: ReactNode }) {
  const [saved, setSaved] = useState(() => ({ key: sessionKey, layout: loadWorkspaceLayout(sessionKey) }))
  const [panes, setPanes] = useState<PaneInfo[]>([])
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 1000, h: 700 })
  const [menu, setMenu] = useState<WorkspaceMenu | null>(null)
  const [target, setTarget] = useState('')
  const [drag, setDrag] = useState<{ pane: string; target?: string; edge?: DockEdge } | null>(null)
  /** Cursor position inside the canvas, kept apart so following the pointer never re-measures tiles. */
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const interactionCleanup = useRef<(() => void) | undefined>(undefined)
  const movedPointer = useRef(false)
  /** The click that ends a drag is swallowed; later clicks (keyboard, menus) are not. */
  const dragEndedAt = useRef(0)
  const justDragged = () => performance.now() - dragEndedAt.current < 400
  const currentKey = useRef(sessionKey)
  currentKey.current = sessionKey
  const acquireBlocker = useStore(s => s.acquireOverlayBlocker)

  const layout = saved.layout
  const update = useCallback((fn: (l: WorkspaceLayout) => WorkspaceLayout) => setSaved(s => ({ key: currentKey.current, layout: fn(s.key === currentKey.current ? s.layout : loadWorkspaceLayout(currentKey.current)) })), [])
  useEffect(() => {
    interactionCleanup.current?.()
    setSaved({ key: sessionKey, layout: loadWorkspaceLayout(sessionKey) }); setMenu(null)
  }, [sessionKey])
  useEffect(() => {
    try {
      const map = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
      map[saved.key] = saved.layout
      localStorage.setItem(storageKey, JSON.stringify(map))
    } catch { /* A preference write never prevents using the resource. */ }
  }, [saved])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth - 2 * EDGE_X, h: el.clientHeight - EDGE_TOP - EDGE_BOTTOM }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => () => interactionCleanup.current?.(), [])
  const menuOpen = !!menu
  useEffect(() => {
    if (!menuOpen) return
    const release = acquireBlocker('workspace-menu')
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('keydown', escape)
    return () => { release(); document.removeEventListener('keydown', escape) }
  }, [menuOpen, acquireBlocker])
  /* The title bar owns the entry; the anchor arrives with the request. */
  useEffect(() => {
    const show = (e: Event) => {
      const at = (e as CustomEvent<MenuAnchor | undefined>).detail
      setMenu({ kind: 'workspace', at: at ?? { top: 44, right: 16 } })
    }
    window.addEventListener('inkstone-workspace-arrange', show)
    return () => window.removeEventListener('inkstone-workspace-arrange', show)
  }, [])
  const commands = useRef(new Map<string, PaneCommands>()).current
  const register = useCallback((info: PaneInfo) => {
    setPanes(current => [...current.filter(p => p.id !== info.id), info])
    update(l => dockGroups(l.root).some(g => g.panes.includes(info.id)) ? l : openDockPane(l, info.id))
  }, [update])
  const unregister = useCallback((id: string) => setPanes(current => current.filter(p => p.id !== id)), [])
  const open = useCallback((id: string) => update(l => openDockPane(l, id)), [update])
  const hide = useCallback((id: string) => update(l => hideDockPane(l, id)), [update])
  const available = useMemo(() => new Set(panes.map(p => p.id)), [panes])
  /* While dragging, tiles render the arrangement the drop would produce; saving waits for release. */
  const dragPane = drag?.pane, dragTarget = drag?.target, dragEdge = drag?.edge
  const shown = useMemo(() => dragPane && dragTarget && dragEdge ? moveDockPane(layout, dragPane, dragTarget, dragEdge) : layout, [layout, dragPane, dragTarget, dragEdge])
  const measured = useMemo(() => measureDockLayout(shown, available, size.w, size.h), [shown, available, size])
  /* The lifted tile keeps its size and the spot where it was grabbed, as a window would. */
  const lift = useRef({ x: 0, y: 0, w: 0, h: 0 })
  const floating = drag && pointer ? drag.pane : null
  const floatRect = floating && pointer ? { x: pointer.x - lift.current.x, y: pointer.y - lift.current.y, w: lift.current.w, h: lift.current.h } : null
  const floatHead = floating === CHAT_PANE ? GRIP : HEAD
  const rects = useMemo(() => {
    const result = new Map<string, DockRect>()
    for (const r of measured.groups) {
      const ids = r.group.panes.filter(id => available.has(id) && !layout.hidden.includes(id))
      const active = ids.includes(r.group.active) ? r.group.active : ids[0]
      const head = ids.length === 1 && ids[0] === CHAT_PANE ? (layout.maximized ? GRIP_MAXIMIZED : GRIP) : HEAD
      if (active) result.set(active, { x: r.x + 1, y: r.y + head, w: r.w - 2, h: r.h - head - 1 })
    }
    if (floating && floatRect) result.set(floating, { x: floatRect.x + 1, y: floatRect.y + floatHead, w: floatRect.w - 2, h: floatRect.h - floatHead - 1 })
    return result
  }, [measured, available, layout.hidden, layout.maximized, floating, floatRect?.x, floatRect?.y, floatHead])
  const context = useMemo(() => ({ host, register, unregister, open, hide, rects, commands, floating }), [host, register, unregister, open, hide, rects, commands, floating])
  /* After release the tile glides from the cursor into its slot. */
  const [settling, setSettling] = useState(false)
  useEffect(() => {
    if (!settling) return
    const timer = setTimeout(() => setSettling(false), 260)
    return () => clearTimeout(timer)
  }, [settling])
  const beginDrag = (pane: string, event: React.PointerEvent) => {
    if (event.button !== 0 || layout.maximized) return
    event.preventDefault()
    interactionCleanup.current?.()
    /* Only a real drag hides the native browser; a plain tab click must not flicker it. */
    let release: (() => void) | undefined
    const owner = sessionKey
    movedPointer.current = false
    const origin = { x: event.clientX, y: event.clientY }
    let drop: { target: string; edge: DockEdge } | undefined, started = false
    /*
     * Targets come from the arrangement without the dragged pane and stay fixed for the whole
     * drag. Hit-testing the live preview instead would move the tile under the cursor and flip
     * the target back and forth.
     */
    const targets = measureDockLayout(withoutDockPane(layout, pane), available, size.w, size.h).groups
    const source = measured.groups.find(r => r.group.panes.includes(pane)), start = host?.getBoundingClientRect()
    if (source && start) lift.current = { x: event.clientX - start.left - source.x, y: event.clientY - start.top - source.y, w: source.w, h: source.h }
    const move = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 5 && !movedPointer.current) return
      if (!movedPointer.current) { movedPointer.current = true; release = acquireBlocker('workspace-drag') }
      const bounds = host?.getBoundingClientRect()
      if (!bounds) return
      const x = e.clientX - bounds.left, y = e.clientY - bounds.top
      setPointer({ x, y })
      const r = targets.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
      let next: typeof drop
      if (r) {
        const dx = (x - r.x) / r.w, dy = (y - r.y) / r.h
        const edge: DockEdge = dx < .24 ? 'left' : dx > .76 ? 'right' : dy < .24 ? 'top' : dy > .76 ? 'bottom' : 'center'
        if (edge !== 'center' || (pane !== CHAT_PANE && !r.group.panes.includes(CHAT_PANE))) next = { target: r.group.id, edge }
      }
      const same = next?.target === drop?.target && next?.edge === drop?.edge
      drop = next
      if (same && started) return
      started = true
      setDrag({ pane, ...drop })
    }
    const finish = (commit: boolean) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('keydown', escape); window.removeEventListener('blur', cancel)
      if (movedPointer.current) { dragEndedAt.current = performance.now(); setSettling(true) }
      movedPointer.current = false; release?.(); setDrag(null); setPointer(null); interactionCleanup.current = undefined
      if (commit && drop && currentKey.current === owner) update(l => moveDockPane(l, pane, drop!.target, drop!.edge))
    }
    const up = () => finish(true), cancel = () => finish(false)
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); finish(false) } }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('keydown', escape); window.addEventListener('blur', cancel)
    interactionCleanup.current = cancel
  }
  const resize = (separator: DockSeparator, event: React.PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault(); interactionCleanup.current?.()
    const release = acquireBlocker('workspace-resize'), initial = layout, owner = sessionKey
    const move = (e: PointerEvent) => {
      const r = host?.getBoundingClientRect()
      if (!r) return
      const offset = separator.axis === 'x' ? e.clientX - r.left - separator.bounds.x : e.clientY - r.top - separator.bounds.y
      update(l => resizeDockSplit(l, separator.id, offset / ((separator.axis === 'x' ? separator.bounds.w : separator.bounds.h) - DOCK_GAP)))
    }
    const finish = (cancel: boolean) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('keydown', escape); window.removeEventListener('blur', abort)
      release(); interactionCleanup.current = undefined
      if (cancel && currentKey.current === owner) update(() => initial)
    }
    const up = () => finish(false), abort = () => finish(true), escape = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true) }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('keydown', escape); window.addEventListener('blur', abort)
    interactionCleanup.current = abort
  }
  const position = (r: DockRect) => ({ left: r.x, top: r.y, width: r.w, height: r.h })
  const titleOf = (id: string) => panes.find(p => p.id === id)?.title ?? id
  const groupOf = (pane: string) => dockGroups(layout.root).find(g => g.panes.includes(pane))
  const openPaneMenu = (pane: string, at: MenuAnchor) => {
    if (justDragged()) return
    const own = groupOf(pane)?.id
    setTarget(measured.groups.find(g => g.group.id !== own)?.group.id ?? own ?? '')
    setMenu({ kind: 'pane', pane, at })
  }
  const run = (fn: () => void) => { setMenu(null); fn() }
  const toggleMaximize = (pane: string) => update(l => ({ ...l, maximized: l.maximized ? undefined : pane }))
  const menuPane = menu?.kind === 'pane' ? menu.pane : ''
  const targetHasChat = !!dockGroups(layout.root).find(g => g.id === target)?.panes.includes(CHAT_PANE)
  return <WorkspaceContext.Provider value={context}>
    <div className={`tile-workspace${drag ? ' dragging' : ''}${settling ? ' settling' : ''}`} data-testid="tile-workspace">
      <div className="tile-workspace-scroll" ref={scrollRef}>
        <div className="tile-workspace-pad" style={{ padding: `${EDGE_TOP}px ${EDGE_X}px ${EDGE_BOTTOM}px` }}>
        <div className="tile-workspace-canvas" ref={setHost} style={{ width: measured.width, height: measured.height }}>
          {measured.groups.map(r => {
            const ids = r.group.panes.filter(id => available.has(id) && !layout.hidden.includes(id))
            const active = ids.includes(r.group.active) ? r.group.active : ids[0]
            /* The lifted tile leaves a placeholder where it will land (or where it came from). */
            const slot = !!floating && active === floating
            if (!active) return null
            return <div key={'frame-' + active} className={`tile-frame ui-tile${slot ? ' drop-slot tile-drop-preview' : ids.length === 1 && active === CHAT_PANE ? ' primary' : ''}${layout.maximized ? ' maximized' : ''}`} style={position(r)} />
          })}
          {measured.groups.map(r => {
            const ids = r.group.panes.filter(id => available.has(id) && !layout.hidden.includes(id))
            const active = ids.includes(r.group.active) ? r.group.active : ids[0]
            if (!active || active === floating) return null
            if (ids.length === 1 && active === CHAT_PANE) {
              /* The conversation keeps its own header; only a grip sits above it. */
              return <div key={'head-' + active} className="tile-heading tile-grip-zone" style={{ ...position(r), height: layout.maximized ? GRIP_MAXIMIZED : GRIP }} data-dock-group={r.group.id} onPointerDown={e => { if (!(e.target as HTMLElement).closest(".tile-grip-restore")) beginDrag(active, e) }}>
                <button type="button" className="tile-grip ui-tile-grip" aria-label={`移动 ${titleOf(active)}`} title="拖动以移动主会话；按 Enter 打开移动菜单" onClick={e => openPaneMenu(active, menuAnchor(e.currentTarget))} />
                {layout.maximized ? <IconButton className="tile-grip-restore" size="sm" icon="dock" label="还原面板" onClick={() => toggleMaximize(active)} /> : null}
              </div>
            }
            const info = panes.find(p => p.id === active)
            /* Only tabs, "+" and hide stay visible; the pane menu opens on right-click (or the menu key) and double-click maximizes. */
            return <div key={'head-' + active} className="tile-heading ui-tile-head" style={{ ...position(r), height: HEAD }} data-dock-group={r.group.id} title="右键：移动与面板操作 · 双击：放大或还原"
              onPointerDown={e => { if (!(e.target as HTMLElement).closest('button')) beginDrag(active, e) }}
              onDoubleClick={e => { if (!(e.target as HTMLElement).closest('.ui-tab-close, .btn')) toggleMaximize(active) }}
              onContextMenu={e => { e.preventDefault(); const tab = (e.target as HTMLElement).closest('[data-pane-tab]') as HTMLElement | null; openPaneMenu(tab?.dataset.paneTab ?? active, { top: e.clientY + 2, right: Math.max(8, window.innerWidth - e.clientX) }) }}
              onKeyDown={e => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openPaneMenu(active, menuAnchor(e.currentTarget)) } }}>
              <div className={`ui-tabs tile-tabs${ids.length === 1 ? ' single' : ''}`} role="tablist" aria-label="磁贴标签">
                {ids.map(id => { const pane = panes.find(p => p.id === id); return <span key={id} role="presentation" className="tile-tab" data-pane-tab={id}><Tab icon={pane?.icon} title={pane?.hint} selected={id === active}
                  onClick={() => { if (!justDragged()) open(id) }} onPointerDown={e => { if (!(e.target as HTMLElement).closest('.ui-tab-close')) beginDrag(id, e) }}
                  onClose={pane?.closeLabel ? () => commands.get(id)?.onClose?.() : undefined} closeLabel={pane?.closeLabel}>{titleOf(id)}</Tab></span> })}
                {info?.addLabel ? <IconButton icon="plus" size="sm" label={info.addLabel} onClick={() => commands.get(active)?.onAdd?.()} /> : null}
              </div>
              <IconButton size="sm" icon="close" label="收起面板，保留运行" onClick={() => hide(active)} />
            </div>
          })}
          {drag ? null : measured.separators.map(s => <div key={s.id} className={`tile-separator ui-splitter axis-${s.axis}`} style={position(s)} role="separator" tabIndex={0} aria-label={s.axis === 'x' ? '调整面板宽度' : '调整面板高度'} aria-orientation={s.axis === 'x' ? 'vertical' : 'horizontal'} aria-valuenow={Math.round(s.ratio * 100)} aria-valuemin={10} aria-valuemax={90} onPointerDown={e => resize(s, e)} onKeyDown={e => {
            const delta = (s.axis === 'x' ? e.key === 'ArrowLeft' : e.key === 'ArrowUp') ? -.025 : (s.axis === 'x' ? e.key === 'ArrowRight' : e.key === 'ArrowDown') ? .025 : 0
            if (delta) { e.preventDefault(); update(l => resizeDockSplit(l, s.id, s.ratio + delta)) }
          }} />)}
          {floating && floatRect ? <div className="tile-drag-layer">
            <div className="tile-float ui-tile floating" style={position(floatRect)}>
              <span className="tile-float-grip ui-tile-grip-bar" />
              {floating === CHAT_PANE ? null : <div className="tile-float-head ui-tile-head">
                <div className="ui-tabs tile-tabs single"><Tab selected icon={panes.find(p => p.id === floating)?.icon} onClick={() => {}}>{titleOf(floating)}</Tab></div>
              </div>}
            </div>
          </div> : null}
        </div>
        </div>
      </div>
      {menu ? <div className="tile-menu-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) setMenu(null) }}>
        <Menu className="tile-layout-menu" label="调整工作区" style={{ top: menu.at.top, right: menu.at.right }}>
          {menu.kind === 'workspace' ? <>
            <MenuItem icon="tile" autoFocus onClick={() => run(() => update(() => panes.reduce((l, p) => p.id === CHAT_PANE || p.id === 'tools' ? l : openDockPane(l, p.id), defaultWorkspaceLayout())))}>恢复默认排列</MenuItem>
            {layout.maximized ? <MenuItem icon="dock" onClick={() => run(() => update(l => ({ ...l, maximized: undefined })))}>返回工作区</MenuItem> : null}
            {panes.some(p => layout.hidden.includes(p.id)) ? <><MenuSeparator /><div className="tile-menu-label ui-menu-label">已隐藏</div></> : null}
            {panes.filter(p => layout.hidden.includes(p.id)).map(p => <MenuItem key={p.id} icon={p.icon} onClick={() => run(() => open(p.id))}>重新打开 {p.title}</MenuItem>)}
          </> : <>
            <div className="tile-menu-label ui-menu-label">移动 {titleOf(menuPane)} 到</div>
            <Select autoFocus aria-label="目标磁贴" value={target} onChange={e => setTarget(e.target.value)}>{measured.groups.map(r => <option key={r.group.id} value={r.group.id}>{r.group.panes.map(id => panes.find(p => p.id === id)?.title).filter(Boolean).join(' / ')}</option>)}</Select>
            <div className="tile-move-actions">
              {(['left', 'right', 'top', 'bottom'] as DockEdge[]).map((edge, i) => <MenuItem key={edge} onClick={() => run(() => { if (target) update(l => moveDockPane(l, menuPane, target, edge)) })}>{['左侧', '右侧', '上方', '下方'][i]}</MenuItem>)}
            </div>
            <MenuItem icon="group" disabled={menuPane === CHAT_PANE || targetHasChat} onClick={() => run(() => { if (target) update(l => moveDockPane(l, menuPane, target, 'center')) })}>合入标签组</MenuItem>
            <MenuSeparator />
            {(commands.get(menuPane)?.actions ?? []).map(action => <MenuItem key={action.label} icon={action.icon} danger={action.danger} onClick={() => run(action.run)}>{action.label}</MenuItem>)}
            <MenuItem icon={layout.maximized ? 'dock' : 'maximize'} onClick={() => run(() => toggleMaximize(menuPane))}>{layout.maximized ? '还原面板' : '放大面板'}</MenuItem>
            {menuPane !== CHAT_PANE ? <MenuItem icon="close" onClick={() => run(() => hide(menuPane))}>隐藏面板</MenuItem> : null}
          </>}
        </Menu>
      </div> : null}
    </div>
    {children}
  </WorkspaceContext.Provider>
}

/** The portal parent and pane key stay stable across docking, preserving content state. */
export function WorkspacePane({ id, title, icon, addLabel, hint, closeLabel, onAdd, onClose, actions, children, onVisibleChange }: PaneInfo & PaneCommands & { children: ReactNode; onVisibleChange?(visible: boolean): void }) {
  const workspace = useWorkspace(), { register, unregister, rects, host, commands, floating } = workspace
  useLayoutEffect(() => { register({ id, title, icon, addLabel, hint, closeLabel }) }, [id, title, icon, addLabel, hint, closeLabel, register])
  useLayoutEffect(() => () => unregister(id), [id, unregister])
  /* Commands are read when the menu opens, so they always use the latest resource state. */
  useLayoutEffect(() => { commands.set(id, { actions, onAdd, onClose }) })
  useLayoutEffect(() => () => { commands.delete(id) }, [id, commands])
  const rect = rects.get(id), visible = !!rect
  useEffect(() => { onVisibleChange?.(visible) }, [visible, onVisibleChange])
  useEffect(() => () => onVisibleChange?.(false), [onVisibleChange])
  if (!host) return null
  return createPortal(<section className={`tile-pane ui-tile-body${floating === id ? ' floating' : ''}`} data-workspace-pane={id} hidden={!visible} style={rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}>{children}</section>, host, id)
}
