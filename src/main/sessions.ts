/**
 * 会话索引 —— 读 ~/.pi/agent/sessions/ 给左栏用。
 *
 * ⚠️ 这是**只读**的（列表 + 标题）。真正切换会话是让 pi 自己
 * `switch_session`，我们不解析整个会话文件（格式是 version:3，会变）。
 * 只有标题/时间/条数这些"元数据"靠解析，坏了也只是列表难看，不影响功能。
 *
 * 性能：会话文件可能十几 MB。用 mtime 做缓存，且只在 head 里找标题。
 */
import { readdir, stat, open, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SessionSummary } from '../shared/ipc'
import { PI_AGENT_DIR, YAN_DIR } from './paths'

/**
 * 会话目录。
 * 默认是 pi 的标准位置；`YAN_SESSIONS_DIR` 可覆盖 ——
 * 既方便测试（不进真实目录），也方便用户把 pi 的 `--session-dir` 指到别处。
 */
export const SESSIONS_DIR =
  process.env.YAN_SESSIONS_DIR?.trim() || join(PI_AGENT_DIR, 'sessions')

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
const HOME = process.env.USERPROFILE || process.env.HOME || ''
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
  /** 分叉自哪个会话文件（session 头的 parentSession） */
  parentSession?: string
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
    let parentSession: string | undefined
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
        parentSession = typeof obj.parentSession === 'string' ? obj.parentSession : undefined
        const ts = Date.parse(String(obj.timestamp ?? ''))
        if (!Number.isNaN(ts)) createdAt = ts
      } else if (obj.type === 'session_info') {
        // 后写的覆盖先写的（取最后一个名字）
        if (typeof obj.name === 'string' && obj.name.trim()) name = obj.name.trim()
      } else if (!title && obj.type === 'message') {
        title = titleFromMessage(obj.message) ?? undefined
      }
    }

    return { cwd, title, id, name, parentSession, createdAt }
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

/**
 * 分叉自父会话的「哪句话」。
 *
 * 原理：pi 分叉时会把父会话的条目**拷到子会话开头**（保留原 id/时间戳），
 * 然后才写分叉之后的新内容；`session` 头的 timestamp 就是分叉时刻。
 * 所以只要从头扫，时间戳 < 分叉时刻的条目就是拷来的，
 * 其中最后一条用户消息就是「从这儿分出去的那句话」。
 *
 * 只读开头一段（CAP），不为一个深分叉去读整个大文件；读不到就返回 undefined，
 * 界面上顶多少一行说明，不影响功能。
 */
async function readBranchOrigin(path: string, forkTs: number): Promise<string | undefined> {
  const CAP = 2 * 1024 * 1024
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, CAP)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)

    const lines = buf.toString('utf8').split('\n')
    let origin: string | undefined
    // 第 0 行是 session 头，从第 1 行开始
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const ts = Date.parse(String(obj.timestamp ?? ''))
      if (forkTs && !Number.isNaN(ts) && ts >= forkTs) break
      if (obj.type === 'message') {
        const t = titleFromMessage(obj.message)
        if (t) origin = t
      }
    }
    return origin
  } catch {
    return undefined
  } finally {
    await fh.close()
  }
}

/**
 * 读文件**尾部**，取最后一条 message 的时间戳（= 会话真正的“最近活动”）。
 *
 * 为什么读尾部而不是全文件：会话可能十几 MB；最近活动总在最后一段。
 * 尾部窗口的第一行可能被截断 → JSON.parse 失败就往前继续找。
 */
async function readLastActivity(path: string, size: number): Promise<number | undefined> {
  const TAIL = 64 * 1024
  const start = Math.max(0, size - TAIL)
  const fh = await open(path, 'r')
  try {
    const len = size - start
    if (len <= 0) return undefined
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"type":"message"')) continue
      try {
        const o = JSON.parse(line) as { timestamp?: string }
        const ts = Date.parse(String(o.timestamp ?? ''))
        if (!Number.isNaN(ts)) return ts
      } catch {
        /* 尾部第一行可能被截断，继续往前找 */
      }
    }
    return undefined
  } catch {
    return undefined
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
        parentSession: head.parentSession,
        lastActivityAt:
          (await readLastActivity(f.path, f.size)) ?? (head.createdAt || Math.round(f.mtimeMs)),
        createdAt: head.createdAt || Math.round(f.mtimeMs),
        updatedAt: Math.round(f.mtimeMs),
        messageCount: await countMessages(f.path),
        model: undefined
      }
      // 子会话：算一下「从哪句话分出去」（给左栏显示来源用）
      if (head.parentSession) {
        summary.branchOrigin = await readBranchOrigin(f.path, head.createdAt)
      }
      cache.set(f.path, { mtimeMs: f.mtimeMs, summary })
      out.push(summary)
    } catch {
      /* 读不了就跳过这一条 */
    }
  }

  return out
}

/**
 * 会话回收站。
 *
 * 会话常常包含很长的工作记录，菜单里的“删除”不能悄悄变成不可恢复的 rm。
 * 因此先原子移动到砚自己的回收站；当前运行期内保留原路径映射供“撤销”使用。
 */
const TRASH_DIR = join(YAN_DIR, 'trash', 'sessions')
const deleted = new Map<string, Array<{ from: string; to: string }>>()

/** 将一份会话文件移入回收站，返回一次性撤销 token。 */
export async function deleteSession(path: string, protectedPath?: string): Promise<string> {
  // 只允许删 sessions 目录下的 .jsonl，防止路径穿越误删
  const resolved = resolve(path)
  if (!resolved.startsWith(resolve(SESSIONS_DIR))) {
    throw new Error('只能删除会话目录下的文件')
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('不是会话文件')
  }
  const all = await listSessions(500)
  const byParent = new Map<string, SessionSummary[]>()
  for (const session of all) {
    if (!session.parentSession) continue
    const children = byParent.get(session.parentSession) ?? []
    children.push(session)
    byParent.set(session.parentSession, children)
  }
  const paths: string[] = []
  const visited = new Set<string>()
  const visit = (candidate: string, sessionId?: string): void => {
    if (visited.has(candidate)) return
    visited.add(candidate)
    paths.push(candidate)
    const id = sessionId ?? all.find((session) => resolve(session.path) === candidate)?.id
    if (!id) return
    for (const child of byParent.get(id) ?? []) visit(resolve(child.path), child.id)
  }
  visit(resolved)
  if (protectedPath && paths.includes(resolve(protectedPath))) {
    throw new Error('当前正在使用的会话位于将删除的分支中')
  }

  await mkdir(TRASH_DIR, { recursive: true })
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const entries: Array<{ from: string; to: string }> = []
  try {
    for (const [index, source] of paths.entries()) {
      const destination = join(TRASH_DIR, `${token}-${index}-${source.split(/[\\/]/).pop()}`)
      await rename(source, destination)
      cache.delete(source)
      entries.push({ from: source, to: destination })
    }
  } catch (error) {
    for (const entry of entries.reverse()) await rename(entry.to, entry.from).catch(() => undefined)
    throw error
  }
  deleted.set(token, entries)
  return token
}

/** 撤销本次应用运行中刚刚执行的会话删除。 */
export async function restoreSession(token: string): Promise<void> {
  const entry = deleted.get(token)
  if (!entry) throw new Error('此删除已无法撤销')
  for (const item of entry) {
    await mkdir(resolve(item.from, '..'), { recursive: true })
    await rename(item.to, item.from)
  }
  deleted.delete(token)
}
