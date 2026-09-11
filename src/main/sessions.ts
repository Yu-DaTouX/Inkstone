/**
 * 会话索引 —— 读 ~/.pi/agent/sessions/ 给左栏用。
 *
 * ⚠️ 这是**只读**的（列表 + 标题）。真正切换会话是让 pi 自己
 * `switch_session`，我们不解析整个会话文件（格式是 version:3，会变）。
 * 只有标题/时间/条数这些"元数据"靠解析，坏了也只是列表难看，不影响功能。
 *
 * 性能：会话文件可能十几 MB。用 mtime 做缓存，且只在 head 里找标题。
 */
import { readdir, stat, open, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionSummary } from '../shared/ipc'

/**
 * 会话目录。
 * 默认是 pi 的标准位置；`YAN_SESSIONS_DIR` 可覆盖 ——
 * 既方便测试（不进真实目录），也方便用户把 pi 的 `--session-dir` 指到别处。
 */
export const SESSIONS_DIR =
  process.env.YAN_SESSIONS_DIR?.trim() || join(homedir(), '.pi', 'agent', 'sessions')

/**
 * 是否应该把 `--session-dir` 传给 pi。
 *
 * ⚠️ 只在用户/测试**显式**接管了会话目录时才传。
 *
 * 为什么：pi 自己会在 sessions 根目录下按 cwd 建项目子目录
 * （如 `--C--Users-Name--/xxx.jsonl`）。
 * 一旦显式传了 `--session-dir`，pi 就**不再建那个子目录**，
 * 而是把会话平铺写进指定目录 —— 结果是新会话与用户原会话分居两处，
 * 左栏里新会话只能靠合成条目显示。
 *
 * 所以：默认不传，交给 pi 自己组织；隔离测试传（sandbox 里平铺无妨）。
 */
export const SESSIONS_DIR_IS_OVERRIDE = !!process.env.YAN_SESSIONS_DIR?.trim()

/** 只读头部这么多字节来找 cwd / 第一条用户消息 */
const HEAD_BYTES = 96 * 1024

/** 标题里把家目录缩写，否则路径会把内容挤没 */
const HOME = homedir()
function shortenPaths(s: string): string {
  let out = s
  // 两种分隔符都处理，大小写不敏感（Windows 路径）
  const variants = [HOME, HOME.replace(/\\/g, '/')]
  for (const h of variants) {
    if (!h) continue
    const re = new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    out = out.replace(re, '~')
  }
  return out
}

interface CacheEntry {
  mtimeMs: number
  summary: SessionSummary
}

const cache = new Map<string, CacheEntry>()

/** 目录名形如 --C--Users-Name--；括号里的内容是 cwd 的 lossy 编码，仅作兜底 */
function decodeDirName(name: string): string | null {
  if (!name.startsWith('-') || !name.endsWith('-')) return null
  const inner = name.slice(1, -1)
  // 不能可靠还原（目录名里可能有 -），只在读不到 cwd 时用
  return inner.replace(/-/g, '\\')
}

/** 从一行 JSON 里安全取 title */
function titleFromMessage(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as { role?: string; content?: unknown }
  if (m.role !== 'user') return null

  let text = ''
  if (typeof m.content === 'string') {
    text = m.content
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        text = String((part as { text?: unknown }).text ?? '')
        break
      }
    }
  }

  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return null
  // 去掉 XML 包裹（有些客户端会塞 <user> 标签）
  text = text.replace(/<[^>]{1,40}>/g, '').trim()
  if (!text) return null

  text = shortenPaths(text)

  // 34 个汉字的宽度差不多就是左栏一行放得下的量
  return text.length > 34 ? `${text.slice(0, 34)}…` : text
}

async function readHead(path: string): Promise<{
  cwd?: string
  title?: string
  id?: string
  /** session_info 里的用户名字（TUI 的 /name 或 --name 写的） */
  name?: string
  createdAt: number
}> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    const head = buf.subarray(0, bytesRead).toString('utf8')

    let cwd: string | undefined
    let title: string | undefined
    let id: string | undefined
    let name: string | undefined
    let createdAt = 0

    for (const line of head.split('\n')) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        // 头部被截断导致最后一行不完整 —— 正常，跳过
        continue
      }

      if (obj.type === 'session') {
        id = typeof obj.id === 'string' ? obj.id : undefined
        cwd = typeof obj.cwd === 'string' ? obj.cwd : undefined
        const ts = Date.parse(String(obj.timestamp ?? ''))
        if (!Number.isNaN(ts)) createdAt = ts
      } else if (obj.type === 'session_info') {
        // 后写的覆盖先写的（取最后一个名字）
        if (typeof obj.name === 'string' && obj.name.trim()) name = obj.name.trim()
      } else if (!title && obj.type === 'message') {
        title = titleFromMessage(obj.message) ?? undefined
      }
    }

    return { cwd, title, id, name, createdAt }
  } finally {
    await fh.close()
  }
}

/** 快速数一下 message 条数（整文件读，但只在缓存失效时发生） */
async function countMessages(path: string): Promise<number> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    if (size > 8 * 1024 * 1024) return -1 // 太大就不数了，返回 -1 表示未知
    const buf = Buffer.alloc(size)
    await fh.read(buf, 0, size, 0)
    let n = 0
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.includes('"type":"message"')) n++
    }
    return n
  } catch {
    return -1
  } finally {
    await fh.close()
  }
}

/** 列出所有会话，按更新时间倒序 */
export async function listSessions(limit = 200): Promise<SessionSummary[]> {
  if (!existsSync(SESSIONS_DIR)) return []

  const files: { path: string; mtimeMs: number; size: number }[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p, depth + 1)
      } else if (e.name.endsWith('.jsonl')) {
        try {
          const s = await stat(p)
          files.push({ path: p, mtimeMs: s.mtimeMs, size: s.size })
        } catch {
          /* 竞态：刚被删 */
        }
      }
    }
  }

  await walk(SESSIONS_DIR, 0)

  // 只处理最近的 limit 个
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const picked = files.slice(0, limit)

  const out: SessionSummary[] = []
  for (const f of picked) {
    const hit = cache.get(f.path)
    if (hit && hit.mtimeMs === f.mtimeMs) {
      out.push(hit.summary)
      continue
    }

    try {
      const head = await readHead(f.path)
      const dirName = f.path.split(/[\\/]/).slice(-2, -1)[0] ?? ''
      const named = !!head.name
      const summary: SessionSummary = {
        id: head.id ?? f.path,
        path: f.path,
        cwd: head.cwd ?? decodeDirName(dirName) ?? '',
        // 优先用用户起的名字（TUI 的 /name 也看得到同一个字段）
        title: head.name ?? head.title ?? '(无标题)',
        named,
        createdAt: head.createdAt || Math.round(f.mtimeMs),
        updatedAt: Math.round(f.mtimeMs),
        messageCount: await countMessages(f.path),
        model: undefined
      }
      cache.set(f.path, { mtimeMs: f.mtimeMs, summary })
      out.push(summary)
    } catch {
      /* 读不了就跳过这一条 */
    }
  }

  return out
}

/** 删除一份会话文件。不可逆，调用方必须先让用户确认。 */
export async function deleteSession(path: string): Promise<void> {
  // 只允许删 sessions 目录下的 .jsonl，防止路径穿越误删
  const resolved = resolve(path)
  if (!resolved.startsWith(resolve(SESSIONS_DIR))) {
    throw new Error('只能删除会话目录下的文件')
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('不是会话文件')
  }
  await rm(resolved, { force: true })
  cache.delete(resolved)
}

/** 按时间就近把会话分组，供左栏「今天/昨天/更早」用 */
export function groupSessions(list: SessionSummary[]): {
  today: SessionSummary[]
  yesterday: SessionSummary[]
  earlier: SessionSummary[]
} {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const t0 = startOfToday.getTime()
  const t1 = t0 - 24 * 60 * 60 * 1000

  const today: SessionSummary[] = []
  const yesterday: SessionSummary[] = []
  const earlier: SessionSummary[] = []

  for (const s of list) {
    if (s.updatedAt >= t0) today.push(s)
    else if (s.updatedAt >= t1) yesterday.push(s)
    else earlier.push(s)
  }
  return { today, yesterday, earlier }
}
