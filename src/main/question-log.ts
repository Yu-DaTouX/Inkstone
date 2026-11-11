import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { QuestionLogEntry } from '../shared/ipc'
import { isSafeSessionId } from './session-id'
import { YAN_DIR } from './paths'

const PER_SESSION_LIMIT = 50
const QUARANTINE_LIMIT = 32

interface CacheEntry {
  file: string
  mtimeMs: number
  size: number
  doc: QuestionLogDocument
}

interface QuestionLogDocument {
  version: 1
  sessions: Record<string, QuestionLogEntry[]>
}

export function questionLogPath(): string {
  return join(YAN_DIR, 'question-log.json')
}

function sanitizeEntry(raw: unknown, sessionId: string, index: number): QuestionLogEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const question = typeof value.question === 'string' ? value.question.trim() : ''
  const at = Number(value.at)
  if (!question || !Number.isFinite(at) || at <= 0) return null
  const options = Array.isArray(value.options)
    ? value.options.filter((item): item is string => typeof item === 'string')
    : []
  return {
    id: typeof value.id === 'string' && value.id ? value.id : createHash('sha256').update(`${sessionId}\0${index}\0${question}\0${at}`).digest('hex').slice(0, 32),
    question,
    options,
    answer: typeof value.answer === 'string' && value.answer.trim() ? value.answer : null,
    cancelled: value.cancelled === true,
    at: Math.floor(at)
  }
}

function sanitizeDocument(raw: unknown): QuestionLogDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('提问记录文档结构无效')
  const doc = raw as Record<string, unknown>
  if (doc.version !== 1 || !doc.sessions || typeof doc.sessions !== 'object' || Array.isArray(doc.sessions)) throw new Error('提问记录文档结构无效')
  const out: QuestionLogDocument = { version: 1, sessions: {} }
  for (const [sessionId, list] of Object.entries(doc.sessions as Record<string, unknown>)) {
    if (!isSafeSessionId(sessionId) || !Array.isArray(list)) throw new Error('提问记录会话数据无效')
    const entries = list.map((item, index) => sanitizeEntry(item, sessionId, index)).filter((item): item is QuestionLogEntry => item !== null)
    if (entries.length) out.sessions[sessionId] = entries.slice(-PER_SESSION_LIMIT)
  }
  return out
}

export class QuestionLogStore {
  private cache: CacheEntry | null = null
  private readonly quarantined = new Set<string>()

  constructor(private readonly file: () => string = questionLogPath) {}

  list(sessionId: string | undefined | null): QuestionLogEntry[] {
    if (!isSafeSessionId(sessionId)) return []
    try {
      return this.read().sessions[sessionId] ?? []
    } catch (error) {
      console.warn('[question-log] 读取失败，本次按无记录处理：', error instanceof Error ? error.message : error)
      return []
    }
  }

  append(
    sessionId: string | undefined | null,
    entry: Omit<QuestionLogEntry, 'id'> & { id?: string }
  ): QuestionLogEntry[] | null {
    if (!isSafeSessionId(sessionId)) return null
    let doc: QuestionLogDocument
    try {
      doc = this.read()
    } catch (error) {
      console.warn('[question-log] 读取失败，本条记录未保存：', error instanceof Error ? error.message : error)
      return null
    }
    const list = doc.sessions[sessionId] ?? []
    const next = [...list, { ...entry, id: entry.id ?? randomUUID() }].slice(-PER_SESSION_LIMIT)
    this.write({ version: 1, sessions: { ...doc.sessions, [sessionId]: next } })
    return next
  }

  private read(): QuestionLogDocument {
    const file = this.file()
    let stamp: { mtimeMs: number; size: number }
    try {
      const info = statSync(file)
      stamp = { mtimeMs: info.mtimeMs, size: info.size }
    } catch (error) {
      this.cache = null
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: {} }
      throw error
    }
    const cached = this.cache
    if (cached && cached.file === file && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) return cached.doc
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      this.cache = null
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: {} }
      throw error
    }
    let doc: QuestionLogDocument
    try {
      doc = sanitizeDocument(JSON.parse(text))
    } catch {
      this.quarantine(file, stamp)
      doc = { version: 1, sessions: {} }
    }
    this.cache = { file, ...stamp, doc }
    return doc
  }

  private quarantine(file: string, stamp: { mtimeMs: number; size: number }): void {
    const signature = `${file}|${stamp.mtimeMs}|${stamp.size}`
    if (this.quarantined.has(signature)) return
    this.quarantined.add(signature)
    if (this.quarantined.size > QUARANTINE_LIMIT) {
      const oldest = this.quarantined.values().next().value
      if (typeof oldest === 'string') this.quarantined.delete(oldest)
    }
    const target = `${file}.corrupt-${Math.round(stamp.mtimeMs)}-${stamp.size}`
    if (existsSync(target)) return
    try {
      copyFileSync(file, target)
    } catch (error) {
      console.warn('[question-log] 损坏文件备份失败：', error instanceof Error ? error.message : error)
    }
  }

  private write(doc: QuestionLogDocument): void {
    try {
      const path = this.file()
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(temp, JSON.stringify(doc), { encoding: 'utf8', flag: 'wx' })
        renameSync(temp, path)
      } catch (error) {
        rmSync(temp, { force: true })
        throw error
      }
      const info = statSync(path)
      this.cache = { file: path, mtimeMs: info.mtimeMs, size: info.size, doc }
    } catch (error) {
      this.cache = null
      console.warn('[question-log] 写入失败：', error instanceof Error ? error.message : error)
    }
  }
}

export const questionLog = new QuestionLogStore()
