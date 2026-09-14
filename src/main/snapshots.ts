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
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { FileDiff, FileSnapshotSide } from '../shared/ipc'

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
