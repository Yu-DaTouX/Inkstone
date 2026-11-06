export type NativeSessionMode = 'tree' | 'scoped-models' | 'trust'

export const NATIVE_TREE_MAX_DEPTH = 64
export const NATIVE_TREE_MAX_ROWS = 2000
export const NATIVE_TREE_PREVIEW_MAX = 160

export interface NativeTreeEntry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  [key: string]: unknown
}

export interface NativeTreeNode {
  entry: NativeTreeEntry
  children: NativeTreeNode[]
  label?: string
  labelTimestamp?: string
}

export interface NativeTreeFlatNode {
  entry: NativeTreeEntry
  parentId: string | null
  label?: string
  labelTimestamp?: string
}

export type NativeEntryKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'system'
  | 'summary'
  | 'branch'
  | 'label'
  | 'meta'
  | 'custom'
  | 'usage'
  | 'unknown'

export interface NativeEntryDescription {
  kind: NativeEntryKind
  text: string
  entryType: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nativeOneLine(value: unknown, max = NATIVE_TREE_PREVIEW_MAX): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return nativeOneLine(content)
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  let hasImage = false
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image' || block.type === 'image_url') hasImage = true
  }
  const joined = nativeOneLine(texts.join(' '))
  if (joined) return joined
  return hasImage ? '[image]' : ''
}

export function describeEntry(entry: unknown): NativeEntryDescription {
  const record = isRecord(entry) ? entry : {}
  const entryType = typeof record.type === 'string' ? record.type : 'unknown'
  const message = isRecord(record.message) ? record.message : null
  const role = message && typeof message.role === 'string' ? message.role : ''

  if (entryType === 'message') {
    switch (role) {
      case 'user':
        return { kind: 'user', text: contentText(message?.content), entryType }
      case 'assistant':
        return { kind: 'assistant', text: contentText(message?.content), entryType }
      case 'toolResult': {
        const name = message && typeof message.toolName === 'string' ? message.toolName : ''
        return { kind: 'tool', text: nativeOneLine([name, contentText(message?.content)].filter(Boolean).join(' ')), entryType }
      }
      case 'bashExecution': {
        const command = message && typeof message.command === 'string' ? message.command : ''
        return { kind: 'tool', text: nativeOneLine(command), entryType }
      }
      case 'system':
        return { kind: 'system', text: contentText(message?.content) || 'system', entryType }
      case 'custom':
        return { kind: 'custom', text: contentText(message?.content), entryType }
      case 'branchSummary':
        return { kind: 'branch', text: nativeOneLine(message?.summary), entryType }
      case 'compactionSummary':
        return { kind: 'summary', text: nativeOneLine(message?.summary), entryType }
      default:
        return { kind: 'unknown', text: '', entryType }
    }
  }

  switch (entryType) {
    case 'compaction':
      return { kind: 'summary', text: nativeOneLine(record.summary), entryType }
    case 'branch_summary':
      return { kind: 'branch', text: nativeOneLine(record.summary), entryType }
    case 'label':
      return { kind: 'label', text: nativeOneLine(record.label), entryType }
    case 'model_change':
      return { kind: 'meta', text: nativeOneLine([record.provider, record.modelId].filter((v) => typeof v === 'string').join('/')), entryType }
    case 'thinking_level_change':
      return { kind: 'meta', text: nativeOneLine(record.thinkingLevel), entryType }
    case 'session_info':
      return { kind: 'meta', text: nativeOneLine(record.name), entryType }
    case 'custom':
      return { kind: 'custom', text: nativeOneLine(record.customType), entryType }
    case 'custom_message':
      return { kind: 'custom', text: nativeOneLine([record.customType, contentText(record.content)].filter(Boolean).join(' ')), entryType }
    case 'usage':
      return { kind: 'usage', text: nativeOneLine(record.kind), entryType }
    case 'context_edit':
      return { kind: 'meta', text: nativeOneLine(record.targetId), entryType }
    default:
      return { kind: 'unknown', text: '', entryType }
  }
}

export interface NativeTreeStats {
  visited: number
  unique: number
  cycles: number
  depthTruncated: number
  rowTruncated: number
  scanTruncated: boolean
}

export interface NativeTreeRow {
  entryId: string
  parentId: string | null
  depth: number
  kind: NativeEntryKind
  entryType: string
  text: string
  label?: string
  timestamp?: string
  leaf: boolean
  onActiveBranch: boolean
  hasChildren: boolean
  folded: boolean
  hiddenCount: number
  truncated: boolean
  tags?: string[]
}

export interface NativeTreeView {
  rows: NativeTreeRow[]
  activePath: string[]
  leafId: string | null
  stats: NativeTreeStats
}

export interface NativeTreeViewOptions {
  maxDepth?: number
  maxRows?: number
}

function childrenOf(node: NativeTreeNode): NativeTreeNode[] {
  return Array.isArray(node.children) ? node.children.filter((child): child is NativeTreeNode => isRecord(child)) : []
}

function nodeIdOf(node: unknown): string | null {
  if (!isRecord(node) || !isRecord(node.entry)) return null
  const id = node.entry.id
  return typeof id === 'string' && id ? id : null
}

const SLIM_ENTRY_TEXT_KEYS = ['summary', 'label', 'provider', 'modelId', 'thinkingLevel', 'name', 'customType', 'kind', 'targetId'] as const

export function slimNativeEntry(raw: Record<string, unknown>): NativeTreeEntry {
  const out: Record<string, unknown> = {
    type: typeof raw.type === 'string' ? raw.type : 'unknown',
    id: typeof raw.id === 'string' ? raw.id : '',
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null
  }
  if (typeof raw.timestamp === 'string') out.timestamp = raw.timestamp
  for (const key of SLIM_ENTRY_TEXT_KEYS) {
    if (typeof raw[key] === 'string') out[key] = nativeOneLine(raw[key])
  }
  if ('content' in raw) out.content = contentText(raw.content)
  if (isRecord(raw.message)) {
    const message = raw.message
    const slim: Record<string, unknown> = {}
    for (const key of ['role', 'toolName', 'command', 'summary'] as const) {
      if (typeof message[key] === 'string') slim[key] = nativeOneLine(message[key])
    }
    if ('content' in message) slim.content = contentText(message.content)
    out.message = slim
  }
  return out as NativeTreeEntry
}

export function flattenNativeTree(tree: readonly unknown[]): NativeTreeFlatNode[] {
  const out: NativeTreeFlatNode[] = []
  const seen = new Set<string>()
  const stack: Array<{ node: Record<string, unknown>; parentId: string | null }> = []
  for (let i = tree.length - 1; i >= 0; i -= 1) {
    const raw = tree[i]
    if (isRecord(raw)) stack.push({ node: raw, parentId: null })
  }
  while (stack.length) {
    const { node, parentId } = stack.pop()!
    const id = nodeIdOf(node)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      entry: slimNativeEntry(node.entry as Record<string, unknown>),
      parentId,
      ...(typeof node.label === 'string' ? { label: node.label } : {}),
      ...(typeof node.labelTimestamp === 'string' ? { labelTimestamp: node.labelTimestamp } : {})
    })
    const kids = Array.isArray(node.children) ? node.children : []
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const kid = kids[i]
      if (isRecord(kid)) stack.push({ node: kid, parentId: id })
    }
  }
  return out
}

export function nativeTreeFromFlat(nodes: readonly unknown[]): NativeTreeNode[] {
  const roots: NativeTreeNode[] = []
  const byId = new Map<string, NativeTreeNode>()
  for (const raw of nodes) {
    const id = nodeIdOf(raw)
    if (!id || byId.has(id)) continue
    const flat = raw as unknown as NativeTreeFlatNode
    const node: NativeTreeNode = {
      entry: flat.entry,
      children: [],
      ...(typeof flat.label === 'string' ? { label: flat.label } : {}),
      ...(typeof flat.labelTimestamp === 'string' ? { labelTimestamp: flat.labelTimestamp } : {})
    }
    byId.set(id, node)
    const parent = typeof flat.parentId === 'string' ? byId.get(flat.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

function parentIndex(tree: readonly NativeTreeNode[]): Map<string, string | null> {
  const parentOf = new Map<string, string | null>()
  const stack: Array<{ node: NativeTreeNode; parentId: string | null }> = []
  for (let i = tree.length - 1; i >= 0; i -= 1) stack.push({ node: tree[i], parentId: null })
  while (stack.length) {
    const { node, parentId } = stack.pop()!
    const id = nodeIdOf(node)
    if (!id || parentOf.has(id)) continue
    parentOf.set(id, parentId)
    const kids = childrenOf(node)
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push({ node: kids[i], parentId: id })
  }
  return parentOf
}

export function pathToEntry(tree: NativeTreeNode[], entryId: string | null | undefined): string[] {
  if (!entryId) return []
  const parentOf = parentIndex(tree)
  if (!parentOf.has(entryId)) return []
  const path: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = entryId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    path.push(cursor)
    cursor = parentOf.get(cursor) ?? null
  }
  return path.reverse()
}

export function initialCollapsedForLeaf(tree: NativeTreeNode[], leafId: string | null): Set<string> {
  const active = new Set(pathToEntry(tree, leafId))
  const collapsed = new Set<string>()
  const seen = new Set<string>()
  const stack: NativeTreeNode[] = [...tree]
  while (stack.length) {
    const node = stack.pop()!
    const id = nodeIdOf(node)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const kids = childrenOf(node)
    if (!kids.length) continue
    if (!active.has(id)) collapsed.add(id)
    stack.push(...kids)
  }
  return collapsed
}

function foldsIntoNext(kind: NativeEntryKind): boolean {
  return kind === 'meta' || kind === 'usage'
}

export function buildTreeView(
  tree: NativeTreeNode[],
  leafId: string | null,
  collapsed: ReadonlySet<string> = new Set<string>(),
  options: NativeTreeViewOptions = {}
): NativeTreeView {
  const maxDepth = options.maxDepth ?? NATIVE_TREE_MAX_DEPTH
  const maxRows = options.maxRows ?? NATIVE_TREE_MAX_ROWS
  const scanCap = Math.max(maxRows * 8, 64)

  const rows: NativeTreeRow[] = []
  const seen = new Set<string>()
  const stats: NativeTreeStats = { visited: 0, unique: 0, cycles: 0, depthTruncated: 0, rowTruncated: 0, scanTruncated: false }
  const activePath = pathToEntry(tree, leafId)
  const activeSet = new Set(activePath)

  const uniqueKids = (node: NativeTreeNode): NativeTreeNode[] =>
    childrenOf(node).filter((kid) => {
      const id = nodeIdOf(kid)
      if (id && !seen.has(id)) return true
      if (id) stats.cycles += 1
      return false
    })
  const pickMain = (kids: NativeTreeNode[]): NativeTreeNode =>
    kids.find((kid) => activeSet.has(nodeIdOf(kid) ?? '')) ?? kids[kids.length - 1]

  const emit = (
    node: NativeTreeNode,
    id: string,
    depth: number,
    visible: boolean,
    hasChildren: boolean,
    tags: string[]
  ): { index: number; folded: boolean } => {
    const folded = hasChildren && collapsed.has(id)
    if (!visible) return { index: -1, folded }
    const description = describeEntry(node.entry)
    rows.push({
      entryId: id,
      parentId: typeof node.entry.parentId === 'string' ? node.entry.parentId : null,
      depth,
      kind: description.kind,
      entryType: description.entryType,
      text: description.text,
      ...(typeof node.label === 'string' && node.label ? { label: node.label } : {}),
      ...(typeof node.entry.timestamp === 'string' ? { timestamp: node.entry.timestamp } : {}),
      ...(tags.length ? { tags } : {}),
      leaf: !!leafId && id === leafId,
      onActiveBranch: activeSet.has(id),
      hasChildren,
      folded,
      hiddenCount: 0,
      truncated: false
    })
    return { index: rows.length - 1, folded }
  }

  const visit = (id: string): boolean => {
    if (stats.visited >= scanCap) {
      stats.scanTruncated = true
      return false
    }
    seen.add(id)
    stats.visited += 1
    stats.unique += 1
    return true
  }

  const settle = (index: number, folded: boolean, count: number): void => {
    if (index >= 0 && folded) rows[index] = { ...rows[index], hiddenCount: count }
  }

  const branchDepth = (depth: number): number => {
    if (depth <= maxDepth) return depth
    stats.depthTruncated += 1
    return maxDepth
  }

  const emitBranch = (head: NativeTreeNode, depth: number, visible: boolean): number => {
    const id = nodeIdOf(head)
    if (!id || seen.has(id) || !visit(id)) return 0
    const kids = uniqueKids(head)
    const at = branchDepth(depth)
    const { index, folded } = emit(head, id, at, visible, kids.length > 0, [])
    let hidden = visible ? 0 : 1
    if (!kids.length) return hidden
    const inner = emitKids(kids, at + 1, visible && !folded)
    settle(index, folded, inner)
    return hidden + inner
  }

  const emitKids = (kids: NativeTreeNode[], depth: number, visible: boolean): number => {
    const main = pickMain(kids)
    let hidden = 0
    for (const kid of kids) if (kid !== main) hidden += emitBranch(kid, depth + 1, visible)
    return hidden + emitChain(main, depth, visible)
  }

  const emitChain = (start: NativeTreeNode, depth: number, visible: boolean): number => {
    let hidden = 0
    let tags: string[] = []
    let cursor: NativeTreeNode | undefined = start
    while (cursor) {
      const id = nodeIdOf(cursor)
      if (!id || seen.has(id) || !visit(id)) break
      const kids = uniqueKids(cursor)
      const description = describeEntry(cursor.entry)
      const labelled = typeof cursor.label === 'string' && !!cursor.label
      if (kids.length === 1 && foldsIntoNext(description.kind) && !labelled && id !== leafId) {
        if (description.text) tags.push(description.text)
        cursor = kids[0]
        continue
      }
      const main = kids.length ? pickMain(kids) : undefined
      const branches = kids.filter((kid) => kid !== main)
      const { index, folded } = emit(cursor, id, depth, visible, branches.length > 0, tags)
      tags = []
      if (!visible) hidden += 1
      let inner = 0
      for (const branch of branches) inner += emitBranch(branch, depth + 1, visible && !folded)
      settle(index, folded, inner)
      hidden += inner
      cursor = main
    }
    return hidden
  }

  for (const root of tree) {
    if (stats.scanTruncated) break
    const id = nodeIdOf(root)
    if (!id) continue
    if (seen.has(id)) {
      stats.cycles += 1
      continue
    }
    emitChain(root, 0, true)
  }

  if (rows.length > maxRows) {
    stats.rowTruncated = rows.length - maxRows
    return { rows: rows.slice(-maxRows), activePath, leafId, stats }
  }
  return { rows, activePath, leafId, stats }
}

export interface NativeScopedModel {
  provider: string
  id: string
  name: string
  reasoning?: boolean
  contextWindow?: number
  inScope: boolean
  current: boolean
}

export function nativeModelKey(model: Pick<NativeScopedModel, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

export type NativeSessionActionName = 'navigate' | 'set-scoped-models' | 'set-trust'

export interface NativeSessionActionArgs {
  navigate: { entryId: string }
  'set-scoped-models': { modelIds: string[] }
  'set-trust': { trusted: boolean }
}

export interface NativeActionResult {
  ok: boolean
  error?: string
  message?: string
}

export type NativeSessionAction = <K extends NativeSessionActionName>(
  action: K,
  args: NativeSessionActionArgs[K]
) => Promise<NativeActionResult>

export function parseTreePayload(raw: unknown): { tree: NativeTreeNode[]; leafId: string | null } {
  const record = isRecord(raw) ? raw : {}
  const items: unknown[] = Array.isArray(record.tree) ? record.tree : []
  const flat = items.some((item) => isRecord(item) && !Array.isArray(item.children))
  const tree = flat ? nativeTreeFromFlat(items) : (items as NativeTreeNode[])
  const leafId = typeof record.leafId === 'string' && record.leafId ? record.leafId : null
  return { tree, leafId }
}
