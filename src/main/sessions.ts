import { readdir, stat, open, mkdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { sep } from 'node:path'
import { join, resolve } from 'node:path'
import type { ProjectRecord, SessionSummary } from '../shared/ipc'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { decorateSessions, getSessionLayout, normalizeLayoutPath } from './session-layout'
import { countSessionMessages, forgetSessionMessageCounts } from './session-message-count'
import { parseSubagentNotice } from '../shared/subagent-notice'
import { ArtifactStore, readSessionId } from './artifacts'
import { sessionSkillsDir } from './capabilities/acquired-skills'
import { dropSession } from './sources'
import { plainTitleText } from '../shared/title-text'

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

function userMessageText(msg: unknown, plain = false): string | null {
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

  text = plain ? plainTitleText(text) : text.replace(/\s+/g, ' ').trim()
  if (!text) return null
  text = text.replace(/<[^>]{1,40}>/g, '').trim()
  if (!text) return null

  return text
}

function titleFromMessage(msg: unknown): string | null {
  let text = userMessageText(msg, true)
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

const LIST_READ_CONCURRENCY = 8

async function readSessionSummary(f: { path: string; mtimeMs: number; size: number }): Promise<SessionSummary | undefined> {
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
      messageCount: await countSessionMessages(f.path),
      model: undefined
    }
    if (head.parentSession) {
      summary.branchOrigin = await readBranchOrigin(f.path, head.createdAt)
    }
    cache.set(f.path, { mtimeMs: f.mtimeMs, summary })
    return summary
  } catch {
    return undefined
  }
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

  const present = new Set(files.map((f) => f.path))
  for (const path of cache.keys()) if (!present.has(path)) cache.delete(path)
  forgetSessionMessageCounts(present)

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const picked = files.slice(0, limit)
  if (projects && files.length > limit) {
    const archived = new Set(
      (await getSessionLayout()).entries.flatMap((entry) => (entry.archivedAt && entry.sessionFile ? [normalizeLayoutPath(entry.sessionFile)] : []))
    )
    if (archived.size) picked.push(...files.slice(limit).filter((f) => archived.has(normalizeLayoutPath(f.path))))
  }

  const out: Array<SessionSummary | undefined> = new Array(picked.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < picked.length) {
      const index = cursor++
      const f = picked[index]
      const hit = cache.get(f.path)
      if (hit && hit.mtimeMs === f.mtimeMs) {
        out[index] = hit.summary
        continue
      }
      out[index] = await readSessionSummary(f)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(LIST_READ_CONCURRENCY, picked.length) }, () => worker())
  )

  const summaries = out.filter((item): item is SessionSummary => item !== undefined)
  return projects ? decorateSessions(summaries, projects) : summaries
}

const TRASH_DIR = join(YAN_DIR, 'trash', 'sessions')
const TRASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const TRASH_PRUNE_INTERVAL_MS = 60 * 60 * 1000
const DELETED_MAX_TOKENS = 50
const deleted = new Map<string, Array<{ from: string; to: string }>>()
let trashPrunedAt = 0
let sessionPurged: ((sessionId: string) => Promise<void>) | null = null

export function onSessionPurged(handler: (sessionId: string) => Promise<void>): void {
  sessionPurged = handler
}

function comparablePath(value: string): string {
  const normalized = process.platform === 'win32' ? value.toLowerCase() : value
  return normalized.replace(/[\\/]$/, '')
}

function isUnderSessionsDir(realFile: string, realRoot = resolve(SESSIONS_DIR)): boolean {
  const file = comparablePath(realFile)
  const root = comparablePath(realRoot)
  return file === root || file.startsWith(`${root}${sep}`)
}

export async function isSessionFileInSessionsDir(path: string): Promise<boolean> {
  if (typeof path !== 'string' || !path.trim()) return false
  try {
    const [realFile, realRoot] = await Promise.all([realpath(resolve(path)), realpath(resolve(SESSIONS_DIR))])
    return isUnderSessionsDir(realFile, realRoot) && realFile.toLowerCase().endsWith('.jsonl')
  } catch {
    return false
  }
}

async function pruneTrash(): Promise<void> {
  if (Date.now() - trashPrunedAt < TRASH_PRUNE_INTERVAL_MS) return
  trashPrunedAt = Date.now()
  let entries
  try {
    entries = await readdir(TRASH_DIR, { withFileTypes: true })
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    const target = join(TRASH_DIR, entry.name)
    try {
      const deletion = /^(\d+)-[a-z0-9]+-\d+-.+\.jsonl$/.exec(entry.name)
      if (!entry.isFile() || !deletion) continue
      const deletedAt = Number(deletion[1])
      if (!Number.isSafeInteger(deletedAt) || deletedAt <= 0 || now - deletedAt <= TRASH_MAX_AGE_MS) continue
      const sessionId = entry.isFile() && entry.name.endsWith('.jsonl') ? await readSessionId(target) : null
      await rm(target, { recursive: true, force: true })
      if (sessionId) await sessionPurged?.(sessionId).catch(() => undefined)
    } catch {
    }
  }
}

export function historySnapshotPath(sessionFile: string): string {
  return `${sessionFile}.history.txt`
}

export async function sessionsToDelete(path: string): Promise<Array<{ path: string; sessionId?: string }>> {
  const target = resolve(path)
  const id = (await listSessions(Number.MAX_SAFE_INTEGER)).find((session) => resolve(session.path) === target)?.id
  return [{ path: target, ...(id ? { sessionId: id } : {}) }]
}

export async function deleteSession(path: string, protectedPath?: string): Promise<string> {
  const resolved = resolve(path)
  const realFile = await realpath(resolved)
  const realRoot = await realpath(resolve(SESSIONS_DIR))
  if (!isUnderSessionsDir(realFile, realRoot)) {
    throw new Error('只能删除会话目录下的文件')
  }
  if (!realFile.toLowerCase().endsWith('.jsonl')) {
    throw new Error('不是会话文件')
  }
  const targets = await sessionsToDelete(resolved)
  const paths = targets.map((target) => target.path)
  if (protectedPath && paths.includes(resolve(protectedPath))) {
    throw new Error('不能删除当前正在使用的会话')
  }

  await mkdir(TRASH_DIR, { recursive: true })
  await pruneTrash()
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const entries: Array<{ from: string; to: string }> = []
  const artifacts = new ArtifactStore(join(YAN_DIR, 'artifacts'))
  for (const source of paths) await artifacts.sessionDir(source).catch(() => undefined)
  const moving = [...paths, ...paths.map(historySnapshotPath).filter((file) => existsSync(file))]
  try {
    for (const [index, source] of moving.entries()) {
      const destination = join(TRASH_DIR, `${token}-${index}-${source.split(/[\\/]/).pop()}`)
      await rename(source, destination)
      cache.delete(source)
      entries.push({ from: source, to: destination })
    }
  } catch (error) {
    const failed: string[] = []
    for (const entry of entries.reverse()) {
      try {
        await rename(entry.to, entry.from)
      } catch {
        failed.push(entry.from)
      }
    }
    if (failed.length) {
      throw new Error(`删除失败，回滚未完成：${failed.join(', ')}`, { cause: error })
    }
    throw error
  }
  for (const target of targets) {
    if (!target.sessionId) continue
    try {
      await rm(sessionSkillsDir(YAN_DIR, target.sessionId), { recursive: true, force: true })
    } catch {
    }
    dropSession(target.sessionId)
  }
  deleted.set(token, entries)
  if (deleted.size > DELETED_MAX_TOKENS) {
    const oldest = deleted.keys().next().value
    if (oldest) deleted.delete(oldest)
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
