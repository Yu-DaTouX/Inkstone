import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { approvalHeadline, isApprovalChoice, normalizeApprovalFeedback, type ApprovalAnswer, type ApprovalKind, type ApprovalReceipt, type ApprovalRequest } from '../shared/approval'
import { isSafeSessionId } from './session-id'
import { YAN_DIR } from './paths'

const PER_SESSION_LIMIT = 200
const TEXT_LIMIT = 200
const QUARANTINE_LIMIT = 32
const KINDS: readonly ApprovalKind[] = ['permission', 'delete', 'danger', 'outside', 'consent', 'move']

interface ApprovalLogDocument {
  version: 1
  sessions: Record<string, ApprovalReceipt[]>
}

export interface ApprovalLogUpdate {
  sessionId: string
  entries: ApprovalReceipt[]
}

interface CacheEntry {
  file: string
  mtimeMs: number
  size: number
  doc: ApprovalLogDocument
}

export function approvalLogPath(): string {
  return join(YAN_DIR, 'approval-log.json')
}

function text(value: unknown, limit = TEXT_LIMIT): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function time(value: unknown): number | null {
  const at = Number(value)
  return Number.isFinite(at) && at > 0 ? Math.floor(at) : null
}

function sanitizeEntry(raw: unknown): ApprovalReceipt | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = text(value.id)
  const toolCallId = text(value.toolCallId)
  const at = time(value.at)
  const kind = KINDS.find((item) => item === value.kind)
  if (!id || !toolCallId || at === null || !kind || !isApprovalChoice(value.choice)) return null
  const subagentId = text(value.subagentId)
  const feedback = value.choice === 'deny' ? normalizeApprovalFeedback(value.feedback) : undefined
  return {
    id,
    toolCallId,
    ...(subagentId ? { subagentId } : {}),
    kind,
    tool: text(value.tool, 40),
    title: text(value.title),
    choice: value.choice,
    ...(feedback ? { feedback } : {}),
    askedAt: time(value.askedAt) ?? at,
    at
  }
}

function sanitizeDocument(raw: unknown): ApprovalLogDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('审批记录文档结构无效')
  const doc = raw as Record<string, unknown>
  if (doc.version !== 1 || !doc.sessions || typeof doc.sessions !== 'object' || Array.isArray(doc.sessions)) throw new Error('审批记录文档结构无效')
  const out: ApprovalLogDocument = { version: 1, sessions: {} }
  for (const [sessionId, list] of Object.entries(doc.sessions as Record<string, unknown>)) {
    if (!isSafeSessionId(sessionId) || !Array.isArray(list)) throw new Error('审批记录会话数据无效')
    const entries = list.map(sanitizeEntry).filter((item): item is ApprovalReceipt => item !== null)
    if (entries.length) out.sessions[sessionId] = entries.slice(-PER_SESSION_LIMIT)
  }
  return out
}

export function approvalReceiptOf(request: ApprovalRequest, answer: ApprovalAnswer, at = Date.now()): ApprovalReceipt | null {
  if (!request.toolCallId || !isApprovalChoice(answer.choice)) return null
  return sanitizeEntry({
    id: request.id,
    toolCallId: request.toolCallId,
    subagentId: request.subagentId,
    kind: request.kind,
    tool: request.tool,
    title: approvalHeadline(request),
    choice: answer.choice,
    feedback: answer.feedback,
    askedAt: request.createdAt,
    at
  })
}

export class ApprovalLogStore {
  private cache: CacheEntry | null = null
  private readonly quarantined = new Set<string>()

  constructor(private readonly file: () => string = approvalLogPath) {}

  list(sessionId: string | undefined | null): ApprovalReceipt[] {
    if (!isSafeSessionId(sessionId)) return []
    return this.read().sessions[sessionId] ?? []
  }

  record(request: ApprovalRequest, answer: ApprovalAnswer, at = Date.now()): ApprovalLogUpdate | null {
    const sessionId = request.sessionId
    if (!isSafeSessionId(sessionId)) return null
    const entry = approvalReceiptOf(request, answer, at)
    if (!entry) return null
    const doc = this.read()
    const list = (doc.sessions[sessionId] ?? []).filter((item) => item.id !== entry.id)
    const entries = [...list, entry].slice(-PER_SESSION_LIMIT)
    doc.sessions[sessionId] = entries
    this.write(doc)
    return { sessionId, entries }
  }

  private read(): ApprovalLogDocument {
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
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      this.cache = null
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: {} }
      throw error
    }
    let doc: ApprovalLogDocument
    try {
      doc = sanitizeDocument(JSON.parse(raw))
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
      console.warn('[approval-log] failed to back up the corrupt file: ', error instanceof Error ? error.message : error)
    }
  }

  private write(doc: ApprovalLogDocument): void {
    const file = this.file()
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(temp, JSON.stringify(doc), { encoding: 'utf8', flag: 'wx' })
        renameSync(temp, file)
      } catch (error) {
        rmSync(temp, { force: true })
        throw error
      }
      const info = statSync(file)
      this.cache = { file, mtimeMs: info.mtimeMs, size: info.size, doc }
    } catch (error) {
      this.cache = null
      console.warn('[approval-log] write failed; this receipt was not saved: ', error instanceof Error ? error.message : error)
    }
  }
}

export const approvalLog = new ApprovalLogStore()
