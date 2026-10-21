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

export function pathToEntry(tree: NativeTreeNode[], entryId: string | null | undefined): string[] {
  if (!entryId) return []
  const seen = new Set<string>()
  let found: string[] = []
  const walk = (nodes: NativeTreeNode[], trail: string[], depth: number): boolean => {
    if (depth > NATIVE_TREE_MAX_DEPTH) return false
    for (const node of nodes) {
      if (!isRecord(node) || !isRecord(node.entry)) continue
      const id = node.entry.id
      if (typeof id !== 'string' || !id || seen.has(id)) continue
      seen.add(id)
      const next = [...trail, id]
      if (id === entryId) {
        found = next
        return true
      }
      if (childrenOf(node).length && walk(childrenOf(node), next, depth + 1)) return true
    }
    return false
  }
  walk(tree, [], 0)
  return found
}

export function initialCollapsedForLeaf(tree: NativeTreeNode[], leafId: string | null): Set<string> {
  const active = new Set(pathToEntry(tree, leafId))
  const collapsed = new Set<string>()
  const seen = new Set<string>()
  const walk = (nodes: NativeTreeNode[], depth: number): void => {
    if (depth > NATIVE_TREE_MAX_DEPTH) return
    for (const node of nodes) {
      if (!isRecord(node) || !isRecord(node.entry)) continue
      const id = node.entry.id
      if (typeof id !== 'string' || !id || seen.has(id)) continue
      seen.add(id)
      const kids = childrenOf(node)
      if (kids.length) {
        if (!active.has(id)) collapsed.add(id)
        walk(kids, depth + 1)
      }
    }
  }
  walk(tree, 0)
  return collapsed
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

  const walk = (nodes: NativeTreeNode[], depth: number, visible: boolean): number => {
    let hidden = 0
    for (const node of nodes) {
      if (stats.visited >= scanCap) {
        stats.scanTruncated = true
        break
      }
      if (!isRecord(node) || !isRecord(node.entry)) continue
      const id = node.entry.id
      if (typeof id !== 'string' || !id) continue
      if (seen.has(id)) {
        stats.cycles += 1
        continue
      }
      seen.add(id)
      stats.visited += 1
      stats.unique += 1

      const kids = childrenOf(node)
      const hasChildren = kids.length > 0
      const depthLimit = hasChildren && depth >= maxDepth
      const folded = hasChildren && !depthLimit && collapsed.has(id)
      const canShow = visible && rows.length < maxRows

      if (canShow) {
        const description = describeEntry(node.entry)
        const row: NativeTreeRow = {
          entryId: id,
          parentId: typeof node.entry.parentId === 'string' ? node.entry.parentId : null,
          depth,
          kind: description.kind,
          entryType: description.entryType,
          text: description.text,
          ...(typeof node.label === 'string' && node.label ? { label: node.label } : {}),
          ...(typeof node.entry.timestamp === 'string' ? { timestamp: node.entry.timestamp } : {}),
          leaf: !!leafId && id === leafId,
          onActiveBranch: false,
          hasChildren,
          folded,
          hiddenCount: 0,
          truncated: depthLimit
        }
        rows.push(row)
        const index = rows.length - 1
        if (depthLimit) {
          stats.depthTruncated += 1
        } else if (folded) {
          const count = walk(kids, depth + 1, false)
          rows[index] = { ...row, hiddenCount: count }
          hidden += count
        } else if (hasChildren) {
          hidden += walk(kids, depth + 1, true)
        }
      } else {
        if (visible) stats.rowTruncated += 1
        hidden += 1
        if (depthLimit) stats.depthTruncated += 1
        else if (hasChildren) hidden += walk(kids, depth + 1, false)
      }
    }
    return hidden
  }

  walk(tree, 0, true)

  const activePath = pathToEntry(tree, leafId)
  const activeSet = new Set(activePath)
  for (const row of rows) row.onActiveBranch = activeSet.has(row.entryId)

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
  const tree = Array.isArray(record.tree) ? (record.tree as NativeTreeNode[]) : []
  const leafId = typeof record.leafId === 'string' && record.leafId ? record.leafId : null
  return { tree, leafId }
}
