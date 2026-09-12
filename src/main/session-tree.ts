/**
 * 会话树（分支）—— 把 pi 的 get_tree 裁成界面能用的小结构。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须在主进程裁
 * ══════════════════════════════════════════════════════════════════
 * 实测一个真实会话的树是 **2000+ 节点**（当前会话 2178 个，12 个分支点）。
 * 原样发给渲染端：几 MB JSON + 前端还要遍历一遍 —— 而界面真正要显示的
 * 只有「分支点 + 每个分支的第一句用户话」这十几个东西。
 *
 * 裁法：
 *   · 只保留 **children ≥ 2 的节点**（分支点）与它们的分支孩子
 *   · 每个分支用**它这一支的第一条用户消息**当标签（人认的是这句话）
 *   · 记下「哪一支在活动路径上」（pi 的 leafId 所在的那支）——
 *     否则用户看不出自己现在在哪条分支上
 *   · 分支点之间的普通节点只留**个数**（「N 条消息」）
 *
 * ⚠️ 协议里**没有** navigate_tree（47 个命令里没有）——所以分支树能做
 *    「查看 + 从某个节点分支」，**不能**「切到已存在的分支」。
 *    这一点在界面上要说清（按钮写「从这里分支」而不是「切换」）。
 */
import type { SessionBranch } from '../shared/ipc'

/** pi 的树节点（只声明我们用到的字段） */
interface TreeNode {
  entry?: {
    id?: string
    type?: string
    message?: { role?: string; content?: unknown }
  }
  children?: TreeNode[]
}

/** 从 entry 里抠出可读文本（只认 message 的 text 块） */
function entryText(node: TreeNode): string {
  const m = node.entry?.message
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  return m.content
    .filter((c): c is { type: string; text: string } => {
      const o = c as { type?: unknown; text?: unknown }
      return o?.type === 'text' && typeof o.text === 'string'
    })
    .map((c) => c.text)
    .join('\n')
}

function entryRole(node: TreeNode): string {
  return String(node.entry?.message?.role ?? '')
}

/**
 * 顺着一条分支往下走，找到**第一条用户消息**当标签。
 * 找不到（这一支全是助手/工具）就退化成先看第一条有文字的消息。
 */
function branchLabel(start: TreeNode): { text: string; entryId: string } {
  let fallback: { text: string; entryId: string } | null = null
  let node: TreeNode | undefined = start
  // 限深：分支可能很长，但标签只可能在最前面几百个节点里
  for (let i = 0; i < 400 && node; i++) {
    const text = entryText(node).trim()
    const id = String(node.entry?.id ?? '')
    if (text) {
      if (entryRole(node) === 'user') return { text: firstLine(text), entryId: id }
      if (!fallback) fallback = { text: firstLine(text), entryId: id }
    }
    // 只在「单链」上继续走 —— 再遇到分叉就停（那是下一个分支点）
    if ((node.children?.length ?? 0) !== 1) break
    node = node.children![0]
  }
  return fallback ?? { text: '', entryId: String(start.entry?.id ?? '') }
}

function firstLine(s: string): string {
  const line = s.split('\n').map((x) => x.trim()).find((x) => x.length > 0) ?? ''
  const plain = line.replace(/^[#>*\-\s]+/, '').replace(/[*`_]/g, '')
  return plain.length > 80 ? plain.slice(0, 80) + '…' : plain
}

/**
 * 裁树。
 *
 * `activePath`：从根到 leafId 的 entry id 集合 —— 判断「哪一支是活动的」。
 */
export function trimTree(
  tree: TreeNode[],
  leafId: string,
  sessionPath: string
): { branches: SessionBranch[]; points: number; total: number } {
  // ① 先算出活动路径上的 id 集合
  const onPath = new Set<string>()
  const find = (nodes: TreeNode[], trail: string[]): boolean => {
    for (const n of nodes) {
      const id = String(n.entry?.id ?? '')
      const next = id ? [...trail, id] : trail
      if (id && id === leafId) {
        for (const x of next) onPath.add(x)
        return true
      }
      if (find(n.children ?? [], next)) return true
    }
    return false
  }
  find(tree, [])

  // ② 遍历：收集分支点
  const branches: SessionBranch[] = []
  let total = 0

  const walk = (nodes: TreeNode[], depthFromLastBranch: number): void => {
    for (const n of nodes) {
      total++
      const kids = n.children ?? []
      if (kids.length >= 2) {
        const alts: SessionBranch['alternatives'] = kids.map((k) => {
          const { text, entryId } = branchLabel(k)
          // 这一支是否包含活动路径上的节点
          const active = containsPath(k, onPath)
          return { entryId, text, active, size: countNodes(k) }
        })
        branches.push({
          id: String(n.entry?.id ?? ''),
          sessionPath,
          afterMessages: depthFromLastBranch,
          alternatives: alts
        })
        // 每个分支点之后重新计数
        for (const k of kids) walk(k.children ?? [], 0)
        continue
      }
      walk(kids, depthFromLastBranch + 1)
    }
  }
  walk(tree, 0)

  return { branches, points: branches.length, total }
}

function containsPath(node: TreeNode, onPath: Set<string>): boolean {
  const id = String(node.entry?.id ?? '')
  if (id && onPath.has(id)) return true
  return (node.children ?? []).some((c) => containsPath(c, onPath))
}

function countNodes(node: TreeNode): number {
  return 1 + (node.children ?? []).reduce((n, c) => n + countNodes(c), 0)
}
