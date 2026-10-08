/** Layout contains resource references only. Moving a pane never changes its owner. */
export type DockEdge = 'left' | 'right' | 'top' | 'bottom' | 'center'
export type DockNode = { type: 'group'; id: string; panes: string[]; active: string } |
  { type: 'split'; id: string; axis: 'x' | 'y'; ratio: number; first: DockNode; second: DockNode }
/**
 * `basis` is the canvas size the ratios were last set at. Splits beside the main conversation keep
 * the tool side's pixel size from that basis, so a wider rail or a smaller window narrows only the
 * conversation instead of every tile.
 */
export interface WorkspaceLayout { version: 1; root: DockNode; hidden: string[]; maximized?: string; basis?: { w: number; h: number } }
export interface DockRect { x: number; y: number; w: number; h: number }
export interface DockGroupRect extends DockRect { group: Extract<DockNode, { type: 'group' }> }
export interface DockSeparator extends DockRect { id: string; axis: 'x' | 'y'; ratio: number; bounds: DockRect }
export const CHAT_PANE = 'chat'
/** The second conversation of a split view; laid out like the main conversation, never as a tool tab. */
export const PEER_PANE = 'chat-peer'
/** Further conversations of a split view (up to five tiles in all): `chat-peer-2`, `chat-peer-3`, ... */
export const isConversationPane = (id: string): boolean => id === CHAT_PANE || id === PEER_PANE || /^chat-peer-\d+$/.test(id)
/** Pane id of the n-th conversation tile (0 is the main conversation). */
export const conversationPaneId = (index: number): string => index <= 0 ? CHAT_PANE : index === 1 ? PEER_PANE : `${PEER_PANE}-${index}`
/** Gap between tiles; the gap doubles as the resize separator. */
export const DOCK_GAP = 8
export const DOCK_MIN_CHAT = 340
export const DOCK_MIN_TOOL = 200
const group = (id: string, panes: string[]): DockNode => ({ type: 'group', id, panes, active: panes[0] })
const uid = (): string => crypto.randomUUID()
/** The default workspace is the main conversation alone; tools open beside it on demand. */
export function defaultWorkspaceLayout(): WorkspaceLayout {
  return { version: 1, root: group('conversation', [CHAT_PANE]), hidden: [] }
}
export function dockGroups(node: DockNode): Extract<DockNode, { type: 'group' }>[] {
  return node.type === 'group' ? [node] : [...dockGroups(node.first), ...dockGroups(node.second)]
}
function mapNode(node: DockNode, fn: (node: DockNode) => DockNode): DockNode {
  return fn(node.type === 'split' ? { ...node, first: mapNode(node.first, fn), second: mapNode(node.second, fn) } : node)
}
function removePane(node: DockNode, pane: string): DockNode | null {
  if (node.type === 'group') {
    const panes = node.panes.filter(id => id !== pane)
    return panes.length ? { ...node, panes, active: panes.includes(node.active) ? node.active : panes[0] } : null
  }
  const first = removePane(node.first, pane), second = removePane(node.second, pane)
  return first && second ? { ...node, first, second } : first ?? second
}
const conversationCount = (n: DockNode): number => n.type === 'group' ? n.panes.filter(isConversationPane).length : conversationCount(n.first) + conversationCount(n.second)
const onlyConversations = (n: DockNode): boolean => n.type === 'group' ? n.panes.every(isConversationPane) : onlyConversations(n.first) && onlyConversations(n.second)
/** Wrap the widest all-conversation subtree around the main conversation, so k tiles end up with equal widths. */
function addConversation(root: DockNode, pane: string): DockNode {
  const wrap = (n: DockNode): DockNode => {
    if (!holdsChat(n)) return n
    if (onlyConversations(n)) {
      const k = conversationCount(n)
      return { type: 'split', id: uid(), axis: 'x', ratio: k / (k + 1), first: n, second: group(uid(), [pane]) }
    }
    return n.type === 'split' ? { ...n, first: wrap(n.first), second: wrap(n.second) } : n
  }
  return wrap(root)
}
export function openDockPane(layout: WorkspaceLayout, pane: string): WorkspaceLayout {
  const existing = dockGroups(layout.root).find(g => g.panes.includes(pane))
  let root = layout.root
  if (existing) root = mapNode(root, n => n.type === 'group' && n.id === existing.id ? { ...n, active: pane } : n)
  else if (isConversationPane(pane)) {
    /* Another conversation joins the row of conversations at an even share; tools stay where they were. */
    root = addConversation(root, pane)
  } else {
    const candidates = dockGroups(root).filter(g => !g.panes.some(isConversationPane))
    const kind = pane.split(':')[0]
    const target = candidates.find(g => g.panes.some(id => id.split(':')[0] === kind)) ?? candidates.find(g => g.panes.includes('tools')) ?? candidates.at(-1)
    root = target ? mapNode(root, n => n.type === 'group' && n.id === target.id ? { ...n, panes: [...n.panes, pane], active: pane } : n)
      : { type: 'split', id: uid(), axis: 'x', ratio: .65, first: root, second: group(uid(), [pane]) }
  }
  const previousMaxGroup = dockGroups(layout.root).find(g => g.panes.includes(layout.maximized ?? ''))
  return { ...layout, root, hidden: layout.hidden.filter(id => id !== pane), maximized: layout.maximized && existing?.id === previousMaxGroup?.id ? pane : undefined }
}
/** The arrangement with one pane lifted out; drag targets are measured on it so they stay still while tiles reflow. */
export function withoutDockPane(layout: WorkspaceLayout, pane: string): WorkspaceLayout {
  const root = removePane(layout.root, pane)
  return root ? { ...layout, root, maximized: undefined } : layout
}
export function hideDockPane(layout: WorkspaceLayout, pane: string): WorkspaceLayout {
  if (isConversationPane(pane)) return layout
  const root = mapNode(layout.root, n => {
    if (n.type !== 'group' || n.active !== pane) return n
    return { ...n, active: n.panes.find(id => id !== pane && !layout.hidden.includes(id)) ?? pane }
  })
  return { ...layout, root, hidden: [...new Set([...layout.hidden, pane])], maximized: layout.maximized === pane ? undefined : layout.maximized }
}
/** The size the moved pane already has along the new split, and the length of the target it splits. */
export interface DockKeep { size: number; extent: number }
/** With `keep`, the moved pane lands at the size it had instead of half of the target. */
export function moveDockPane(layout: WorkspaceLayout, pane: string, targetId: string, edge: DockEdge, keep?: DockKeep): WorkspaceLayout {
  const groups = dockGroups(layout.root), source = groups.find(g => g.panes.includes(pane)), target = groups.find(g => g.id === targetId)
  if (!source || !target || (source.id === targetId && (source.panes.length === 1 || edge === 'center'))) return layout
  if (edge === 'center' && (isConversationPane(pane) || target.panes.some(isConversationPane))) return layout
  const removed = removePane(layout.root, pane)
  if (!removed) return layout
  const root = mapNode(removed, n => {
    if (n.type !== 'group' || n.id !== targetId) return n
    if (edge === 'center') return { ...n, panes: [...n.panes, pane], active: pane }
    const newGroup = group(uid(), [pane]), before = edge === 'left' || edge === 'top'
    const share = keep && keep.extent > DOCK_GAP ? Math.max(.1, Math.min(.9, keep.size / (keep.extent - DOCK_GAP))) : .5
    return { type: 'split', id: uid(), axis: edge === 'left' || edge === 'right' ? 'x' : 'y', ratio: before ? share : 1 - share, first: before ? newGroup : n, second: before ? n : newGroup }
  })
  return { ...layout, root, maximized: undefined, hidden: layout.hidden.filter(id => id !== pane) }
}
export function resizeDockSplit(layout: WorkspaceLayout, id: string, ratio: number): WorkspaceLayout {
  return { ...layout, root: mapNode(layout.root, n => n.type === 'split' && n.id === id ? { ...n, ratio: Math.max(.1, Math.min(.9, ratio)) } : n) }
}
const holdsChat = (n: DockNode): boolean => n.type === 'group' ? n.panes.includes(CHAT_PANE) : holdsChat(n.first) || holdsChat(n.second)
/** Re-express the ratios at the current size so the arrangement on screen becomes the new basis. */
export function rebaseDockLayout(layout: WorkspaceLayout, available: Set<string>, width: number, height: number): WorkspaceLayout {
  if (layout.maximized) return layout
  const measured = measureDockLayout(layout, available, width, height)
  const shares = new Map(measured.separators.map(s => [s.id, s.ratio]))
  return { ...layout, root: mapNode(layout.root, n => n.type === 'split' && shares.has(n.id) ? { ...n, ratio: shares.get(n.id)! } : n), basis: { w: measured.width, h: measured.height } }
}
/** Validate persisted data defensively, with depth/node limits and unique resource references. */
export function normalizeWorkspaceLayout(value: unknown): WorkspaceLayout {
  const fallback = defaultWorkspaceLayout()
  if (!value || typeof value !== 'object' || (value as WorkspaceLayout).version !== 1) return fallback
  const input = value as WorkspaceLayout, panes = new Set<string>(), nodes = new Set<string>()
  let count = 0
  const read = (raw: unknown, depth = 0): DockNode | null => {
    if (!raw || typeof raw !== 'object' || depth > 24 || ++count > 128) return null
    const n = raw as DockNode
    if (typeof n.id !== 'string' || nodes.has(n.id)) return null
    nodes.add(n.id)
    if (n.type === 'group' && Array.isArray(n.panes)) {
      const valid = n.panes.filter(id => typeof id === 'string' && id.length < 2048 && !panes.has(id) && !!panes.add(id))
      if (!valid.length) return null
      // Main conversation can never be concealed behind a tool label.
      if (valid.includes(CHAT_PANE) && valid.length > 1) {
        return { type: 'split', id: uid(), axis: 'x', ratio: .65, first: group(n.id, [CHAT_PANE]), second: group(uid(), valid.filter(id => id !== CHAT_PANE)) }
      }
      return { type: 'group', id: n.id, panes: valid, active: valid.includes(n.active) ? n.active : valid[0] }
    }
    if (n.type === 'split') {
      const first = read(n.first, depth + 1), second = read(n.second, depth + 1)
      if (!first || !second) return first ?? second
      return { type: 'split', id: n.id, axis: n.axis === 'y' ? 'y' : 'x', ratio: Number.isFinite(n.ratio) ? Math.max(.02, Math.min(.98, n.ratio)) : .5, first, second }
    }
    return null
  }
  let root = read(input.root)
  if (!root) return fallback
  if (!panes.has(CHAT_PANE)) root = { type: 'split', id: uid(), axis: 'x', ratio: .65, first: group(uid(), [CHAT_PANE]), second: root }
  return { version: 1, root, hidden: Array.isArray(input.hidden) ? input.hidden.filter(id => typeof id === 'string' && id !== CHAT_PANE && panes.has(id)) : [], maximized: typeof input.maximized === 'string' && panes.has(input.maximized) ? input.maximized : undefined, ...(validBasis(input.basis) ? { basis: { w: input.basis.w, h: input.basis.h } } : {}) }
}
const validBasis = (b: unknown): b is { w: number; h: number } => !!b && typeof b === 'object' && [(b as { w: unknown }).w, (b as { h: unknown }).h].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100000)
export function measureDockLayout(layout: WorkspaceLayout, available: Set<string>, width: number, height: number): { groups: DockGroupRect[]; separators: DockSeparator[]; width: number; height: number } {
  const groups: DockGroupRect[] = [], separators: DockSeparator[] = []
  const visible = (n: DockNode): boolean => n.type === 'group' ? n.panes.some(id => available.has(id) && !layout.hidden.includes(id)) : visible(n.first) || visible(n.second)
  const minimum = (n: DockNode): [number, number] => {
    if (!visible(n)) return [0, 0]
    if (n.type === 'group') return [n.panes.some(isConversationPane) ? DOCK_MIN_CHAT : DOCK_MIN_TOOL, 180]
    const a = minimum(n.first), b = minimum(n.second)
    if (!a[0]) return b
    if (!b[0]) return a
    return n.axis === 'x' ? [a[0] + b[0] + DOCK_GAP, Math.max(a[1], b[1])] : [Math.max(a[0], b[0]), a[1] + b[1] + DOCK_GAP]
  }
  /* `b` is the same node laid out at the basis size; it tells how many pixels the tool side had. */
  const walk = (n: DockNode, r: DockRect, b: DockRect): void => {
    if (!visible(n)) return
    if (n.type === 'group') { groups.push({ ...r, group: n }); return }
    if (!visible(n.first)) { walk(n.second, r, b); return }
    if (!visible(n.second)) { walk(n.first, r, b); return }
    const a = minimum(n.first), c = minimum(n.second), horizontal = n.axis === 'x'
    const minFirst = horizontal ? a[0] : a[1], minSecond = horizontal ? c[0] : c[1]
    const clamp = (total: number, want: number) => Math.max(minFirst, Math.min(total - minSecond, want))
    const total = (horizontal ? r.w : r.h) - DOCK_GAP, basisTotal = (horizontal ? b.w : b.h) - DOCK_GAP
    const basisSize = clamp(basisTotal, basisTotal * n.ratio)
    const chatFirst = holdsChat(n.first)
    const want = !layout.basis || chatFirst === holdsChat(n.second) ? total * n.ratio : chatFirst ? total - (basisTotal - basisSize) : basisSize
    const size = clamp(total, want)
    const first = horizontal ? { ...r, w: size } : { ...r, h: size }
    const separator = horizontal ? { ...r, x: r.x + size, w: DOCK_GAP } : { ...r, y: r.y + size, h: DOCK_GAP }
    const second = horizontal ? { ...r, x: r.x + size + DOCK_GAP, w: total - size } : { ...r, y: r.y + size + DOCK_GAP, h: total - size }
    const basisFirst = horizontal ? { ...b, w: basisSize } : { ...b, h: basisSize }
    const basisSecond = horizontal ? { ...b, x: b.x + basisSize + DOCK_GAP, w: basisTotal - basisSize } : { ...b, y: b.y + basisSize + DOCK_GAP, h: basisTotal - basisSize }
    /* The reported ratio is the share on screen, which is what keyboard nudges and rebasing start from. */
    separators.push({ ...separator, id: n.id, axis: n.axis, ratio: total > 0 ? size / total : n.ratio, bounds: r })
    walk(n.first, first, basisFirst); walk(n.second, second, basisSecond)
  }
  const min = minimum(layout.root), w = Math.max(width, min[0]), h = Math.max(height, min[1])
  const basis = layout.basis ? { x: 0, y: 0, w: Math.max(layout.basis.w, min[0]), h: Math.max(layout.basis.h, min[1]) } : { x: 0, y: 0, w, h }
  if (layout.maximized && available.has(layout.maximized) && !layout.hidden.includes(layout.maximized)) {
    const g = dockGroups(layout.root).find(g => g.panes.includes(layout.maximized!))
    if (g) groups.push({ x: 0, y: 0, w: width, h: height, group: { ...g, active: layout.maximized } })
    return { groups, separators, width, height }
  }
  walk(layout.root, { x: 0, y: 0, w, h }, basis)
  return { groups, separators, width: w, height: h }
}
