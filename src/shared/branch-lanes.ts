import { describeEntry, type NativeEntryKind, type NativeTreeNode } from './native-session'

export interface BranchLaneRow {
  entryId: string
  targetId: string
  parentRow: number | null
  lane: number
  kind: NativeEntryKind
  text: string
  label?: string
  steps: number
  leaf: boolean
  active: boolean
  fork: boolean
}

export interface BranchLaneEdge {
  from: number
  to: number
  fromLane: number
  toLane: number
  active: boolean
}

export interface BranchLanes {
  rows: BranchLaneRow[]
  edges: BranchLaneEdge[]
  lanes: number
}

const ANCHOR_KINDS: ReadonlySet<NativeEntryKind> = new Set(['user', 'branch', 'summary'])
const STEP_KINDS: ReadonlySet<NativeEntryKind> = new Set(['assistant', 'tool', 'custom', 'system'])
const PREAMBLE_KINDS: ReadonlySet<NativeEntryKind> = new Set(['meta', 'label', 'usage', 'unknown', 'system'])

function skipPreamble(node: NativeTreeNode, leafId: string | null): NativeTreeNode | null {
  let at = node
  const seen = new Set<string>()
  while (PREAMBLE_KINDS.has(describeEntry(at.entry).kind) && at.entry.id !== leafId) {
    if (seen.has(at.entry.id)) return null
    if ((at.children?.length ?? 0) !== 1) return at.children?.length ? at : null
    seen.add(at.entry.id)
    at = at.children[0]
  }
  return PREAMBLE_KINDS.has(describeEntry(at.entry).kind) && !at.children?.length ? null : at
}

interface Indexed {
  node: NativeTreeNode
  parent: NativeTreeNode | null
}

function indexTree(tree: readonly NativeTreeNode[]): Map<string, Indexed> {
  const byId = new Map<string, Indexed>()
  const stack: Indexed[] = tree.map((node) => ({ node, parent: null }))
  while (stack.length) {
    const item = stack.pop()!
    const id = item.node.entry?.id
    if (typeof id !== 'string' || byId.has(id)) continue
    byId.set(id, item)
    for (const child of item.node.children ?? []) stack.push({ node: child, parent: item.node })
  }
  return byId
}

export function buildBranchLanes(tree: readonly NativeTreeNode[], leafId: string | null): BranchLanes {
  const byId = indexTree(tree)
  const activePath = new Set<string>()
  for (let id = leafId; id && byId.has(id); id = byId.get(id)!.parent?.entry.id ?? null) {
    if (activePath.has(id)) break
    activePath.add(id)
  }

  const substantial = new Map<string, boolean>()
  const worthShowing = (node: NativeTreeNode): boolean => {
    const known = substantial.get(node.entry.id)
    if (known !== undefined) return known
    const pending: NativeTreeNode[] = [node]
    const seen = new Set<string>()
    let found = false
    while (pending.length && !found) {
      const at = pending.pop()!
      if (seen.has(at.entry.id)) continue
      seen.add(at.entry.id)
      if (at.entry.id === leafId || !PREAMBLE_KINDS.has(describeEntry(at.entry).kind)) found = true
      else pending.push(...(at.children ?? []))
    }
    substantial.set(node.entry.id, found)
    return found
  }
  const kidsOf = (node: NativeTreeNode): NativeTreeNode[] => (node.children ?? []).filter(worthShowing)

  const isAnchor = (node: NativeTreeNode, parent: NativeTreeNode | null): boolean => {
    if (!parent) return true
    if (kidsOf(parent).length > 1) return true
    if (parent.entry.id === leafId) return true
    if (node.label) return true
    return ANCHOR_KINDS.has(describeEntry(node.entry).kind)
  }

  const rows: BranchLaneRow[] = []
  const visited = new Set<string>()
  const ordered = (children: readonly NativeTreeNode[]): NativeTreeNode[] => {
    const onPath = children.filter((child) => activePath.has(child.entry.id))
    return [...children.filter((child) => !activePath.has(child.entry.id)), ...onPath]
  }

  type Frame = { node: NativeTreeNode; parentRow: number | null }
  const starts = tree.map((node) => skipPreamble(node, leafId)).filter((node): node is NativeTreeNode => !!node)
  const stack: Frame[] = starts.reverse().map((node) => ({ node, parentRow: null }))
  while (stack.length) {
    const { node, parentRow } = stack.pop()!
    if (visited.has(node.entry.id)) continue
    let end = node
    let steps = 0
    let leaf = node.entry.id === leafId
    let label = node.label
    visited.add(node.entry.id)
    while (end.entry.id !== leafId && kidsOf(end).length === 1) {
      const next = kidsOf(end)[0]
      if (visited.has(next.entry.id) || isAnchor(next, end)) break
      visited.add(next.entry.id)
      end = next
      if (STEP_KINDS.has(describeEntry(next.entry).kind)) steps += 1
      if (next.entry.id === leafId) leaf = true
      label ??= next.label
    }
    const description = describeEntry(node.entry)
    const kids = kidsOf(end)
    const index = rows.length
    rows.push({
      entryId: node.entry.id,
      targetId: end.entry.id,
      parentRow,
      lane: 0,
      kind: description.kind,
      text: description.text,
      ...(label ? { label } : {}),
      steps,
      leaf,
      active: activePath.has(node.entry.id),
      fork: kids.length > 1
    })
    const next = ordered(kids).map((kid) => skipPreamble(kid, leafId) ?? kid)
    for (let i = next.length - 1; i >= 0; i -= 1) stack.push({ node: next[i], parentRow: index })
  }

  const childrenOf = new Map<number, number[]>()
  rows.forEach((row, index) => {
    if (row.parentRow === null) return
    const list = childrenOf.get(row.parentRow) ?? []
    list.push(index)
    childrenOf.set(row.parentRow, list)
  })
  const continues = new Set<number>()
  for (const list of childrenOf.values()) continues.add(list[list.length - 1])

  const chains: Array<{ rows: number[]; start: number }> = []
  rows.forEach((row, index) => {
    if (row.parentRow !== null && continues.has(index)) return
    const chain = [index]
    for (let at = index; ; ) {
      const list = childrenOf.get(at)
      if (!list?.length) break
      at = list[list.length - 1]
      chain.push(at)
    }
    chains.push({ rows: chain, start: row.parentRow ?? index })
  })
  chains.sort((a, b) => a.start - b.start || a.rows[0] - b.rows[0])
  const laneEnds: number[] = []
  const place = (chain: { rows: number[] }, lane: number): void => {
    laneEnds[lane] = chain.rows[chain.rows.length - 1]
    for (const index of chain.rows) rows[index].lane = lane
  }
  const trunk = chains.find((chain) => rows[chain.rows[0]].parentRow === null && chain.rows.some((index) => rows[index].leaf))
  if (trunk) place(trunk, 0)
  for (const chain of chains) {
    if (chain === trunk) continue
    let lane = trunk ? 1 : 0
    while (lane < laneEnds.length && laneEnds[lane] >= chain.start) lane += 1
    place(chain, lane)
  }

  const edges: BranchLaneEdge[] = []
  rows.forEach((row, index) => {
    if (row.parentRow === null) return
    const parent = rows[row.parentRow]
    edges.push({ from: row.parentRow, to: index, fromLane: parent.lane, toLane: row.lane, active: parent.active && row.active })
  })
  return { rows, edges, lanes: Math.max(1, laneEnds.length) }
}
