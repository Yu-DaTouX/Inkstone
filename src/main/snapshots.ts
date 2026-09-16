/**
 * 写入类工具的**执行前后快照**（方案 5.3 的「可靠差异」阶段）。
 *
 * ── 为什么不能只靠工具参数 ──
 *   · `edit` 的参数只是**替换片段**，不等于整文件 diff；
 *   · `write` 可能是覆盖一个已存在的文件，不能一律当成「新增」；
 *   · 第三方工具（shell 里跑 sed / 脚本）根本不在我们的参数里。
 * 所以在**执行前后各读一次文件**，用两次内容算出真实差异。
 *
 * ── 边界（重要）──
 *   · 只对**受支持的写入工具**（edit / write / multi_edit / apply_patch）做；
 *   · 文件大小上限 2MB，超了只记元信息（不把大文件读进内存）；
 *   · 快照只存在**内存**里，跟着工具调用走，不落盘、不进仓库 ——
 *     它可能包含密钥类内容，方案明确要求默认不保存额外副本；
 *   · 缓存有界（最多 40 条），避免长会话把内存吃满。
 *
 * ── 不做的事 ──
 *   · 不冒充「工作区当前 diff」：那是别的功能，包含用户和其它任务的改动；
 *   · 拿不到前置快照（比如工具开始前文件不存在且我们没来得及读）时如实退化。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { FileDiff, FileSnapshotSide, WorkspaceChangeFile, WorkspaceChanges } from '../shared/ipc'

/** 单个文件的快照上限 */
const MAX_BYTES = 2 * 1024 * 1024
/** 同时保留多少条快照（超出丢最旧） */
const MAX_ENTRIES = 40
/** 逐行 diff 的规模上限（超过就只给统计，不做行级对齐） */
const MAX_DIFF_LINES = 1200
const MAX_DIFF_CELLS = 1_200_000

/** 内部用：多一个 content 字段（只在主进程内存里，不往外传） */
interface Side extends FileSnapshotSide {
  content?: string
}

export type { FileDiff, FileSnapshotSide }

interface Entry {
  path: string
  before: Side
  at: number
}

/** callId → 执行前的快照 */
const pending = new Map<string, Entry>()

/**
 * 读一份快照（不存在 / 读不了都如实记录，不抛异常）。
 *
 * ⚠️ 用**同步** fs：快照必须发生在工具写入之前/之后的那一瞬，
 *    异步读取会有「工具已经写完、你的 before 才读到新内容」的竞态。
 *    文件限 2MB，同步读的阻塞在毫秒级，可以接受。
 */
export function captureSide(path: string): Side {
  let st
  try {
    st = statSync(path)
  } catch {
    return { exists: false, size: 0 }
  }
  if (!st.isFile()) return { exists: false, size: 0 }

  /* 太大：不读内容，只留大小（前端会显示「未读取内容」，不假装没变化） */
  if (st.size > MAX_BYTES) return { exists: true, size: st.size, tooLarge: true }

  try {
    const buf = readFileSync(path)
    return {
      exists: true,
      size: buf.byteLength,
      content: buf.toString('utf8'),
      hash: createHash('sha256').update(buf).digest('hex').slice(0, 16)
    }
  } catch {
    return { exists: true, size: st.size }
  }
}

/** 工具开始执行：记下文件当时的样子 */
export function snapshotBefore(callId: string, path: string): void {
  const before = captureSide(path)
  pending.set(callId, { path, before, at: Date.now() })
  /* 有界：超出丢最旧的（Map 保持插入顺序） */
  while (pending.size > MAX_ENTRIES) {
    const oldest = pending.keys().next().value
    if (oldest === undefined) break
    pending.delete(oldest)
  }
}

/** 工具结束：算差异并清掉临时快照 */
export function snapshotAfter(callId: string): FileDiff | null {
  const entry = pending.get(callId)
  if (!entry) return null
  pending.delete(callId)
  const after = captureSide(entry.path)
  const status: FileDiff['status'] =
    !entry.before.exists && after.exists
      ? 'created'
      : entry.before.exists && !after.exists
        ? 'deleted'
        : entry.before.content !== undefined && after.content !== undefined
          ? entry.before.content === after.content
            ? 'unchanged'
            : 'modified'
          : 'unknown'

  const stats =
    status === 'created'
      ? createdStats(after.content)
      : status === 'deleted'
        ? deletedStats(entry.before.content)
        : diffStats(entry.before.content, after.content)
  /*
   * 内容全文**不往外传**（可能几 MB，而且可能是密钥类内容）：
   * 只给元信息 + 行级 patch + 统计。
   */
  const beforeMeta = { ...entry.before, content: undefined }
  const afterMeta = { ...after, content: undefined }
  return {
    path: entry.path,
    before: beforeMeta,
    after: afterMeta,
    added: stats.added,
    removed: stats.removed,
    patch: stats.patch,
    status
  }
}

/**
 * 受支持的写入工具（方案 5.3 的「可靠差异」阶段只覆盖这些）。
 * shell / 第三方工具产生的改动不在这里 —— 它们拿不到前后快照，
 * 不能把「工作区当前 diff」冒充成某次调用的 diff。
 */
const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'multiEdit', 'apply_patch', 'patch'])

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name)
}

/**
 * shell 类工具（L05）：参数里**没有目标文件**，改什么全看命令内容。
 *
 * 名单与渲染端的 `detailKind`（ToolDetails.tsx）保持一致 —— 那边把这些按
 * “命令窗口”渲染，这边给它们算目录级改动；两边不一致会出现“看起来是命令，
 * 却没有改动卡片”的错觉。
 */
const SHELL_TOOLS = new Set(['bash', 'shell', 'run', 'exec'])

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name)
}

/** 从工具参数里取目标文件路径（不同工具字段名不一样） */
export function writePathOf(args: unknown): string | undefined {
  const a = args as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') return undefined
  for (const key of ['path', 'file_path', 'filePath']) {
    const v = a[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/** 进程退出 / 会话切换时清掉悬挂的快照 */
export function clearSnapshots(): void {
  pending.clear()
  activeTrees.clear()
}

/** 行数（末尾换行不算多一行）；拿不到内容返回 -1 */
function lineCount(text?: string): number {
  if (text === undefined) return -1
  if (text === '') return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/** 新建：全部是新增 */
function createdStats(content?: string): { added: number; removed: number; patch: string } {
  const n = lineCount(content)
  if (n < 0) return { added: -1, removed: -1, patch: '' }
  const lines = (content ?? '').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return { added: n, removed: 0, patch: lines.map((l) => `+ ${l}`).join('\n') }
}

/** 删除：全部是删除 */
function deletedStats(content?: string): { added: number; removed: number; patch: string } {
  const n = lineCount(content)
  if (n < 0) return { added: -1, removed: -1, patch: '' }
  const lines = (content ?? '').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return { added: 0, removed: n, patch: lines.map((l) => `- ${l}`).join('\n') }
}

/** 行数统计 + unified 风格 patch */
function diffStats(before?: string, after?: string): { added: number; removed: number; patch: string } {
  if (before === undefined || after === undefined) return { added: -1, removed: -1, patch: '' }
  if (before === after) return { added: 0, removed: 0, patch: '' }

  const a = before.split('\n')
  const b = after.split('\n')

  /*
   * 先裁掉公共前后缀 —— 真实编辑通常只动中间一小段，
   * 裁完之后 DP 的规模通常从几万格降到几十格。
   */
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  let added = 0
  let removed = 0

  /* 规模太大就只给统计（用集合差近似，不假装有行级对齐） */
  if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES || midA.length * midB.length > MAX_DIFF_CELLS) {
    const setA = new Map<string, number>()
    for (const line of midA) setA.set(line, (setA.get(line) ?? 0) + 1)
    for (const line of midB) {
      const n = setA.get(line) ?? 0
      if (n > 0) setA.set(line, n - 1)
      else added++
    }
    for (const n of setA.values()) removed += n
    return { added, removed, patch: '' }
  }

  /* ---- 标准 LCS 逐行差异 ---- */
  const n = midA.length
  const m = midB.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      lines.push(`  ${midA[i]}`)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`- ${midA[i]}`)
      removed++
      i++
    } else {
      lines.push(`+ ${midB[j]}`)
      added++
      j++
    }
  }
  while (i < n) {
    lines.push(`- ${midA[i++]}`)
    removed++
  }
  while (j < m) {
    lines.push(`+ ${midB[j++]}`)
    added++
  }

  /* 首尾各留一点上下文，中间省略 —— 免得把整个文件贴出来 */
  const CONTEXT = 3
  const head = start > 0 ? a.slice(Math.max(0, start - CONTEXT), start).map((l) => `  ${l}`) : []
  const tail = endA < a.length ? a.slice(endA, Math.min(a.length, endA + CONTEXT)).map((l) => `  ${l}`) : []
  const body = lines.length > 400 ? [...lines.slice(0, 400), `…（还有 ${lines.length - 400} 行差异）`] : lines

  return { added, removed, patch: [...head, ...body, ...tail].join('\n') }
}

/* ============================================================ L05 变更归属 */

/**
 * shell / 第三方工具的**目录级前后快照**（L05）。
 *
 * ── 为什么不能像写入类工具那样按路径拍 ──
 *   `bash` 的参数里没有“要改哪个文件”，一条 `sed -i`、一个构建脚本、
 *   一个 `git checkout` 能改任意多个文件。所以这里对**整个工作目录**拍快照：
 *   执行前记一份「文件 → 元信息」，执行后再记一份，差集就是这次调用期间的变化。
 *
 * ── 归属为什么可能是 unknown ──
 *   同一目录里可能有别人在写：另一个会话（同 cwd 并发）、子代理、用户自己、
 *   或构建进程。目录级快照**无法区分谁改的**，所以：
 *     · 同一目录同时有两个活跃快照 → 两边都标 `concurrent`，谁都不认领；
 *     · 快照被截断（目录太大 / 有读不了的子目录）→ 标 `truncated`；
 *     · 根目录当时读不到 → 标 `unreadable`。
 *   宁可显示“无法可靠归属”，也不把别人的改动记在某次调用头上。
 *
 * ── 成本控制 ──
 *   · 跳过依赖与产物目录（`node_modules` / `out` / `.git` …）；
 *   · 文件数、深度、总哈希字节、总内容字节都有上限，超了标 truncated；
 *   · 元信息（size + mtime）总是记；内容只在文件不大且总预算没花完时读
 *     —— 有内容才能给逐行 patch，没内容就只给状态与大小（行数写 -1）。
 *   · 全部**同步** fs：快照必须卡在工具执行前后那一瞬，异步读会串味。
 */

/** 目录快照里单个文件的信息（content 只在主进程内存里，不外传） */
export interface TreeEntry {
  size: number
  mtimeMs: number
  hash?: string
  content?: string
}

export interface TreeSnapshot {
  root: string
  files: Map<string, TreeEntry>
  /** 没扫完（超条数 / 超深度）→ 差异不可靠 */
  truncated: boolean
  /** 根目录本身读不到 */
  unreadable: boolean
  /** 扫不到的**子**目录数（无权限 / 中途被删）——不算截断，见下方说明 */
  unreadableDirs: number
  /** 扫到的文件数 */
  scanned: number
}

/** 一次目录差异里的单个文件 */
export interface TreeChange {
  path: string
  status: WorkspaceChangeFile['status']
  beforeSize: number
  afterSize: number
}

/** 这些目录里几乎不会有“用户想要审阅的改动”，扫了纯属拖慢快照 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  'release',
  '.next',
  '.cache',
  '.turbo',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'target',
  'vendor',
  '.idea',
  '.vscode',
  '.gradle',
  'obj',
  'bin'
])

const TREE_MAX_FILES = 4000
const TREE_MAX_DEPTH = 12
/** 单个文件超过这个大小就不读内容（只记元信息） */
const TREE_CONTENT_MAX_BYTES = 256 * 1024
/** 一次快照读进内存的内容总预算 —— 有内容才能给逐行 patch */
const TREE_CONTENT_BUDGET = 12 * 1024 * 1024
/** 差异清单最多列多少个文件（总数仍然真实） */
const CHANGE_MAX_FILES = 40
/** 同时保留多少份活跃目录快照 */
const MAX_ACTIVE_TREES = 8

/** 目录快照（执行前） */
export function captureTree(root: string): TreeSnapshot {
  const snap: TreeSnapshot = { root, files: new Map(), truncated: false, unreadable: false, unreadableDirs: 0, scanned: 0 }
  let budget = TREE_CONTENT_BUDGET

  const walk = (abs: string, rel: string, depth: number): void => {
    if (snap.files.size >= TREE_MAX_FILES || depth > TREE_MAX_DEPTH) {
      snap.truncated = true
      return
    }
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      /*
       * 读不了的子目录（无权限 / 半路被删）**不算 truncated**。
       *
       * 理由：用户的项目里常常有故意 deny 的目录（砚自己的 L02 用例就是），
       * 把它们标成“快照不完整”会让**每一条** shell 命令都带一句警告 ——
       * 而实际上那些目录本来就不可读，用户也看不到里面的内容，
       * 两边认知一致，不算“我们漏了”。真正会漏的是条数/深度上限。
       */
      snap.unreadableDirs++
      if (rel === '') {
        snap.unreadable = true
        snap.truncated = true
      }
      return
    }
    for (const e of entries) {
      if (snap.files.size >= TREE_MAX_FILES) {
        snap.truncated = true
        break
      }
      const key = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(join(abs, e.name), key, depth + 1)
        continue
      }
      /* 只认普通文件：符号链接跳过（避免跟到 root 之外，也避免成环） */
      if (!e.isFile()) continue
      let st
      try {
        st = statSync(join(abs, e.name))
      } catch {
        /* 与上面同理：单个文件读不到（多半是并发删除）不算截断 */
        snap.unreadableDirs++
        continue
      }
      const entry: TreeEntry = { size: st.size, mtimeMs: st.mtimeMs }
      if (st.size <= TREE_CONTENT_MAX_BYTES && st.size <= budget) {
        try {
          const buf = readFileSync(join(abs, e.name))
          entry.hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
          /*
           * 内容留着给逐行 patch 用。只留文本：二进制文件即使留着也只会
           * 在 patch 里显示乱码，而且可能很大。
           */
          const text = buf.toString('utf8')
          if (!text.includes('\u0000')) entry.content = text
          budget -= buf.byteLength
        } catch {
          /* 读不到内容就只留元信息（行数会写 -1，不编造） */
        }
      } else if (st.size > TREE_CONTENT_MAX_BYTES) {
        budget = Math.max(0, budget)
      }
      snap.files.set(key, entry)
      snap.scanned++
    }
  }

  walk(root, '', 0)
  return snap
}

/**
 * 两份目录快照的差异（**纯函数**，单测直接覆盖）。
 *
 * 判定规则（宁可说“不确定”，也不编造）：
 *   · 新增 / 删除的文件 → created / deleted；
 *   · 大小变了 → modified；
 *   · 大小没变但两边都有内容哈希 → 比哈希，不同才是 modified；
 *   · 大小没变、只有 mtime 变了 → **unknown**（`touch` 也会改 mtime，
 *     不能据此说内容变了；没有哈希就没法确认）。
 */
export function diffTrees(before: TreeSnapshot, after: TreeSnapshot): TreeChange[] {
  const out: TreeChange[] = []
  for (const [p, b] of after.files) {
    const a = before.files.get(p)
    if (!a) {
      out.push({ path: p, status: 'created', beforeSize: -1, afterSize: b.size })
      continue
    }
    if (a.size !== b.size) {
      out.push({ path: p, status: 'modified', beforeSize: a.size, afterSize: b.size })
      continue
    }
    if (a.hash && b.hash) {
      if (a.hash !== b.hash) out.push({ path: p, status: 'modified', beforeSize: a.size, afterSize: b.size })
      continue
    }
    if (a.mtimeMs !== b.mtimeMs) {
      out.push({ path: p, status: 'unknown', beforeSize: a.size, afterSize: b.size })
    }
  }
  for (const [p, a] of before.files) {
    if (!after.files.has(p)) out.push({ path: p, status: 'deleted', beforeSize: a.size, afterSize: -1 })
  }
  /* 稳定排序：界面与探针都按同一顺序看 */
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
}

interface ActiveTree {
  callId: string
  sessionId?: string
  root: string
  rootKey: string
  snap: TreeSnapshot
  /** 起快照时同一目录已经有别的活跃快照 */
  concurrent: boolean
}

const activeTrees = new Map<string, ActiveTree>()

/** 路径归一化：Windows 大小写不敏感，分隔符统一，尾斜杠去掉 */
function treeKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 工具开始执行：给这个调用拍一份目录快照。
 *
 * 同一目录**已有别的活跃快照**时标记 concurrent（两侧都标）——
 * 这样谁都不会认领这段时间里出现的差异。
 */
export function beginTreeSnapshot(callId: string, root: string, sessionId?: string): void {
  if (!callId || !root) return
  const key = treeKey(root)
  let concurrent = false
  for (const other of activeTrees.values()) {
    if (other.callId !== callId && other.rootKey === key) {
      concurrent = true
      other.concurrent = true
    }
  }
  activeTrees.set(callId, { callId, sessionId, root, rootKey: key, snap: captureTree(root), concurrent })
  while (activeTrees.size > MAX_ACTIVE_TREES) {
    const oldest = activeTrees.keys().next().value
    if (oldest === undefined) break
    activeTrees.delete(oldest)
  }
}

/** 这次调用有没有在跑目录快照（供主进程判断要不要算差异） */
export function hasTreeSnapshot(callId: string): boolean {
  return activeTrees.has(callId)
}

/** 把差异文件补上能拿到的那点行级信息（拿不到就写 -1，不编造） */
function toChangeFile(before: TreeSnapshot, after: TreeSnapshot, change: TreeChange): WorkspaceChangeFile {
  const a = before.files.get(change.path)
  const b = after.files.get(change.path)
  let added = -1
  let removed = -1
  let patch = ''
  if (change.status === 'created' && b?.content !== undefined) {
    const s = createdStats(b.content)
    added = s.added
    removed = s.removed
    patch = s.patch
  } else if (change.status === 'deleted' && a?.content !== undefined) {
    const s = deletedStats(a.content)
    added = s.added
    removed = s.removed
    patch = s.patch
  } else if (change.status === 'modified' && a?.content !== undefined && b?.content !== undefined) {
    const s = diffStats(a.content, b.content)
    added = s.added
    removed = s.removed
    patch = s.patch
  }
  return {
    path: change.path,
    status: change.status,
    beforeSize: change.beforeSize,
    afterSize: change.afterSize,
    added,
    removed,
    patch
  }
}

/**
 * 工具结束执行：算差异并清掉快照。
 *
 * 返回 null = 这次调用没拍过快照（不该显示改动卡片）；
 * 返回对象 = 有结论 —— 即使 0 个文件也返回（“扫描过、确实没变”也是结论，
 * 界面可以选择不显示零改动，但不能把“没扫”说成“没变”）。
 */
export function endTreeSnapshot(callId: string): WorkspaceChanges | null {
  const active = activeTrees.get(callId)
  if (!active) return null
  activeTrees.delete(callId)

  const after = captureTree(active.root)
  const changes = diffTrees(active.snap, after)

  let unknown: WorkspaceChanges['unknown']
  if (active.snap.unreadable && after.unreadable) unknown = 'unreadable'
  else if (active.concurrent) unknown = 'concurrent'
  else if (active.snap.truncated || after.truncated) unknown = 'truncated'

  const listed = changes.slice(0, CHANGE_MAX_FILES).map((c) => toChangeFile(active.snap, after, c))
  return {
    root: active.root,
    files: listed,
    total: changes.length,
    scanned: after.scanned,
    ...(unknown ? { unknown } : {})
  }
}
