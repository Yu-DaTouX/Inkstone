import type { SessionSummary } from './ipc'

export const SESSION_MAP_MAX_NODES = 300

const MAX_DEPTH = 64

export interface SessionMapNode {
  path: string
  id: string
  title: string
  laneKey: string
  projectId?: string
  depth: number
  row: number
  parentPath?: string
  childCount: number
  branchIndex?: number
  lastActivityAt: number
  messageCount: number
  running: boolean
  unread: boolean
  pinned: boolean
  current: boolean
  orphan: boolean
  truncated: boolean
}

export interface SessionMapEdge {
  from: string
  to: string
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
  total: number
}

export interface SessionMapResult {
  lanes: SessionMapLane[]
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
  currentProjectId?: string
  maxNodes?: number
  expandLanes?: readonly string[]
}

export interface BranchIndex {
  branchCount: Map<string, number>
  branchIndex: Map<string, number>
  branchesOf: Map<string, SessionSummary[]>
}

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

export function buildSessionMap(input: SessionMapInput): SessionMapResult {
  const maxNodes = Math.max(1, input.maxNodes ?? SESSION_MAP_MAX_NODES)
  const expandLanes = new Set(input.expandLanes ?? [])
  const pinned = new Set(input.pinned ?? [])
  const unread = new Set(input.unread ?? [])
  const running = new Set(input.running ?? [])

  const byPath = new Map<string, SessionSummary>()
  for (const s of input.sessions) byPath.set(s.path, s)

  const { branchCount, branchIndex } = buildBranchIndex(input.sessions)

  const ordered = [...input.sessions].sort((a, b) => activityOf(b) - activityOf(a))
  let visible: Set<string>
  if (ordered.length <= maxNodes) {
    visible = new Set(ordered.map((s) => s.path))
  } else {
    visible = new Set<string>()
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
