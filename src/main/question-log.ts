import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { QuestionLogEntry } from '../shared/ipc'
import { isSafeSessionId } from './session-id'
import { YAN_DIR } from './paths'

const PER_SESSION_LIMIT = 50

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
  constructor(private readonly file: () => string = questionLogPath) {}

  list(sessionId: string | undefined | null): QuestionLogEntry[] {
    if (!isSafeSessionId(sessionId)) return []
    return this.read().sessions[sessionId] ?? []
  }

  append(
    sessionId: string | undefined | null,
    entry: Omit<QuestionLogEntry, 'id'> & { id?: string }
  ): QuestionLogEntry[] | null {
    if (!isSafeSessionId(sessionId)) return null
    const doc = this.read()
    const list = doc.sessions[sessionId] ?? []
    const next = [...list, { ...entry, id: entry.id ?? randomUUID() }].slice(-PER_SESSION_LIMIT)
    doc.sessions[sessionId] = next
    this.write(doc)
    return next
  }

  private read(): QuestionLogDocument {
    let text: string
    try { text = readFileSync(this.file(), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: {} }
      throw error
    }
    return sanitizeDocument(JSON.parse(text))
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
    } catch (error) {
      console.warn('[question-log] 写入失败：', error instanceof Error ? error.message : error)
    }
  }
}

export const questionLog = new QuestionLogStore()
