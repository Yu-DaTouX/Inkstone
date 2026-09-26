/**
 * 会话地图的**纯逻辑**（实施-18 S1）。
 *
 * 从 `SessionSummary[]` 投影出泳道 / 节点 / 边 / 折叠簇 —— 不碰 DOM、
 * 不读 Electron、不写任何持久化。渲染（`SessionMap.tsx`）只负责把这里
 * 的结果摆到屏幕上，所以形态调整（D1/D2）不会波及数据层。
 *
 * 结构约定：
 *   · 泳道（lane）= 项目（`project:<id>`）或「全局 / 未归类」（`global`）；
 *   · 列 = 分支深度（`parentSession` 链，根为 0）；
 *   · 边 = 父子关系，只连接两端都可见的节点。
 */

import type { SessionSummary } from './ipc'

/** 超过这个节点数就折叠 —— 真机验证过上千条会话不能整体直出。 */
export const SESSION_MAP_MAX_NODES = 300

/** 深度上限：异常的父子链不在这里递归到栈溢出。 */
const MAX_DEPTH = 64

export interface SessionMapNode {
  path: string
  id: string
  title: string
  /** 所属泳道：`project:<id>` 或 `global`。 */
  laneKey: string
  projectId?: string
  /** 分支深度；父节点不可见 / 缺父时归 0。 */
  depth: number
  /** 泳道内可见节点的排列序号（0 起）。 */
  row: number
  parentPath?: string
  /** 全量（含被折叠节点）的直接子会话数。 */
  childCount: number
  /** 在父节点之下按 createdAt 升序排第几（1 起）；无父则 undefined。 */
  branchIndex?: number
  lastActivityAt: number
  messageCount: number
  running: boolean
  unread: boolean
  pinned: boolean
  current: boolean
  /** 父会话缺失（被删除 / 迁移中）——已提升为根。 */
  orphan: boolean
  /** 深度过深被截断，或可见父被折叠。 */
  truncated: boolean
}

export interface SessionMapEdge {
  from: string
  to: string
  /** 子节点深度，渲染时用于分层。 */
  depth: number
}

export interface SessionMapCluster {
  id: string
  laneKey: string
  count: number
  paths: string[]
}

export interface SessionMapLane {
  key: string
  projectId?: string
  nodes: SessionMapNode[]
  clusters: SessionMapCluster[]
  /** 该泳道节点总数（含被折叠）。 */
  total: number
}

export interface SessionMapResult {
  lanes: SessionMapLane[]
  /** 可见节点（展平，供渲染与键盘遍历）。 */
  nodes: SessionMapNode[]
  edges: SessionMapEdge[]
  clusters: SessionMapCluster[]
  stats: {
    total: number
    shown: number
    folded: number
    laneCount: number
    maxDepth: number
  }
}

export interface SessionMapInput {
  sessions: SessionSummary[]
  currentPath?: string
  pinned?: readonly string[]
  unread?: readonly string[]
  running?: readonly string[]
  /** 当前项目：它的泳道排在最前。 */
  currentProjectId?: string
  maxNodes?: number
  /** 用户显式展开的泳道（点击折叠簇）——这些泳道不参与折叠。 */
  expandLanes?: readonly string[]
}

export interface BranchIndex {
  /** path → 直接子会话数 */
  branchCount: Map<string, number>
  /** path → 在父之下按 createdAt 的第几个分支（1 起） */
  branchIndex: Map<string, number>
  /** path → 子会话列表（按 createdAt 升序） */
  branchesOf: Map<string, SessionSummary[]>
}

/**
 * 分支编号（从 `Rail.tsx` 下沉）。
 *
 * 编号按 `createdAt` 升序 —— 与分支创建的先后一致。
 */
export function buildBranchIndex(sessions: readonly SessionSummary[]): BranchIndex {
  const branchCount = new Map<string, number>()
  const branchIndex = new Map<string, number>()
  const branchesOf = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    if (!s.parentSession) continue
    const arr = branchesOf.get(s.parentSession) ?? []
    arr.push(s)
    branchesOf.set(s.parentSession, arr)
  }
  for (const [parent, list] of branchesOf) {
    list.sort((a, b) => a.createdAt - b.createdAt)
    branchCount.set(parent, list.length)
    list.forEach((s, i) => branchIndex.set(s.path, i + 1))
  }
  return { branchCount, branchIndex, branchesOf }
}

function laneKeyOf(s: SessionSummary): string {
  return s.projectId ? `project:${s.projectId}` : 'global'
}

function activityOf(s: SessionSummary): number {
  return s.lastActivityAt ?? s.createdAt ?? 0
}

/**
 * 自底向上算深度，带环与过深防御。
 *
 * 返回的 `truncated` 表示这条链在到达真根之前就断了（遇到环 / 超过
 * `MAX_DEPTH`），渲染时标注、不假装它是根会话。
 */
function resolveDepth(
  path: string,
  byPath: Map<string, SessionSummary>,
  memo: Map<string, { depth: number; truncated: boolean }>,
  stack: Set<string>
): { depth: number; truncated: boolean } {
  const cached = memo.get(path)
  if (cached) return cached
  if (stack.has(path)) return { depth: 0, truncated: true }
  const node = byPath.get(path)
  const parent = node?.parentSession
  if (!parent || !byPath.has(parent)) {
    const resolved = { depth: 0, truncated: false }
    memo.set(path, resolved)
    return resolved
  }
  if (stack.size >= MAX_DEPTH) return { depth: 0, truncated: true }
  stack.add(path)
  const up = resolveDepth(parent, byPath, memo, stack)
  stack.delete(path)
  const resolved = up.truncated
    ? { depth: 0, truncated: true }
    : { depth: up.depth + 1, truncated: false }
  memo.set(path, resolved)
  return resolved
}

/**
 * 构建会话地图。
 *
 * 折叠规则：节点总数超过阈值时，按最近活动全局排序保留可见节点，
 * 其余归入所属泳道的「簇」。被折叠节点的子节点若仍可见，会提升为
 * 顶层（`truncated: true`），边只连接两端都可见的父子。
 */
export function buildSessionMap(input: SessionMapInput): SessionMapResult {
  const maxNodes = Math.max(1, input.maxNodes ?? SESSION_MAP_MAX_NODES)
  const expandLanes = new Set(input.expandLanes ?? [])
  const pinned = new Set(input.pinned ?? [])
  const unread = new Set(input.unread ?? [])
  const running = new Set(input.running ?? [])

  const byPath = new Map<string, SessionSummary>()
  for (const s of input.sessions) byPath.set(s.path, s)

  const { branchCount, branchIndex } = buildBranchIndex(input.sessions)

  // 可见集合：不超阈值就全要；超了按最近活动保留 maxNodes 个，每个泳道至少 1 个。
  const ordered = [...input.sessions].sort((a, b) => activityOf(b) - activityOf(a))
  let visible: Set<string>
  if (ordered.length <= maxNodes) {
    visible = new Set(ordered.map((s) => s.path))
  } else {
    visible = new Set<string>()
    /* 用户展开的泳道整条保留，不占其它泳道的预算 */
    for (const s of input.sessions) {
      if (expandLanes.has(laneKeyOf(s))) visible.add(s.path)
    }
    const laneSeen = new Set<string>(expandLanes)
    for (const s of ordered) {
      if (visible.size >= maxNodes) break
      const key = laneKeyOf(s)
      if (laneSeen.has(key)) continue
      laneSeen.add(key)
      visible.add(s.path)
    }
    for (const s of ordered) {
      if (visible.size >= maxNodes) break
      visible.add(s.path)
    }
  }

  const depthMemo = new Map<string, { depth: number; truncated: boolean }>()
  const nodes: SessionMapNode[] = []
  const hidden: SessionSummary[] = []

  for (const s of input.sessions) {
    if (!visible.has(s.path)) {
      hidden.push(s)
      continue
    }
    const parent = s.parentSession && byPath.has(s.parentSession) ? s.parentSession : undefined
    const resolved = resolveDepth(s.path, byPath, depthMemo, new Set())
    const visibleParent = parent && visible.has(parent) ? parent : undefined
    nodes.push({
      path: s.path,
      id: s.id,
      title: s.title,
      laneKey: laneKeyOf(s),
      projectId: s.projectId,
      depth: resolved.truncated ? 0 : resolved.depth,
      row: 0,
      parentPath: visibleParent,
      childCount: branchCount.get(s.path) ?? 0,
      branchIndex: parent ? branchIndex.get(s.path) : undefined,
      lastActivityAt: activityOf(s),
      messageCount: s.messageCount,
      running: running.has(s.path),
      unread: unread.has(s.path),
      pinned: pinned.has(s.path),
      current: s.path === input.currentPath,
      orphan: Boolean(s.parentSession && !byPath.has(s.parentSession)),
      truncated: resolved.truncated || Boolean(parent && !visibleParent)
    })
  }

  // 泳道排序：当前项目优先，然后按泳道最近活动。
  const laneMap = new Map<string, SessionMapNode[]>()
  for (const n of nodes) {
    const arr = laneMap.get(n.laneKey) ?? []
    arr.push(n)
    laneMap.set(n.laneKey, arr)
  }
  const laneActivity = (key: string): number => {
    const arr = laneMap.get(key) ?? []
    return arr.reduce((m, n) => Math.max(m, n.lastActivityAt), 0)
  }
  const laneKeys = [...laneMap.keys()].sort((a, b) => {
    const aCurrent = input.currentProjectId && a === `project:${input.currentProjectId}`
    const bCurrent = input.currentProjectId && b === `project:${input.currentProjectId}`
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1
    return laneActivity(b) - laneActivity(a)
  })

  /*
   * 泳道内排序：根按活动降序，随后是它的子会话（按 createdAt，
   * 与分支创建的先后一致）。这样每一列都是「父在上、子紧随其后」。
   */
  const lanes: SessionMapLane[] = []
  for (const key of laneKeys) {
    const arr = laneMap.get(key) ?? []
    const byParent = new Map<string, SessionMapNode[]>()
    const roots: SessionMapNode[] = []
    for (const n of arr) {
      if (n.parentPath) {
        const kids = byParent.get(n.parentPath) ?? []
        kids.push(n)
        byParent.set(n.parentPath, kids)
      } else {
        roots.push(n)
      }
    }
    roots.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    for (const kids of byParent.values()) {
      kids.sort((a, b) => (byPath.get(a.path)?.createdAt ?? 0) - (byPath.get(b.path)?.createdAt ?? 0))
    }
    /* 环防御：走不到的节点在最后补上，不静默丢节点 */
    const ordered: SessionMapNode[] = []
    const seen = new Set<string>()
    const walk = (n: SessionMapNode): void => {
      if (seen.has(n.path)) return
      seen.add(n.path)
      ordered.push(n)
      for (const c of byParent.get(n.path) ?? []) walk(c)
    }
    for (const r of roots) walk(r)
    for (const n of arr) walk(n)
    ordered.forEach((n, i) => {
      n.row = i
    })
    const clusters = buildLaneClusters(key, hidden)
    lanes.push({
      key,
      projectId: arr.find((n) => n.projectId)?.projectId,
      nodes: ordered,
      clusters,
      total: ordered.length + clusters.reduce((n, c) => n + c.count, 0)
    })
  }

  const edges: SessionMapEdge[] = []
  for (const n of nodes) {
    if (n.parentPath) edges.push({ from: n.parentPath, to: n.path, depth: n.depth })
  }

  const clusters = [...hidden.reduce((map, s) => {
    const key = laneKeyOf(s)
    const c = map.get(key) ?? { id: `cluster:${key}`, laneKey: key, count: 0, paths: [] }
    c.count += 1
    c.paths.push(s.path)
    map.set(key, c)
    return map
  }, new Map<string, SessionMapCluster>()).values()]

  for (const c of clusters) {
    if (lanes.some((l) => l.key === c.laneKey)) continue
    // 某个泳道全部被折叠时，也要给它一条空泳道承载簇。
    lanes.push({ key: c.laneKey, projectId: byPath.get(c.paths[0])?.projectId, nodes: [], clusters: [c], total: c.count })
  }

  return {
    lanes,
    nodes,
    edges,
    clusters,
    stats: {
      total: input.sessions.length,
      shown: nodes.length,
      folded: hidden.length,
      laneCount: lanes.length,
      maxDepth: nodes.reduce((m, n) => Math.max(m, n.depth), 0)
    }
  }
}

function buildLaneClusters(laneKey: string, hidden: readonly SessionSummary[]): SessionMapCluster[] {
  const paths = hidden.filter((s) => laneKeyOf(s) === laneKey).map((s) => s.path)
  if (!paths.length) return []
  return [{ id: `cluster:${laneKey}`, laneKey, count: paths.length, paths }]
}
