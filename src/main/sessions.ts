import { readdir, stat, open, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { sep } from 'node:path'
import { join, resolve } from 'node:path'
import type { ProjectRecord, SessionSummary } from '../shared/ipc'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { deleteContextStates } from './context-state-store'
import { decorateSessions } from './session-layout'
import { parseSubagentNotice } from '../shared/subagent-notice'

export const SESSIONS_DIR =
  process.env.YAN_SESSIONS_DIR?.trim() || join(PI_AGENT_DIR, 'sessions')

export const SESSIONS_DIR_IS_OVERRIDE = !!process.env.YAN_SESSIONS_DIR?.trim()

const HEAD_BYTES = 96 * 1024

const HOME = process.env.USERPROFILE || process.env.HOME || ''
function shortenPaths(s: string): string {
  let out = s
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

function decodeDirName(name: string): string | null {
  if (!name.startsWith('-') || !name.endsWith('-')) return null
  const inner = name.slice(1, -1)
  return inner.replace(/-/g, '\\')
}

function userMessageText(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as { role?: string; content?: unknown }
  if (m.role !== 'user') return null

  let text = ''
  if (typeof m.content === 'string') {
    text = m.content
  } else if (Array.isArray(m.content)) {
    const parts: string[] = []
    for (const part of m.content) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        const value = String((part as { text?: unknown }).text ?? '').trim()
        if (value) parts.push(value)
      }
    }
    text = parts.join('\n')
  }

  const notice = parseSubagentNotice(text.trim())
  if (notice) return notice.headline.trim() || null

  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return null
  text = text.replace(/<[^>]{1,40}>/g, '').trim()
  if (!text) return null

  return text
}

function titleFromMessage(msg: unknown): string | null {
  let text = userMessageText(msg)
  if (!text) return null

  text = shortenPaths(text)

  return text.length > 34 ? `${text.slice(0, 34)}…` : text
}

export async function readTitleSamples(path: string): Promise<string[]> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const firstLen = Math.min(size, HEAD_BYTES)
    const firstBuf = Buffer.alloc(firstLen)
    if (firstLen) await fh.read(firstBuf, 0, firstLen, 0)

    let first: string | undefined
    const readUserLines = (text: string, reverse = false): string | undefined => {
      const lines = text.split('\n')
      const order = reverse ? [...lines].reverse() : lines
      for (const line of order) {
        if (!line.includes('"type":"message"')) continue
        try {
          const obj = JSON.parse(line) as { type?: string; message?: unknown }
          if (obj.type !== 'message') continue
          const value = userMessageText(obj.message)
          if (value) return value
        } catch {
        }
      }
      return undefined
    }

    first = readUserLines(firstBuf.toString('utf8'))

    const tailStart = Math.max(0, size - HEAD_BYTES)
    const tailLen = size - tailStart
    const tailBuf = Buffer.alloc(tailLen)
    if (tailLen) await fh.read(tailBuf, 0, tailLen, tailStart)
    const last = readUserLines(tailBuf.toString('utf8'), true)

    const samples: string[] = []
    for (const value of [first, last]) {
      const sample = value?.replace(/\s+/g, ' ').trim().slice(0, 600)
      if (sample && !samples.includes(sample)) samples.push(sample)
    }
    return samples.slice(0, 2)
  } catch {
    return []
  } finally {
    await fh.close()
  }
}

async function readHead(path: string): Promise<{
  cwd?: string
  title?: string
  id?: string
  name?: string
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
        continue
      }

      if (obj.type === 'session') {
        id = typeof obj.id === 'string' ? obj.id : undefined
        cwd = typeof obj.cwd === 'string' ? obj.cwd : undefined
        parentSession = typeof obj.parentSession === 'string' ? obj.parentSession : undefined
        const ts = Date.parse(String(obj.timestamp ?? ''))
        if (!Number.isNaN(ts)) createdAt = ts
      } else if (obj.type === 'session_info') {
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

async function countMessages(path: string): Promise<number> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    if (size > 8 * 1024 * 1024) return -1
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

async function readLastActivity(path: string, size: number): Promise<{ at?: number; reply?: SessionSummary['lastReply'] }> {
  const TAIL = 64 * 1024
  const fh = await open(path, 'r')
  try {
    if (size <= 0) return {}
    let end = size
    let carry = Buffer.alloc(0)
    let at: number | undefined
    let reply: SessionSummary['lastReply']
    while (end > 0 && (at === undefined || !reply)) {
      const begin = Math.max(0, end - TAIL)
      const buf = Buffer.alloc(end - begin)
      const { bytesRead } = await fh.read(buf, 0, buf.length, begin)
      const combined = Buffer.concat([buf.subarray(0, bytesRead), carry])
      const boundary = begin > 0 ? combined.indexOf(10) : -1
      const complete = begin > 0 ? (boundary >= 0 ? combined.subarray(boundary + 1) : Buffer.alloc(0)) : combined
      carry = begin > 0 ? (boundary >= 0 ? combined.subarray(0, boundary) : combined) : Buffer.alloc(0)
      if (carry.length > 8 * 1024 * 1024) carry = Buffer.alloc(0)
      const lines = complete.toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (line.length > 8 * 1024 * 1024 || !line.includes('"type":"message"')) continue
        try {
          const o = JSON.parse(line) as { id?: string; timestamp?: string; message?: { role?: string; timestamp?: number; content?: Array<{ type?: string; text?: string }> | string } }
          const ts = Date.parse(String(o.timestamp ?? ''))
          if (at === undefined && !Number.isNaN(ts)) at = ts
          if (!reply && o.message?.role === 'assistant') {
            const content = o.message.content
            const body = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => item.text).join(' ') : ''
            const stamp = typeof o.message.timestamp === 'number' && Number.isFinite(o.message.timestamp) ? o.message.timestamp : !Number.isNaN(ts) ? ts : undefined
            if (body?.trim() && stamp && o.id) reply = { id: o.id, at: stamp, text: body.replace(/\s+/g, ' ').trim().slice(0, 180) }
          }
          if (at !== undefined && reply) break
        } catch { }
      }
      end = begin
    }
    return { at, reply }
  } catch {
    return {}
  } finally {
    await fh.close()
  }
}

export async function findSessionById(id: string, projects?: ProjectRecord[]): Promise<SessionSummary | undefined> {
  if (!id) return undefined
  const sessions = await listSessions(Number.MAX_SAFE_INTEGER, projects)
  return sessions.find((session) => session.id === id)
}

export async function listSessions(limit = 200, projects?: ProjectRecord[]): Promise<SessionSummary[]> {
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
        }
      }
    }
  }

  await walk(SESSIONS_DIR, 0)

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
      const activity = await readLastActivity(f.path, f.size)
      const summary: SessionSummary = {
        id: head.id ?? f.path,
        path: f.path,
        cwd: head.cwd ?? decodeDirName(dirName) ?? '',
        title: head.name ?? head.title ?? '(无标题)',
        named,
        parentSession: head.parentSession,
        lastActivityAt:
          activity.at ?? (head.createdAt || Math.round(f.mtimeMs)),
        lastReply: activity.reply,
        createdAt: head.createdAt || Math.round(f.mtimeMs),
        updatedAt: Math.round(f.mtimeMs),
        messageCount: await countMessages(f.path),
        model: undefined
      }
      if (head.parentSession) {
        summary.branchOrigin = await readBranchOrigin(f.path, head.createdAt)
      }
      cache.set(f.path, { mtimeMs: f.mtimeMs, summary })
      out.push(summary)
    } catch {
    }
  }

  return projects ? decorateSessions(out, projects) : out
}

const TRASH_DIR = join(YAN_DIR, 'trash', 'sessions')
const deleted = new Map<string, Array<{ from: string; to: string }>>()

export async function deleteSession(path: string, protectedPath?: string): Promise<string> {
  const resolved = resolve(path)
  const root = resolve(SESSIONS_DIR)
  const [realFile, realRoot] = await Promise.all([realpath(resolved), realpath(root)])
  const comparable = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  const filePath = comparable(realFile)
  const rootPath = comparable(realRoot).replace(/[\\/]$/, '')
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${sep}`)) {
    throw new Error('只能删除会话目录下的文件')
  }
  if (!realFile.toLowerCase().endsWith('.jsonl')) {
    throw new Error('不是会话文件')
  }
  const all = await listSessions(Number.MAX_SAFE_INTEGER)
  const byParent = new Map<string, SessionSummary[]>()
  for (const session of all) {
    if (!session.parentSession) continue
    const children = byParent.get(session.parentSession) ?? []
    children.push(session)
    byParent.set(session.parentSession, children)
  }
  const targets: Array<{ path: string; sessionId?: string }> = []
  const visited = new Set<string>()
  const visit = (candidate: string, sessionId?: string): void => {
    if (visited.has(candidate)) return
    visited.add(candidate)
    const id = sessionId ?? all.find((session) => resolve(session.path) === candidate)?.id
    targets.push({ path: candidate, ...(id ? { sessionId: id } : {}) })
    if (!id) return
    for (const child of byParent.get(id) ?? []) visit(resolve(child.path), child.id)
  }
  visit(resolved)
  const paths = targets.map((target) => target.path)
  if (protectedPath && paths.includes(resolve(protectedPath))) {
    throw new Error('当前正在使用的会话位于将删除的分支中')
  }

  const sessionIds = new Set<string>()
  for (const target of targets) {
    if (target.sessionId) {
      sessionIds.add(target.sessionId)
      continue
    }
    const head = await readHead(target.path).catch(() => null)
    if (head?.id) sessionIds.add(head.id)
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

  if (sessionIds.size) {
    await deleteContextStates([...sessionIds]).catch((error) => {
      console.warn('[context-state] 清理派生状态失败：', error instanceof Error ? error.message : error)
    })
  }
  return token
}

export async function restoreSession(token: string): Promise<void> {
  const entry = deleted.get(token)
  if (!entry) throw new Error('此删除已无法撤销')
  const restored: Array<{ from: string; to: string }> = []
  try {
    for (const item of entry) {
      await mkdir(resolve(item.from, '..'), { recursive: true })
      await rename(item.to, item.from)
      restored.push(item)
    }
    deleted.delete(token)
  } catch (error) {
    const stillDeleted = [...entry]
    let rollbackFailures = 0
    for (const item of restored.reverse()) {
      try { await rename(item.from, item.to) }
      catch {
        stillDeleted.splice(stillDeleted.indexOf(item), 1)
        rollbackFailures += 1
      }
    }
    deleted.set(token, stillDeleted)
    if (rollbackFailures) throw new Error(`恢复失败且 ${rollbackFailures} 个已恢复条目未能回滚；这些条目保留在原处，其余条目仍可重试恢复。`, { cause: error })
    throw error
  }
}
