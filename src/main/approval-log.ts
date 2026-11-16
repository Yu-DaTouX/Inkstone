import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { approvalHeadline, isApprovalChoice, normalizeApprovalFeedback, type ApprovalAnswer, type ApprovalKind, type ApprovalReceipt, type ApprovalRequest } from '../shared/approval'
import { isSafeSessionId } from './session-id'
import { YAN_DIR } from './paths'
import { noticeNewerVersionFile } from './persisted-notice'
import { pick } from '../shared/ui-lang'

const PER_SESSION_LIMIT = 200
const TEXT_LIMIT = 200
const QUARANTINE_LIMIT = 32
const REASONS_LIMIT = 8
const KINDS: readonly ApprovalKind[] = ['permission', 'delete', 'danger', 'outside', 'consent', 'move']
const ENTRY_KEYS = new Set(['id', 'toolCallId', 'subagentId', 'kind', 'tool', 'title', 'reasons', 'choice', 'feedback', 'reviewer', 'askedAt', 'at'])
const DOCUMENT_KEYS = new Set(['version', 'sessions'])

class UnsupportedVersionError extends Error {}

function unknownFields(source: object, known: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key)))
}

interface ApprovalLogDocument {
  version: 1
  sessions: Record<string, ApprovalReceipt[]>
}

export interface ModelReviewReceiptInput {
  toolCallId: string
  subagentId?: string
  tool: string
  title: string
  reasons?: string[]
  allowed: boolean
  reason?: string
  askedAt?: number
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
  unsupported: boolean
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

function reasonList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => text(item)).filter(Boolean).slice(0, REASONS_LIMIT)
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
  const reviewer = value.reviewer === 'model' ? 'model' : undefined
  const feedback = value.choice === 'deny' || reviewer ? normalizeApprovalFeedback(value.feedback) : undefined
  const reasons = reasonList(value.reasons)
  return {
    ...unknownFields(value, ENTRY_KEYS),
    id,
    toolCallId,
    ...(subagentId ? { subagentId } : {}),
    kind,
    tool: text(value.tool, 40),
    title: text(value.title),
    ...(reasons.length > 1 ? { reasons } : {}),
    choice: value.choice,
    ...(feedback ? { feedback } : {}),
    ...(reviewer ? { reviewer } : {}),
    askedAt: time(value.askedAt) ?? at,
    at
  }
}

function sanitizeDocument(raw: unknown): ApprovalLogDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('审批记录文档结构无效')
  const doc = raw as Record<string, unknown>
  if (typeof doc.version === 'number' && Number.isInteger(doc.version) && doc.version > 1) throw new UnsupportedVersionError('Unsupported approval log version')
  if (doc.version !== 1 || !doc.sessions || typeof doc.sessions !== 'object' || Array.isArray(doc.sessions)) throw new Error('审批记录文档结构无效')
  const out: ApprovalLogDocument = { ...unknownFields(doc, DOCUMENT_KEYS), version: 1, sessions: {} }
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
    ...(request.kind === 'danger' ? { reasons: request.reasons } : {}),
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

  forget(sessionId: string | undefined | null): boolean {
    if (!isSafeSessionId(sessionId)) return false
    let doc: ApprovalLogDocument
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

  record(request: ApprovalRequest, answer: ApprovalAnswer, at = Date.now()): ApprovalLogUpdate | null {
    const entry = approvalReceiptOf(request, answer, at)
    return entry ? this.append(request.sessionId, entry) : null
  }

  recordReview(sessionId: string | undefined, review: ModelReviewReceiptInput, at = Date.now()): ApprovalLogUpdate | null {
    const entry = sanitizeEntry({
      id: randomUUID(),
      toolCallId: review.toolCallId,
      subagentId: review.subagentId,
      kind: 'danger',
      tool: review.tool,
      title: review.title,
      reasons: review.reasons,
      choice: review.allowed ? 'once' : 'deny',
      feedback: review.reason,
      reviewer: 'model',
      askedAt: review.askedAt ?? at,
      at
    })
    return entry ? this.append(sessionId, entry) : null
  }

  private append(sessionId: string | undefined, entry: ApprovalReceipt): ApprovalLogUpdate | null {
    if (!isSafeSessionId(sessionId)) return null
    const doc = this.read()
    if (this.cache?.unsupported) {
      console.warn('[approval-log] the file was written by a newer version; this receipt was not saved to avoid overwriting it')
      noticeNewerVersionFile('approval-log', pick('审批记录由更新版本的砚写入，当前版本不再写入新的审批记录，以免覆盖。请升级到最新版本。', 'The approval log was written by a newer version of Inkstone. This version stops adding approval records so it does not overwrite it. Please update.'))
      return null
    }
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
    let unsupported = false
    try {
      doc = sanitizeDocument(JSON.parse(raw))
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
      this.cache = { file, mtimeMs: info.mtimeMs, size: info.size, doc, unsupported: false }
    } catch (error) {
      this.cache = null
      console.warn('[approval-log] write failed; this receipt was not saved: ', error instanceof Error ? error.message : error)
    }
  }
}

export const approvalLog = new ApprovalLogStore()
