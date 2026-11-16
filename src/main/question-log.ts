import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { QuestionLogEntry } from '../shared/ipc'
import { isSafeSessionId } from './session-id'
import { YAN_DIR } from './paths'
import { noticeNewerVersionFile } from './persisted-notice'
import { pick } from '../shared/ui-lang'

const PER_SESSION_LIMIT = 50
const QUARANTINE_LIMIT = 32
const ENTRY_KEYS = new Set(['id', 'question', 'options', 'answer', 'cancelled', 'at'])
const DOCUMENT_KEYS = new Set(['version', 'sessions'])

class UnsupportedVersionError extends Error {}

function unknownFields(source: object, known: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key)))
}

interface CacheEntry {
  file: string
  mtimeMs: number
  size: number
  doc: QuestionLogDocument
  unsupported: boolean
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
    ...unknownFields(value, ENTRY_KEYS),
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
  if (typeof doc.version === 'number' && Number.isInteger(doc.version) && doc.version > 1) throw new UnsupportedVersionError('Unsupported question log version')
  if (doc.version !== 1 || !doc.sessions || typeof doc.sessions !== 'object' || Array.isArray(doc.sessions)) throw new Error('提问记录文档结构无效')
  const out: QuestionLogDocument = { ...unknownFields(doc, DOCUMENT_KEYS), version: 1, sessions: {} }
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

  forget(sessionId: string | undefined | null): boolean {
    if (!isSafeSessionId(sessionId)) return false
    let doc: QuestionLogDocument
    try {
      doc = this.read()
    } catch {
      return false
    }
    if (this.cache?.unsupported || !(sessionId in doc.sessions)) return false
    const sessions = { ...doc.sessions }
    delete sessions[sessionId]
    this.write({ ...doc, sessions })
    return true
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
    if (this.cache?.unsupported) {
      console.warn('[question-log] the file was written by a newer version; this record was not saved to avoid overwriting it')
      noticeNewerVersionFile('question-log', pick('提问记录由更新版本的砚写入，当前版本不再写入新的提问记录，以免覆盖。请升级到最新版本。', 'The question log was written by a newer version of Inkstone. This version stops adding question records so it does not overwrite it. Please update.'))
      return null
    }
    const list = doc.sessions[sessionId] ?? []
    const next = [...list, { ...entry, id: entry.id ?? randomUUID() }].slice(-PER_SESSION_LIMIT)
    this.write({ ...doc, sessions: { ...doc.sessions, [sessionId]: next } })
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
    let unsupported = false
    try {
      doc = sanitizeDocument(JSON.parse(text))
    } catch (error) {
      unsupported = error instanceof UnsupportedVersionError
      if (!unsupported) this.quarantine(file, stamp)
      doc = { version: 1, sessions: {} }
    }
    this.cache = { file, ...stamp, doc, unsupported }
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
      this.cache = { file: path, mtimeMs: info.mtimeMs, size: info.size, doc, unsupported: false }
    } catch (error) {
      this.cache = null
      console.warn('[question-log] 写入失败：', error instanceof Error ? error.message : error)
    }
  }
}

export const questionLog = new QuestionLogStore()
