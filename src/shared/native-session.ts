/**
 * pi 原生会话操作的共享口径：**会话树**（`get_tree`）、**模型循环范围**
 * （`/scoped-models`，落盘为 pi 的 `enabledModels`）与**项目信任**
 * （`~/.pi/agent/trust.json`）。
 *
 * ── 为什么单独一个模块 ──
 * 三块各有各的数据形状，但共用同一套「加载 → 校验 → 纯投影 → 动作」的边界：
 *   · 主进程从 pi RPC / trust.json 取原始数据，形状可能缺字段甚至被外部改坏；
 *   · 渲染端只拿本模块的严格类型，渲染前先过纯函数做保护；
 *   · 主进程接线（RPC 调用、写盘）不在本文件，由主会话负责。
 *
 * 本文件是**纯逻辑**：不碰 DOM、不读 Electron、不写持久化、不发 RPC，
 * 因此可以直接用 esbuild 编译后做单测（见 `scripts/test-native-session-tree.mjs`）。
 *
 * ── 原生能力边界（pi 1.2.0 实测，见 handoff）──
 * · `get_tree` 返回 `{ tree, leafId }`，节点形如
 *   `{ entry: { id, parentId, type, … }, children: [], label?, labelTimestamp? }`；
 *   导航 API 可能造出多个根，断链的孤儿条目也会作为根出现。
 * · RPC 模式没有独立的「导航到某条目」命令（`navigateTree` 只在扩展上下文里）；
 *   1.2.0 的 RPC 命令表里只有 fork / clone / switch_session / get_tree / get_entries。
 *   所以 `navigate` 动作由主会话决定接哪条原生路径，本模块只传稳定 `entryId`。
 */

export const NATIVE_SESSION_MODES = ['tree', 'scoped-models', 'trust'] as const
export type NativeSessionMode = (typeof NATIVE_SESSION_MODES)[number]

/** 会话树深度上限：异常深的父子链不再递归，超出的子树标记 `truncated`。 */
export const NATIVE_TREE_MAX_DEPTH = 64
/** 一次最多渲染的可见行：超出只计数不渲染，避免上千条同屏卡死。 */
export const NATIVE_TREE_MAX_ROWS = 2000
/** 单行预览最多字符（界面里更长的会再省略一次）。 */
export const NATIVE_TREE_PREVIEW_MAX = 160

/* ------------------------------------------------------------------ 条目 */

/**
 * 会话条目基座（`SessionEntryBase`）。
 *
 * 除已知字段外一律 `unknown`：条目类型很多（message / compaction / label /
 * model_change / usage / custom …），逐个建联合类型收益低，读取前统一经
 * `describeEntry` 收窄。`id` / `parentId` / `type` 是树的骨架，必须存在。
 */
export interface NativeTreeEntry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  [key: string]: unknown
}

/** `get_tree` 的节点：条目 + 子节点 + 可选标签。 */
export interface NativeTreeNode {
  entry: NativeTreeEntry
  children: NativeTreeNode[]
  /** 用户打的书签（来自 label 条目，由 pi 挂在目标节点上）。 */
  label?: string
  labelTimestamp?: string
}

/** 树里一行所表达的条目种类；未知类型收进 `unknown`，不猜测。 */
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
  /** 行内主文字：压成一行并按 `NATIVE_TREE_PREVIEW_MAX` 截断。 */
  text: string
  /** 条目原始 `type`，用于悬停提示与调试。 */
  entryType: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 压成一行并截断；非字符串得到空串，不把对象字符串化进界面。 */
export function nativeOneLine(value: unknown, max = NATIVE_TREE_PREVIEW_MAX): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 从消息 `content`（字符串或内容块数组）里取一段可读文字。 */
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

/**
 * 把一条会话条目收成「种类 + 一行文字」。
 *
 * 覆盖 session-format 里的全部条目类型；不认识的类型保留 `unknown` 与原始
 * `type`，界面显示类型名而不是编一个意思。
 */
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

/* ------------------------------------------------------------------ 树投影 */

export interface NativeTreeStats {
  /** 遍历到的节点数（含被折叠/截断的子树）。 */
  visited: number
  /** 唯一 `entryId` 数。 */
  unique: number
  /** 因重复 id / 环被整棵跳过的子树数。 */
  cycles: number
  /** 因超过最大深度被截断的节点数。 */
  depthTruncated: number
  /** 超过最大行数、没有渲染的可见行数。 */
  rowTruncated: number
  /** 超过扫描上限，未能继续计数（保护极深/极宽的树）。 */
  scanTruncated: boolean
}

export interface NativeTreeRow {
  /** 稳定条目 id —— 选择、折叠与导航都以它为准。 */
  entryId: string
  parentId: string | null
  /** 从 0 起的缩进层级。 */
  depth: number
  kind: NativeEntryKind
  entryType: string
  text: string
  label?: string
  timestamp?: string
  /** 是否是当前 leaf。 */
  leaf: boolean
  /** 是否在 leaf → 根的活动分支上。 */
  onActiveBranch: boolean
  hasChildren: boolean
  folded: boolean
  /** 折叠或截断隐藏的后代条数。 */
  hiddenCount: number
  /** 深层截断：子树不再展开。 */
  truncated: boolean
}

export interface NativeTreeView {
  rows: NativeTreeRow[]
  /** leaf → 根 的 entryId 列表（leaf 在末尾）。 */
  activePath: string[]
  leafId: string | null
  stats: NativeTreeStats
}

export interface NativeTreeViewOptions {
  maxDepth?: number
  maxRows?: number
}

/** 从子节点数组里去掉空值；非数组按空处理。 */
function childrenOf(node: NativeTreeNode): NativeTreeNode[] {
  return Array.isArray(node.children) ? node.children.filter((child): child is NativeTreeNode => isRecord(child)) : []
}

/**
 * leaf → 根 的 id 路径。
 *
 * 带环与深度保护：重复 id 只走一次，找不到就返回空数组（界面据此不自动展开）。
 */
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

/**
 * 首次打开时的折叠集合：**活动分支全部展开，其余有子节点的分支收起**。
 *
 * 这样默认画面就是「当前路径 + 每条岔路一行」，大会话也不会一次铺满；
 * 展开只展开一层，逐层往下看。
 */
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

/**
 * 把 `get_tree` 的树投影成可渲染的行。
 *
 * 保护规则（都在这里收口，渲染端不需要再判断）：
 * · 重复 `entryId` / 环：整棵子树跳过，计入 `cycles`；
 * · 超过 `maxDepth`：该节点仍显示，但标记 `truncated` 且不再往下；
 * · 超过 `maxRows`：只计数不渲染，计入 `rowTruncated`；
 * · 总扫描量有上限，异常宽的树不会把主线程卡住。
 */
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

  /**
   * @returns 本次调用子树里**没有渲染**的节点数（用于折叠行的 `hiddenCount`）。
   */
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

/** 上下移动选择；越过两端时停在端点，不循环。 */
export function moveTreeSelection(rows: readonly NativeTreeRow[], selectedId: string | null, delta: number): string | null {
  if (!rows.length) return null
  const index = rows.findIndex((row) => row.entryId === selectedId)
  if (index < 0) return delta >= 0 ? rows[0].entryId : rows[rows.length - 1].entryId
  const next = Math.max(0, Math.min(rows.length - 1, index + delta))
  return rows[next].entryId
}

/* ------------------------------------------------------------------ 模型范围 */

/** 渲染端展示所需的模型条目（由父层从 `ModelInfo` 映射而来，不跨层塞原始对象）。 */
export interface NativeScopedModel {
  provider: string
  id: string
  name: string
  reasoning?: boolean
  contextWindow?: number
  /** 是否在当前 Ctrl+P 循环范围内。 */
  inScope: boolean
  /** 是否是当前会话正在使用的模型。 */
  current: boolean
}

export interface NativeScopedModelsState {
  models: NativeScopedModel[]
  /**
   * pi 的 `enabledModels` 为空 = 全部可用。界面据此说明「当前是全部」，
   * 保存全选时主会话可以写空数组（pi 语义）而不是逐条 pattern。
   */
  scopeIsAll: boolean
}

/** 稳定模型键：`provider/id`，也是保存给 pi 的 pattern 形态。 */
export function nativeModelKey(model: Pick<NativeScopedModel, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

export function parseNativeModelKey(key: string): { provider: string; id: string } | null {
  const at = key.indexOf('/')
  if (at <= 0 || at === key.length - 1) return null
  return { provider: key.slice(0, at), id: key.slice(at + 1) }
}

/** 当前范围里的模型键（保持入参顺序）。 */
export function scopeSelection(models: NativeScopedModel[]): string[] {
  return models.filter((model) => model.inScope).map(nativeModelKey)
}

/** 切换一条模型的入/出范围，返回新数组（不改入参）。 */
export function toggleScopeModel(models: NativeScopedModel[], key: string): NativeScopedModel[] {
  return models.map((model) => (nativeModelKey(model) === key ? { ...model, inScope: !model.inScope } : model))
}

/* ------------------------------------------------------------------ 加载与动作 */

export interface NativeTreeLoad {
  ok: true
  mode: 'tree'
  tree: NativeTreeNode[]
  leafId: string | null
}

export interface NativeScopedModelsLoad {
  ok: true
  mode: 'scoped-models'
  models: NativeScopedModel[]
  scopeIsAll: boolean
}

export interface NativeTrustLoad {
  ok: true
  mode: 'trust'
  cwd: string
  trusted: boolean
  /** 让它是 `true` 的那条 trust 条目（向上命中的路径）；没有就是 null。 */
  entry: string | null
  /**
   * 该目录是否含 pi 的受保护资源（`.pi/settings.json`、`.pi/extensions` 等）。
   * 没有受保护资源时「信任」不改变任何行为，界面要如实说明。
   */
  requiresTrust: boolean
}

export interface NativeLoadFailure {
  ok: false
  mode: NativeSessionMode
  error: string
}

export type NativeSessionLoadResult =
  | NativeTreeLoad
  | NativeScopedModelsLoad
  | NativeTrustLoad
  | NativeLoadFailure

/**
 * 面板会发出的原生动作。名字与主会话的 `shared/native-session-host.ts`
 * （`NativeSessionHostAction`）一一对应，父层可以直接透传，不必再建一张映射表。
 */
export type NativeSessionActionName = 'navigate' | 'set-scoped-models' | 'set-trust'

export interface NativeSessionActionArgs {
  /** 把活动 leaf 移到某个持久条目；`entryId` 是稳定 id（`navigateTree`）。 */
  navigate: { entryId: string }
  /** 写 pi 的 `enabledModels`：传空数组表示「全部可用」。 */
  'set-scoped-models': { modelIds: string[] }
  /** 只允许授予信任；撤销按设计另行确认，不从这个面板走。 */
  'set-trust': { trusted: boolean }
}

export interface NativeActionResult {
  ok: boolean
  error?: string
  /** 成功时可选的人话提示（例如「已切换」）。 */
  message?: string
}

export type NativeSessionAction = <K extends NativeSessionActionName>(
  action: K,
  args: NativeSessionActionArgs[K]
) => Promise<NativeActionResult>

/** 从 `get_tree` 的 RPC 数据里取出树与 leaf；缺字段退回空树。 */
export function parseTreePayload(raw: unknown): { tree: NativeTreeNode[]; leafId: string | null } {
  const record = isRecord(raw) ? raw : {}
  const tree = Array.isArray(record.tree) ? (record.tree as NativeTreeNode[]) : []
  const leafId = typeof record.leafId === 'string' && record.leafId ? record.leafId : null
  return { tree, leafId }
}
