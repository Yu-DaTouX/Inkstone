/**
 * 用户消息旁「2/3 ‹ ›」同分叉点切换的**纯投影 + 薄请求封装**（设计 §8.8）。
 *
 * 数据只来自两处正式来源，不新建分支、不做摘要、不读会话文件：
 *   · 原生会话树 `get_tree` 的原始节点（`shared/native-session.ts` 的类型）；
 *   · 用户消息的稳定 `entryId`（`ChatMessage.entryId`，**不是**合成 `m<序号>`）。
 *
 * 分叉点口径：把界面显示的这条用户消息挂到其**父条目**上；父条目的
 * 「真实分支子节点」≥ 2 时，才画 `index/count`。真实分支子节点 = 子树里至少含一条
 * 用户 / 助手消息的子节点，因此书签（label）、纯元信息（model_change 等）不会
 * 冒充兄弟分支；不同会话的多根也不会被串成同一组兄弟。
 *
 * 导航目标 = 那个兄弟分支的**真实叶子**：每个岔口取最后一个分支子节点，得到该
 * 分支最新创建的末端（`get_tree` 的子节点按时间升序，末位即最新）。同一子树有多个
 * 叶子时这条规则唯一且确定，不落到标注 / 元信息节点上。
 *
 * 纯逻辑：不碰 DOM、不读 Electron、不写持久化；请求封装只调用调用方注入的
 * `transport`，固定不带 `summarize`（pi 扩展端已固定 `summarize:false`）。
 */
import {
  NATIVE_TREE_MAX_DEPTH,
  NATIVE_TREE_MAX_ROWS,
  describeEntry,
  type NativeTreeNode
} from '../../../../shared/native-session'
import type { NativeSessionHostRequest, NativeSessionHostResult } from '../../../../shared/native-session-host'

/** 一个分叉点上、某条用户消息对应的切换模型。 */
export interface BranchPagerModel {
  /** 锚定这条用户消息的稳定 `entryId`（来自消息，不是界面合成序号）。 */
  entryId: string
  /** 共同的分叉点（锚定消息的父条目）稳定 `entryId`。 */
  forkId: string
  /** 1 起的序号，如「2/3」。 */
  index: number
  /** 兄弟分支总数（≥ 2 才会出现在投影里）。 */
  count: number
  /** 上一个兄弟分支的真实叶子（循环）。 */
  prevTargetId: string
  /** 下一个兄弟分支的真实叶子（循环）。 */
  nextTargetId: string
  /** 锚定条目是否落在当前活动 leaf 路径上。 */
  onActivePath: boolean
}

/** 原生会话桥的最小接口面，与 `BranchPane` / `shared/native-session-host.ts` 同形。 */
export type BranchPagerRequest = (request: NativeSessionHostRequest) => Promise<NativeSessionHostResult>

export type BranchPagerTreeLoad =
  | { ok: true; tree: NativeTreeNode[]; leafId: string | null }
  | { ok: false; error: string }

export interface BranchPagerActionResult {
  ok: boolean
  error?: string
}

/** 取树：只发 `tree`，绑定 `expectedSessionId`；缺宿主桥时由调用方兜底文案。 */
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

/**
 * 切换叶子：只发 `navigate` + 稳定 `entryId`。
 *
 * 不传 `summarize` / `args`：pi 扩展端固定 `summarize:false`，这里也不给任何
 * 「导航并摘要」的余地。
 */
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

/* ------------------------------------------------------------------ 树索引 */

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

/** 真实分支只认「子树里含用户 / 助手消息」；书签、元信息、用量不参与计数。 */
function hasConversation(kind: string): boolean {
  return kind === 'user' || kind === 'assistant'
}

/**
 * 一次 DFS 建索引；重复 id / 环只收一次，深度按共享常量设上限。
 *
 * `active` 用父指针从 leaf 回溯，只标记活动 leaf 的祖先链，不整树扫描。
 */
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

/** 父条目的真实分支子节点（顺序保持 `get_tree` 的升序）。 */
function branchChildIds(index: TreeIndex, parentId: string): string[] {
  return (index.childIdsOf.get(parentId) ?? []).filter((id) => index.hasMessage.get(id) === true)
}

/** 兄弟分支的真实叶子：每个岔口取最后一个分支子节点，得到该分支最新末端。 */
function lastLeafOf(index: TreeIndex, id: string): string {
  let cursor = id
  for (let depth = 0; depth < NATIVE_TREE_MAX_DEPTH; depth += 1) {
    const kids = branchChildIds(index, cursor)
    if (!kids.length) return cursor
    cursor = kids[kids.length - 1]
  }
  return cursor
}

/* ------------------------------------------------------------------ 投影 */

/**
 * 为树里每条「处于分叉点旁」的用户消息建立切换模型。
 *
 * 只收用户条目；父条目有 ≥ 2 个真实分支子节点才建模型。返回的 Map 直接按
 * `ChatMessage.entryId` 查，查不到（无稳定 id / 无真实兄弟）就不画 pager。
 */
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

/** 单条查询（测试 / 诊断用；组件走 `buildBranchPagerMap` 避免重复建索引）。 */
export function branchPagerFor(
  tree: readonly NativeTreeNode[],
  entryId: string | null | undefined,
  leafId: string | null = null
): BranchPagerModel | null {
  if (!entryId) return null
  return buildBranchPagerMap(tree, leafId).get(entryId) ?? null
}

/** 目标 `entryId` 是否仍在当前树里（点击时再核一次、防在途期间树已变）。 */
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
