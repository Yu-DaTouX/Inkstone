import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isApprovalChoice, normalizeApprovalFeedback, type ApprovalAnswer, type ApprovalKind, type ApprovalReceipt, type ApprovalRequest } from '../shared/approval'
import { isSafeSessionId } from './session-id'
import { YAN_DIR } from './paths'

const PER_SESSION_LIMIT = 200
const TEXT_LIMIT = 200
const KINDS: readonly ApprovalKind[] = ['permission', 'delete', 'danger', 'outside', 'consent', 'move']

interface ApprovalLogDocument {
  version: 1
  sessions: Record<string, ApprovalReceipt[]>
}

export interface ApprovalLogUpdate {
  sessionId: string
  entries: ApprovalReceipt[]
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
    title: request.title,
    choice: answer.choice,
    feedback: answer.feedback,
    askedAt: request.createdAt,
    at
  })
}

export class ApprovalLogStore {
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
    let raw: string
    try { raw = readFileSync(this.file(), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: {} }
      throw error
    }
    try {
      return sanitizeDocument(JSON.parse(raw))
    } catch {
      copyFileSync(this.file(), `${this.file()}.corrupt-${Date.now()}`)
      return { version: 1, sessions: {} }
    }
  }

  private write(doc: ApprovalLogDocument): void {
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
      console.warn('[approval-log] 写入失败：', error instanceof Error ? error.message : error)
    }
  }
}

export const approvalLog = new ApprovalLogStore()
