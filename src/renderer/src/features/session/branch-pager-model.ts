import {
  NATIVE_TREE_MAX_DEPTH,
  NATIVE_TREE_MAX_ROWS,
  describeEntry,
  type NativeTreeNode
} from '../../../../shared/native-session'
import type { NativeSessionHostRequest, NativeSessionHostResult } from '../../../../shared/native-session-host'

export interface BranchPagerModel {
  entryId: string
  forkId: string
  index: number
  count: number
  prevTargetId: string
  nextTargetId: string
  onActivePath: boolean
}

export type BranchPagerRequest = (request: NativeSessionHostRequest) => Promise<NativeSessionHostResult>

type BranchPagerTreeLoad =
  | { ok: true; tree: NativeTreeNode[]; leafId: string | null }
  | { ok: false; error: string }

interface BranchPagerActionResult {
  ok: boolean
  error?: string
}

export async function loadPagerTree(
  transport: BranchPagerRequest,
  expectedSessionId: string,
  fallbackError: string
): Promise<BranchPagerTreeLoad> {
  try {
    const result = await transport({ action: 'tree', expectedSessionId })
    if (!result || !result.ok) return { ok: false, error: result?.error || fallbackError }
    const tree = Array.isArray(result.tree) ? (result.tree as NativeTreeNode[]) : []
    const leafId = typeof result.leafId === 'string' && result.leafId ? result.leafId : null
    return { ok: true, tree, leafId }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function navigatePagerBranch(
  transport: BranchPagerRequest,
  expectedSessionId: string,
  entryId: string,
  fallbackError: string
): Promise<BranchPagerActionResult> {
  try {
    const result = await transport({ action: 'navigate', expectedSessionId, entryId })
    if (!result || !result.ok) return { ok: false, error: result?.error || fallbackError }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

interface TreeIndex {
  byId: Map<string, NativeTreeNode>
  parentOf: Map<string, string | null>
  childIdsOf: Map<string, string[]>
  hasMessage: Map<string, boolean>
  active: Set<string>
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nodeId(node: unknown): string | null {
  const record = recordOf(node)
  const entry = record ? recordOf(record.entry) : null
  const id = entry?.id
  return typeof id === 'string' && id ? id : null
}

function childrenOf(node: unknown): NativeTreeNode[] {
  const record = recordOf(node)
  const children = record?.children
  if (!Array.isArray(children)) return []
  return children.filter((child): child is NativeTreeNode => {
    const item = recordOf(child)
    return !!item && !!recordOf(item.entry)
  }) as NativeTreeNode[]
}

function hasConversation(kind: string): boolean {
  return kind === 'user' || kind === 'assistant'
}

function buildTreeIndex(tree: readonly NativeTreeNode[], leafId: string | null): TreeIndex {
  const byId = new Map<string, NativeTreeNode>()
  const parentOf = new Map<string, string | null>()
  const order: string[] = []
  const nodeCap = NATIVE_TREE_MAX_ROWS * 8
  const visit = (nodes: readonly NativeTreeNode[], parentId: string | null, depth: number): void => {
    if (depth > NATIVE_TREE_MAX_DEPTH) return
    for (const node of nodes) {
      if (byId.size >= nodeCap) return
      const id = nodeId(node)
      if (!id || byId.has(id)) continue
      byId.set(id, node)
      parentOf.set(id, parentId)
      order.push(id)
      visit(childrenOf(node), id, depth + 1)
    }
  }
  visit(tree, null, 0)

  const childIdsOf = new Map<string, string[]>()
  for (const id of order) {
    const node = byId.get(id)
    const ids: string[] = []
    if (node) {
      for (const child of childrenOf(node)) {
        const childId = nodeId(child)
        if (childId && byId.has(childId)) ids.push(childId)
      }
    }
    childIdsOf.set(id, ids)
  }

  const hasMessage = new Map<string, boolean>()
  const visiting = new Set<string>()
  const compute = (id: string): boolean => {
    const cached = hasMessage.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return false
    visiting.add(id)
    const node = byId.get(id)
    const kind = node ? describeEntry(node.entry).kind : 'unknown'
    let hit = hasConversation(kind)
    if (!hit) {
      for (const childId of childIdsOf.get(id) ?? []) {
        if (compute(childId)) {
          hit = true
          break
        }
      }
    }
    visiting.delete(id)
    hasMessage.set(id, hit)
    return hit
  }
  for (const id of order) compute(id)

  const active = new Set<string>()
  const seenActive = new Set<string>()
  let cursor = leafId
  while (cursor && !seenActive.has(cursor)) {
    seenActive.add(cursor)
    active.add(cursor)
    cursor = parentOf.get(cursor) ?? null
  }

  return { byId, parentOf, childIdsOf, hasMessage, active }
}

function branchChildIds(index: TreeIndex, parentId: string): string[] {
  return (index.childIdsOf.get(parentId) ?? []).filter((id) => index.hasMessage.get(id) === true)
}

function lastLeafOf(index: TreeIndex, id: string): string {
  let cursor = id
  for (let depth = 0; depth < NATIVE_TREE_MAX_DEPTH; depth += 1) {
    const kids = branchChildIds(index, cursor)
    if (!kids.length) return cursor
    cursor = kids[kids.length - 1]
  }
  return cursor
}

export function buildBranchPagerMap(
  tree: readonly NativeTreeNode[],
  leafId: string | null = null
): Map<string, BranchPagerModel> {
  const index = buildTreeIndex(tree, leafId)
  const models = new Map<string, BranchPagerModel>()
  for (const id of index.byId.keys()) {
    const node = index.byId.get(id)
    if (!node || describeEntry(node.entry).kind !== 'user') continue
    const forkId = index.parentOf.get(id)
    if (!forkId) continue
    const siblings = branchChildIds(index, forkId)
    if (siblings.length < 2) continue
    const at = siblings.indexOf(id)
    if (at < 0) continue
    const prev = siblings[(at - 1 + siblings.length) % siblings.length]
    const next = siblings[(at + 1) % siblings.length]
    models.set(id, {
      entryId: id,
      forkId,
      index: at + 1,
      count: siblings.length,
      prevTargetId: lastLeafOf(index, prev),
      nextTargetId: lastLeafOf(index, next),
      onActivePath: index.active.has(id)
    })
  }
  return models
}

export function treeHasEntryId(
  tree: readonly NativeTreeNode[],
  entryId: string | null | undefined,
  maxNodes = NATIVE_TREE_MAX_ROWS
): boolean {
  if (!entryId) return false
  const seen = new Set<string>()
  const stack: NativeTreeNode[] = [...tree]
  let count = 0
  while (stack.length) {
    const node = stack.pop()
    const id = nodeId(node)
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (id === entryId) return true
    count += 1
    if (count > maxNodes) return false
    for (const child of childrenOf(node)) stack.push(child)
  }
  return false
}
