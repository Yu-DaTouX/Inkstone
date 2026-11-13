import { parseHostNotice, type HostNotice } from './host-notice'

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
  hostNotice?: HostNotice['kind']
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

function fullText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
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
      case 'user': {
        const hostNotice = typeof message?.hostNotice === 'string' ? (message.hostNotice as HostNotice['kind']) : undefined
        return { kind: 'user', text: contentText(message?.content), entryType, ...(hostNotice ? { hostNotice } : {}) }
      }
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
    if (message.role === 'user') {
      const notice = parseHostNotice(fullText(message.content))
      if (notice) slim.hostNotice = notice.kind
    }
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

export interface NativeActionResult {
  ok: boolean
  error?: string
  message?: string
}

export function parseTreePayload(raw: unknown): { tree: NativeTreeNode[]; leafId: string | null } {
  const record = isRecord(raw) ? raw : {}
  const items: unknown[] = Array.isArray(record.tree) ? record.tree : []
  const flat = items.some((item) => isRecord(item) && !Array.isArray(item.children))
  const tree = flat ? nativeTreeFromFlat(items) : (items as NativeTreeNode[])
  const leafId = typeof record.leafId === 'string' && record.leafId ? record.leafId : null
  return { tree, leafId }
}
